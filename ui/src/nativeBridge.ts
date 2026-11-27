import { AudioCaptureMode, AudioProcessInfo, MonitorInfo, UpdateCheckResult } from './types';

declare global {
  interface Window {
    chrome?: {
      webview?: {
        postMessage: (message: string) => void;
        addEventListener: (
          type: string,
          listener: (event: any) => void
        ) => void;
        removeEventListener: (
          type: string,
          listener: (event: any) => void
        ) => void;
      };
    };
  }
  const MediaStreamTrackGenerator: any;
}

interface PendingRequest {
  resolve: (val: any) => void;
  reject: (err: Error) => void;
}

const RING_FRAMES = 16384; // Stereo frames (L + R = 32768 float32s)
const HEADER_BYTES = 16;

const VIDEO_HEADER_BYTES = 64;
const VIDEO_SLOT_MAX_BYTES = 13_000_000;

class NativeBridge {
  private pending = new Map<string, PendingRequest>();
  private initialized = false;

  // Shared ring buffer state from C++ WASAPI Loopback
  private sharedHeader: DataView | null = null;
  private sharedSamples: Float32Array | null = null;
  private lastReadFrameCounter = 0;
  private pollTimer: number | null = null;

  // Shared double-buffer state from C++ DXGI GPU Capture
  private videoBuffer: ArrayBuffer | null = null;
  private videoHeader: DataView | null = null;
  private videoGenerator: any = null;
  private videoWriter: WritableStreamDefaultWriter<any> | null = null;
  private videoWorker: Worker | null = null;
  private videoWorkerUrl: string | null = null;
  private lastVideoSeq = 0;
  private lastVideoEmitMs = 0;
  private videoPumpBusy = false;
  private lastFrameCache: Uint8Array | null = null;
  private lastFrameMeta = { width: 0, height: 0, format: 1 };

  private audioCtx: AudioContext | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private destNode: MediaStreamAudioDestinationNode | null = null;
  private levelCallback: ((level: number) => void) | null = null;
  private statusCallback: ((msg: string) => void) | null = null;
  private fullscreenCallback: ((fs: boolean) => void) | null = null;

  public get isDesktopApp(): boolean {
    return Boolean(window.chrome?.webview);
  }

  public init() {
    if (this.initialized || !window.chrome?.webview) return;
    this.initialized = true;

    window.chrome.webview.addEventListener('message', (event: any) => {
      try {
        const msg =
          typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
        if (!msg) return;

        if (msg.requestId && this.pending.has(msg.requestId)) {
          const req = this.pending.get(msg.requestId)!;
          this.pending.delete(msg.requestId);
          if (msg.error) {
            req.reject(new Error(msg.error));
          } else {
            req.resolve(msg.data);
          }
          return;
        }

        if (msg.event === 'audio-status' && this.statusCallback) {
          this.statusCallback(msg.message || '');
        } else if (msg.event === 'fullscreen-changed' && this.fullscreenCallback) {
          this.fullscreenCallback(Boolean(msg.fullscreen));
        }
      } catch (err) {
        console.error('[NativeBridge] Erro ao ler mensagem:', err);
      }
    });

    window.chrome.webview.addEventListener(
      'sharedbufferreceived',
      (event: any) => {
        try {
          const buffer: ArrayBuffer = event.getBuffer();
          let kind = '';
          try {
            const extra =
              typeof event.additionalData === 'string'
                ? JSON.parse(event.additionalData)
                : event.additionalData;
            kind = extra?.kind || '';
          } catch {}

          if (kind === 'video' || (!kind && buffer.byteLength > 1_000_000)) {
            this.videoBuffer = buffer;
            this.videoHeader = new DataView(buffer, 0, VIDEO_HEADER_BYTES);
            this.lastVideoSeq = this.videoHeader.getUint32(0, true);
          } else {
            this.sharedHeader = new DataView(buffer, 0, HEADER_BYTES);
            this.sharedSamples = new Float32Array(
              buffer,
              HEADER_BYTES,
              RING_FRAMES * 2
            );
            this.lastReadFrameCounter = this.sharedHeader.getUint32(0, true);
          }
        } catch (err) {
          console.error('[NativeBridge] Erro ao mapear SharedBuffer:', err);
        }
      }
    );
  }

  private callHost<T = any>(cmd: string, payload: any = {}, timeoutMs = 8000): Promise<T> {
    this.init();
    if (!window.chrome?.webview) {
      return Promise.reject(
        new Error('Execução fora do aplicativo desktop MacacoLive.')
      );
    }

    const requestId = crypto.randomUUID();
    return new Promise<T>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        if (this.pending.has(requestId)) {
          this.pending.delete(requestId);
          reject(new Error(`Timeout ao executar comando nativo: ${cmd}`));
        }
      }, timeoutMs);

      this.pending.set(requestId, {
        resolve: (val) => {
          window.clearTimeout(timeout);
          resolve(val);
        },
        reject: (err) => {
          window.clearTimeout(timeout);
          reject(err);
        },
      });

      window.chrome!.webview!.postMessage(
        JSON.stringify({ cmd, requestId, payload })
      );
    });
  }

  public async listAudioApps(): Promise<{
    processes: AudioProcessInfo[];
    discordRunning: boolean;
    discordPid: number;
  }> {
    if (!this.isDesktopApp) {
      return { processes: [], discordRunning: false, discordPid: 0 };
    }
    return this.callHost('listAudioApps');
  }

  public onAudioLevel(cb: ((level: number) => void) | null) {
    this.levelCallback = cb;
  }

  public onAudioStatus(cb: ((msg: string) => void) | null) {
    this.statusCallback = cb;
  }

  public onFullscreenChanged(cb: ((fs: boolean) => void) | null) {
    this.fullscreenCallback = cb;
  }

  public async startNativeAudioTrack(
    mode: AudioCaptureMode,
    targetPid: number
  ): Promise<{ track: MediaStreamTrack | null; statusLabel: string }> {
    await this.stopNativeAudioTrack();
    if (mode === 'none' || !this.isDesktopApp) {
      return { track: null, statusLabel: 'Sem som' };
    }

    if (!this.audioCtx || this.audioCtx.state === 'closed') {
      this.audioCtx = new AudioContext({
        sampleRate: 48000,
        latencyHint: 'interactive',
      });
      await this.audioCtx.audioWorklet.addModule('./pcm-worklet.js');
    }

    if (this.audioCtx.state === 'suspended') {
      await this.audioCtx.resume();
    }

    this.workletNode = new AudioWorkletNode(
      this.audioCtx,
      'macaco-pcm-processor',
      {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [2],
      }
    );

    this.destNode = this.audioCtx.createMediaStreamDestination();
    this.destNode.channelCount = 2;
    this.workletNode.connect(this.destNode);

    // Keep WebAudio graph actively pulled at 48kHz even when tab/window is occluded
    const silentKeeper = this.audioCtx.createGain();
    silentKeeper.gain.value = 0;
    this.workletNode.connect(silentKeeper);
    silentKeeper.connect(this.audioCtx.destination);

    // Ensure SharedBuffer is mapped even if NavigationCompleted fired before module script loaded
    if (!this.sharedHeader) {
      await this.callHost('requestSharedBuffer');
      await new Promise((r) => window.setTimeout(r, 40));
    }

    const res = await this.callHost<{ activeMode: string; label: string }>(
      'startAudioCapture',
      { mode, targetPid }
    );

    if (this.sharedHeader) {
      this.lastReadFrameCounter = this.sharedHeader.getUint32(0, true);
    }

    this.pollTimer = window.setInterval(() => {
      this.pumpSharedAudio();
    }, 8);

    const audioTrack = this.destNode.stream.getAudioTracks()[0] || null;
    return { track: audioTrack, statusLabel: res.label };
  }

  private pumpSharedAudio() {
    if (!this.sharedHeader || !this.sharedSamples || !this.workletNode) return;

    const currentCounter = this.sharedHeader.getUint32(0, true);
    let deltaFrames = (currentCounter - this.lastReadFrameCounter) >>> 0;
    if (deltaFrames === 0) return;

    // If main thread paused unexpectedly for >300ms, jump forward cleanly
    if (deltaFrames > RING_FRAMES) {
      this.lastReadFrameCounter = (currentCounter - 1024) >>> 0;
      deltaFrames = 1024;
    }

    const out = new Float32Array(deltaFrames * 2);
    let peak = 0;
    let ringIdx = this.lastReadFrameCounter % RING_FRAMES;

    for (let i = 0; i < deltaFrames; i++) {
      const l = this.sharedSamples[ringIdx * 2];
      const r = this.sharedSamples[ringIdx * 2 + 1];
      out[i * 2] = l;
      out[i * 2 + 1] = r;

      const absL = l < 0 ? -l : l;
      const absR = r < 0 ? -r : r;
      if (absL > peak) peak = absL;
      if (absR > peak) peak = absR;

      ringIdx++;
      if (ringIdx >= RING_FRAMES) ringIdx = 0;
    }

    this.lastReadFrameCounter = currentCounter;
    this.workletNode.port.postMessage(out, [out.buffer]);

    if (this.levelCallback) {
      const pct = Math.min(100, Math.round(Math.sqrt(peak) * 100));
      this.levelCallback(pct);
    }
  }

  public async stopNativeAudioTrack(): Promise<void> {
    if (this.pollTimer !== null) {
      window.clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    if (this.workletNode) {
      try {
        this.workletNode.disconnect();
      } catch {}
      this.workletNode = null;
    }

    if (this.destNode) {
      try {
        this.destNode.stream.getTracks().forEach((t) => t.stop());
      } catch {}
      this.destNode = null;
    }

    if (this.levelCallback) {
      this.levelCallback(0);
    }

    if (this.isDesktopApp) {
      try {
        await this.callHost('stopAudioCapture');
      } catch {}
    }
  }

  public async setStreamingBoost(active: boolean): Promise<void> {
    if (!this.isDesktopApp) return;
    try {
      await this.callHost('setStreamingBoost', { active }, 3000);
    } catch {}
  }

  public async checkUpdate(): Promise<UpdateCheckResult | null> {
    if (!this.isDesktopApp) return null;
    try {
      return await this.callHost<UpdateCheckResult>('checkUpdate', {}, 12000);
    } catch {
      return null;
    }
  }

  public async installUpdate(url: string): Promise<{ restarting: boolean }> {
    return this.callHost<{ restarting: boolean }>('installUpdate', { url }, 45000);
  }

  public async listMonitors(): Promise<MonitorInfo[]> {
    if (!this.isDesktopApp) return [];
    const res = await this.callHost<{ monitors: MonitorInfo[] }>('listMonitors');
    return res?.monitors || [];
  }

  public get supportsNativeDxgiTrack(): boolean {
    return (
      this.isDesktopApp &&
      typeof MediaStreamTrackGenerator !== 'undefined' &&
      typeof VideoFrame !== 'undefined'
    );
  }

  public async startNativeDxgiVideoTrack(
    monitorIndex: number,
    maxWidth: number,
    maxHeight: number,
    fps: number
  ): Promise<MediaStreamTrack> {
    await this.stopNativeDxgiVideoTrack();
    if (!this.supportsNativeDxgiTrack) {
      throw new Error('Captura DXGI direta indisponível neste navegador.');
    }

    if (!this.videoBuffer || !this.videoHeader) {
      await this.callHost('requestSharedBuffer');
      await new Promise((r) => window.setTimeout(r, 40));
    }
    if (!this.videoBuffer || !this.videoHeader) {
      throw new Error('SharedBuffer de vídeo não mapeado.');
    }

    await this.callHost('startDxgiCapture', {
      monitorIndex,
      maxWidth,
      maxHeight,
      fps,
    });

    this.lastVideoSeq = 0;
    this.lastVideoEmitMs = 0;
    this.lastFrameCache = null;

    const generator = new MediaStreamTrackGenerator({ kind: 'video' });
    this.videoGenerator = generator;
    this.videoWriter = generator.writable.getWriter();

    const intervalMs = Math.max(8, Math.floor(1000 / Math.max(15, fps)));
    const workerCode = `let t = setInterval(() => postMessage(0), ${intervalMs}); onmessage = (e) => { if (e.data === 'stop') { clearInterval(t); close(); } else if (typeof e.data === 'number') { clearInterval(t); t = setInterval(() => postMessage(0), e.data); } };`;
    const blob = new Blob([workerCode], { type: 'application/javascript' });
    this.videoWorkerUrl = URL.createObjectURL(blob);
    this.videoWorker = new Worker(this.videoWorkerUrl);
    this.videoWorker.onmessage = () => {
      void this.pumpSharedVideo();
    };

    return generator as MediaStreamTrack;
  }

  public async updateNativeDxgiVideo(
    maxWidth: number,
    maxHeight: number,
    fps: number
  ): Promise<void> {
    if (!this.isDesktopApp || !this.videoGenerator) return;
    await this.callHost('updateDxgiCapture', { maxWidth, maxHeight, fps });
    if (this.videoWorker) {
      const intervalMs = Math.max(8, Math.floor(1000 / Math.max(15, fps)));
      this.videoWorker.postMessage(intervalMs);
    }
  }

  private async pumpSharedVideo() {
    if (
      this.videoPumpBusy ||
      !this.videoBuffer ||
      !this.videoHeader ||
      !this.videoWriter
    ) {
      return;
    }

    // Backpressure guard so frames never pile up when encoder is busy
    if (
      this.videoWriter.desiredSize !== null &&
      this.videoWriter.desiredSize <= 0
    ) {
      return;
    }

    const seq = this.videoHeader.getUint32(0, true);
    const now = performance.now();
    const hasNewFrame = seq !== 0 && seq !== this.lastVideoSeq;
    const needsKeepalive =
      !hasNewFrame &&
      this.lastFrameCache !== null &&
      now - this.lastVideoEmitMs >= 200;

    if (!hasNewFrame && !needsKeepalive) return;

    this.videoPumpBusy = true;
    let frameObj: any = null;
    try {
      let bytesToSend: Uint8Array | null = null;
      let width = 0;
      let height = 0;
      let format = 1;

      if (hasNewFrame) {
        const activeSlot = this.videoHeader.getUint32(4, true) & 1;
        width = this.videoHeader.getUint32(8, true);
        height = this.videoHeader.getUint32(12, true);
        const byteSize = this.videoHeader.getUint32(20, true);
        format = this.videoHeader.getUint32(24, true);

        if (
          width > 0 &&
          height > 0 &&
          byteSize > 0 &&
          byteSize <= VIDEO_SLOT_MAX_BYTES
        ) {
          const offset = VIDEO_HEADER_BYTES + activeSlot * VIDEO_SLOT_MAX_BYTES;
          const srcView = new Uint8Array(this.videoBuffer, offset, byteSize);
          bytesToSend = new Uint8Array(byteSize);
          bytesToSend.set(srcView);
          this.lastVideoSeq = seq;
          this.lastFrameCache = bytesToSend;
          this.lastFrameMeta = { width, height, format };
        }
      } else if (this.lastFrameCache) {
        bytesToSend = this.lastFrameCache;
        width = this.lastFrameMeta.width;
        height = this.lastFrameMeta.height;
        format = this.lastFrameMeta.format;
      }

      if (bytesToSend && width > 0 && height > 0) {
        frameObj = new VideoFrame(bytesToSend, {
          format: format === 1 ? 'NV12' : 'BGRA',
          codedWidth: width,
          codedHeight: height,
          timestamp: Math.round(now * 1000),
        });
        this.lastVideoEmitMs = now;
        await this.videoWriter.write(frameObj);
      }
    } catch {
      // Ignore single-frame write race during teardown
    } finally {
      if (frameObj) {
        try {
          frameObj.close();
        } catch {}
      }
      this.videoPumpBusy = false;
    }
  }

  public async stopNativeDxgiVideoTrack(): Promise<void> {
    if (this.videoWorker) {
      try {
        this.videoWorker.postMessage('stop');
        this.videoWorker.terminate();
      } catch {}
      this.videoWorker = null;
    }
    if (this.videoWorkerUrl) {
      try {
        URL.revokeObjectURL(this.videoWorkerUrl);
      } catch {}
      this.videoWorkerUrl = null;
    }
    if (this.videoWriter) {
      try {
        await this.videoWriter.close();
      } catch {}
      this.videoWriter = null;
    }
    if (this.videoGenerator) {
      try {
        this.videoGenerator.stop();
      } catch {}
      this.videoGenerator = null;
    }
    this.lastFrameCache = null;
    if (this.isDesktopApp) {
      try {
        await this.callHost('stopDxgiCapture');
      } catch {}
    }
  }

  public async setFullscreen(fullscreen: boolean): Promise<void> {
    if (this.isDesktopApp) {
      try {
        await this.callHost('setFullscreen', { fullscreen });
        return;
      } catch {}
    }
    if (fullscreen && document.documentElement.requestFullscreen) {
      await document.documentElement.requestFullscreen();
    } else if (!fullscreen && document.fullscreenElement) {
      await document.exitFullscreen();
    }
  }
}

export const nativeBridge = new NativeBridge();
