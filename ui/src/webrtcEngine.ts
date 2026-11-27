import { nativeBridge } from './nativeBridge';
import { ServerlessRoomSignaling } from './signaling';
import {
  PeerInfo,
  ResolutionPreset,
  SignalEnvelope,
  StreamQualityConfig,
  StreamStats,
} from './types';

const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.cloudflare.com:3478' },
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

function getResolutionDimensions(preset: ResolutionPreset): {
  width?: number;
  height?: number;
} {
  switch (preset) {
    case '720p':
      return { width: 1280, height: 720 };
    case '1080p':
      return { width: 1920, height: 1080 };
    case '1440p':
      return { width: 2560, height: 1440 };
    case 'native':
    default:
      return {};
  }
}

/**
 * Forces Opus Stereo 192kbps CBR + high start/min video bitrate so fast motion (games) never drops to potato quality.
 */
function enhanceSdpForCinema(sdp: string, bitrateMbps: number): string {
  const lines = sdp.split('\r\n');
  let opusPayloadType: string | null = null;
  const videoPayloads = new Set<string>();

  let inVideoSection = false;
  for (const line of lines) {
    if (line.startsWith('m=video ')) {
      inVideoSection = true;
      const parts = line.split(' ').slice(3);
      for (const pt of parts) videoPayloads.add(pt);
    } else if (line.startsWith('m=')) {
      inVideoSection = false;
    }

    const opusMatch = line.match(/^a=rtpmap:(\d+)\s+opus\/48000\/2/i);
    if (opusMatch) {
      opusPayloadType = opusMatch[1];
    }
    if (inVideoSection && line.startsWith('a=rtpmap:')) {
      const m = line.match(/^a=rtpmap:(\d+)\s+(H264|VP9|VP8|AV1)\//i);
      if (m) videoPayloads.add(m[1]);
    }
  }

  const maxKbps = Math.max(2000, Math.round(bitrateMbps * 1000));
  const startKbps = Math.min(maxKbps, Math.max(3000, Math.round(maxKbps * 0.65)));
  const minKbps = Math.min(startKbps, Math.max(2000, Math.round(maxKbps * 0.35)));

  const updated: string[] = [];
  let foundOpusFmtp = false;

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];

    if (opusPayloadType && line.startsWith(`a=fmtp:${opusPayloadType} `)) {
      foundOpusFmtp = true;
      const base = line
        .replace(/;?\s*stereo=\d/g, '')
        .replace(/;?\s*sprop-stereo=\d/g, '')
        .replace(/;?\s*maxaveragebitrate=\d+/g, '')
        .replace(/;?\s*cbr=\d/g, '');
      line = `${base};stereo=1;sprop-stereo=1;maxaveragebitrate=192000;cbr=1;useinbandfec=1`;
    } else if (line.startsWith('a=fmtp:')) {
      const m = line.match(/^a=fmtp:(\d+)\s+(.*)$/);
      if (m && videoPayloads.has(m[1])) {
        const clean = m[2]
          .replace(/;?\s*x-google-(?:min|start|max)-bitrate=\d+/g, '')
          .replace(/^;\s*/, '');
        line = `a=fmtp:${m[1]} ${clean};x-google-min-bitrate=${minKbps};x-google-start-bitrate=${startKbps};x-google-max-bitrate=${maxKbps}`;
      }
    }

    updated.push(line);

    // Inject b=AS right after c=IN inside m=video section
    if (line.startsWith('c=IN ') && updated.some((l) => l.startsWith('m=video '))) {
      // Only add if the most recent m= line is m=video
      for (let j = updated.length - 1; j >= 0; j--) {
        if (updated[j].startsWith('m=')) {
          if (updated[j].startsWith('m=video ')) {
            updated.push(`b=AS:${maxKbps}`);
          }
          break;
        }
      }
    }
  }

  if (opusPayloadType && !foundOpusFmtp) {
    const rtpmapIdx = updated.findIndex((l) =>
      l.startsWith(`a=rtpmap:${opusPayloadType} `)
    );
    if (rtpmapIdx >= 0) {
      updated.splice(
        rtpmapIdx + 1,
        0,
        `a=fmtp:${opusPayloadType} minptime=10;stereo=1;sprop-stereo=1;maxaveragebitrate=192000;cbr=1;useinbandfec=1`
      );
    }
  }

  return updated.join('\r\n');
}

function preferHardwareVideoCodecs(pc: RTCPeerConnection) {
  try {
    if (!('getCapabilities' in RTCRtpSender)) return;
    const caps = RTCRtpSender.getCapabilities('video');
    if (!caps || !caps.codecs) return;

    // Prioritize hardware H264 (NVENC/AMF/QSV) with packetization-mode=1 first, then VP9/AV1
    const sorted = [...caps.codecs].sort((a, b) => {
      const rank = (c: RTCRtpCodec) => {
        const m = c.mimeType.toLowerCase();
        const fmtp = (c.sdpFmtpLine || '').toLowerCase();
        if (m === 'video/h264') {
          if (fmtp.includes('packetization-mode=1') && (fmtp.includes('42e0') || fmtp.includes('4d00') || fmtp.includes('6400'))) {
            return 0;
          }
          return 1;
        }
        if (m === 'video/vp9') return 2;
        if (m === 'video/av1') return 3;
        return 4;
      };
      return rank(a) - rank(b);
    });

    for (const transceiver of pc.getTransceivers()) {
      if (
        transceiver.sender.track?.kind === 'video' ||
        transceiver.receiver.track?.kind === 'video'
      ) {
        if (typeof transceiver.setCodecPreferences === 'function') {
          transceiver.setCodecPreferences(sorted);
        }
      }
    }
  } catch {}
}

export interface EngineCallbacks {
  onPeersUpdated: (peers: PeerInfo[]) => void;
  onRemoteStream: (
    streamerId: string,
    stream: MediaStream | null,
    providerId: string
  ) => void;
  onLocalStreamChanged: (
    stream: MediaStream | null,
    audioStatus: string
  ) => void;
  onStatsUpdated: (stats: StreamStats | null) => void;
  onWatchTargetChanged: (streamerId: string | null) => void;
  onBrokerStatus: (connectedCount: number) => void;
  onReaction: (fromNick: string, emoji: string) => void;
}

export class MacacoWebRtcEngine {
  private signaling: ServerlessRoomSignaling;
  private nickname = '';
  private peers = new Map<string, PeerInfo>();

  // Outgoing connections (either our own screen stream or cascaded stream we relay to friends)
  private outboundPcs = new Map<string, RTCPeerConnection>();
  // Incoming connection watching an active streamer
  private inboundPc: RTCPeerConnection | null = null;
  private watchingStreamerId: string | null = null;
  private inboundProviderId: string | null = null;
  private receivedStream: MediaStream | null = null;

  private localStream: MediaStream | null = null;
  private rawDisplayStream: MediaStream | null = null;
  private localVideoTrack: MediaStreamTrack | null = null;
  private localAudioTrack: MediaStreamTrack | null = null;
  private isLeaving = false;
  private quality: StreamQualityConfig;

  // Direct viewers connected to us as primary streamer (used for optional cascade load-balancing)
  private directChildren = new Set<string>();

  private announceTimer: number | null = null;
  private statsTimer: number | null = null;
  private prevBytes = 0;
  private prevStatsTs = 0;

  private callbacks: EngineCallbacks;

  constructor(callbacks: EngineCallbacks, initialQuality: StreamQualityConfig) {
    this.callbacks = callbacks;
    this.quality = initialQuality;
    this.signaling = new ServerlessRoomSignaling();
    this.signaling.onBrokerStatus((count) => callbacks.onBrokerStatus(count));
    this.signaling.onMessage((env) => void this.handleSignal(env));
  }

  public get selfId(): string {
    return this.signaling.selfId;
  }

  public get isStreaming(): boolean {
    return Boolean(this.localStream);
  }

  public async joinRoom(
    nickname: string,
    roomCode: string,
    password: string
  ): Promise<void> {
    this.nickname = nickname.trim() || 'Macaco';
    await this.signaling.connect(roomCode, password);
    await this.broadcastPresence('announce');

    this.announceTimer = window.setInterval(() => {
      void this.broadcastPresence('announce');
      this.pruneStalePeers();
    }, 5000);

    this.statsTimer = window.setInterval(() => {
      void this.collectStats();
    }, 1000);
  }

  public async leaveRoom(): Promise<void> {
    this.isLeaving = true;
    if (this.announceTimer !== null) {
      window.clearInterval(this.announceTimer);
      this.announceTimer = null;
    }
    if (this.statsTimer !== null) {
      window.clearInterval(this.statsTimer);
      this.statsTimer = null;
    }

    // Notify peers immediately before tearing down signaling so viewers stop waiting right away
    try {
      await this.signaling.send('*', 'bye', {});
    } catch {}

    await this.stopScreenShare(false);
    this.stopWatching();

    this.signaling.disconnect();
    this.peers.clear();
    this.callbacks.onPeersUpdated([]);
    this.callbacks.onStatsUpdated(null);
  }

  public async sendReaction(emoji: string): Promise<void> {
    await this.signaling.send('*', 'reaction', {
      nickname: this.nickname,
      emoji,
    });
  }

  private async broadcastPresence(type: 'announce' | 'welcome', to = '*') {
    await this.signaling.send(to, type, {
      nickname: this.nickname,
      isStreaming: Boolean(this.localStream),
      cascadeRelay: this.quality.cascadeRelay,
      viewerCount: this.outboundPcs.size,
      streamLabel: this.localVideoTrack?.label || '',
    });
  }

  private pruneStalePeers() {
    const now = Date.now();
    let changed = false;
    for (const [id, peer] of this.peers.entries()) {
      if (now - peer.lastSeen > 16000) {
        this.peers.delete(id);
        this.closeOutboundPeer(id);
        if (this.watchingStreamerId === id || this.inboundProviderId === id) {
          if (this.watchingStreamerId && this.watchingStreamerId !== id) {
            // Relay friend left! Re-request stream seamlessly from main host
            const targetStreamer = this.watchingStreamerId;
            this.stopWatching();
            void this.watchStreamer(targetStreamer);
          } else {
            this.stopWatching();
          }
        }
        changed = true;
      }
    }
    if (changed) {
      this.emitPeers();
    }
  }

  private emitPeers() {
    const list = Array.from(this.peers.values()).sort((a, b) =>
      a.nickname.localeCompare(b.nickname)
    );
    this.callbacks.onPeersUpdated(list);
  }

  public async startScreenShare(config: StreamQualityConfig): Promise<void> {
    this.isLeaving = false;
    this.quality = config;
    this.stopWatching();
    await this.stopScreenShare(false);

    const dims = getResolutionDimensions(config.resolution);
    const useBrowserSystemAudio =
      !nativeBridge.isDesktopApp && config.audioMode !== 'none';

    let displayStream: MediaStream | null = null;
    let videoTrack: MediaStreamTrack | null = null;
    let usingDxgi = false;

    if (
      config.captureSource === 'dxgi-monitor' &&
      nativeBridge.supportsNativeDxgiTrack
    ) {
      try {
        videoTrack = await nativeBridge.startNativeDxgiVideoTrack(
          config.monitorIndex,
          dims.width || 0,
          dims.height || 0,
          config.fps
        );
        usingDxgi = true;
      } catch {
        // Fallback to standard picker if DXGI fails on a specific driver
        usingDxgi = false;
      }
    }

    if (!videoTrack) {
      displayStream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          // Use ideal (not strict max) so Chromium avoids extra CPU downscale/frame drops in heavy games
          ...(dims.width ? { width: { ideal: dims.width } } : {}),
          ...(dims.height ? { height: { ideal: dims.height } } : {}),
          frameRate: { ideal: config.fps },
          // @ts-ignore - Hint monitor capture first for fullscreen games
          displaySurface: config.profile === 'cinema' ? 'monitor' : undefined,
        },
        audio: useBrowserSystemAudio
          ? {
              echoCancellation: false,
              noiseSuppression: false,
              autoGainControl: false,
              channelCount: 2,
              sampleRate: 48000,
            }
          : false,
      });

      // If user left the room while picker dialog was open, immediately release capture
      if (this.isLeaving) {
        displayStream.getTracks().forEach((t) => t.stop());
        return;
      }

      this.rawDisplayStream = displayStream;
      videoTrack = displayStream.getVideoTracks()[0] || null;
    }

    if (this.isLeaving) {
      if (displayStream) displayStream.getTracks().forEach((t) => t.stop());
      if (usingDxgi) await nativeBridge.stopNativeDxgiVideoTrack();
      this.rawDisplayStream = null;
      return;
    }

    if (!videoTrack) {
      if (displayStream) displayStream.getTracks().forEach((t) => t.stop());
      this.rawDisplayStream = null;
      throw new Error('Nenhuma tela ou janela foi selecionada.');
    }

    videoTrack.contentHint = config.profile === 'cinema' ? 'motion' : 'detail';
    videoTrack.onended = () => {
      void this.stopScreenShare(true);
    };

    if (nativeBridge.isDesktopApp) {
      void nativeBridge.setStreamingBoost(true);
    }

    let audioTrack: MediaStreamTrack | null =
      displayStream?.getAudioTracks()[0] || null;
    let audioStatus = audioTrack ? 'Som do sistema' : 'Sem som';

    if (nativeBridge.isDesktopApp && config.audioMode !== 'none') {
      try {
        const res = await nativeBridge.startNativeAudioTrack(
          config.audioMode,
          config.targetPid
        );
        audioTrack = res.track;
        audioStatus = res.statusLabel;
      } catch (err: any) {
        audioStatus = `Som indisponível: ${err?.message || 'o Windows não liberou a captura'}`;
      }
    }

    // Re-check in case user exited while audio capture was starting
    if (this.isLeaving) {
      if (displayStream) displayStream.getTracks().forEach((t) => t.stop());
      if (usingDxgi) await nativeBridge.stopNativeDxgiVideoTrack();
      if (audioTrack) audioTrack.stop();
      this.rawDisplayStream = null;
      await nativeBridge.stopNativeAudioTrack();
      if (nativeBridge.isDesktopApp) void nativeBridge.setStreamingBoost(false);
      return;
    }

    const combinedTracks: MediaStreamTrack[] = [videoTrack];
    if (audioTrack) combinedTracks.push(audioTrack);

    this.localVideoTrack = videoTrack;
    this.localAudioTrack = audioTrack;
    this.localStream = new MediaStream(combinedTracks);

    this.callbacks.onLocalStreamChanged(this.localStream, audioStatus);
    await this.broadcastPresence('announce');
  }

  public async updateLiveQuality(config: StreamQualityConfig): Promise<string> {
    const audioChanged =
      config.audioMode !== this.quality.audioMode ||
      config.targetPid !== this.quality.targetPid;
    this.quality = config;

    let audioStatus = '';

    if (this.localVideoTrack) {
      this.localVideoTrack.contentHint =
        config.profile === 'cinema' ? 'motion' : 'detail';
      const dims = getResolutionDimensions(config.resolution);
      if (
        config.captureSource === 'dxgi-monitor' &&
        nativeBridge.supportsNativeDxgiTrack &&
        !this.rawDisplayStream
      ) {
        try {
          await nativeBridge.updateNativeDxgiVideo(
            dims.width || 0,
            dims.height || 0,
            config.fps
          );
        } catch {}
      } else {
        try {
          await this.localVideoTrack.applyConstraints({
            ...(dims.width ? { width: { ideal: dims.width } } : {}),
            ...(dims.height ? { height: { ideal: dims.height } } : {}),
            frameRate: { ideal: config.fps },
          });
        } catch {}
      }
    }

    if (audioChanged && this.localStream && nativeBridge.isDesktopApp) {
      if (this.localAudioTrack) {
        this.localStream.removeTrack(this.localAudioTrack);
      }
      const res = await nativeBridge.startNativeAudioTrack(
        config.audioMode,
        config.targetPid
      );
      this.localAudioTrack = res.track;
      audioStatus = res.statusLabel;
      if (res.track) {
        this.localStream.addTrack(res.track);
      }
      for (const pc of this.outboundPcs.values()) {
        const audioSender = pc
          .getSenders()
          .find((s) => s.track?.kind === 'audio' || !s.track);
        if (audioSender && res.track) {
          await audioSender.replaceTrack(res.track);
        }
      }
    }

    for (const pc of this.outboundPcs.values()) {
      await this.applySenderEncodingParams(pc);
    }

    await this.broadcastPresence('announce');
    return audioStatus;
  }

  public async stopScreenShare(announce = true): Promise<void> {
    // 1. Synchronously stop ALL media capture tracks FIRST before any async IPC
    //    so leaving the room can NEVER leave screen capture running in background!
    const tracksToStop = new Set<MediaStreamTrack>();
    if (this.localVideoTrack) {
      this.localVideoTrack.onended = null;
      tracksToStop.add(this.localVideoTrack);
    }
    if (this.localAudioTrack) {
      tracksToStop.add(this.localAudioTrack);
    }
    if (this.localStream) {
      this.localStream.getTracks().forEach((t) => tracksToStop.add(t));
    }
    if (this.rawDisplayStream) {
      this.rawDisplayStream.getTracks().forEach((t) => tracksToStop.add(t));
    }

    this.localVideoTrack = null;
    this.localAudioTrack = null;
    this.localStream = null;
    this.rawDisplayStream = null;

    for (const pc of this.outboundPcs.values()) {
      try {
        for (const sender of pc.getSenders()) {
          if (sender.track) tracksToStop.add(sender.track);
        }
      } catch {}
    }

    for (const peerId of Array.from(this.outboundPcs.keys())) {
      this.closeOutboundPeer(peerId);
    }
    this.directChildren.clear();

    for (const track of tracksToStop) {
      try {
        track.enabled = false;
        track.stop();
      } catch {}
    }

    this.callbacks.onLocalStreamChanged(null, '');

    // 2. Stop native DXGI video + WASAPI audio capture and reset process priority boost
    try {
      await nativeBridge.stopNativeDxgiVideoTrack();
    } catch {}
    try {
      await nativeBridge.stopNativeAudioTrack();
    } catch {}
    if (nativeBridge.isDesktopApp) {
      void nativeBridge.setStreamingBoost(false);
    }

    if (announce && !this.isLeaving) {
      try {
        await this.broadcastPresence('announce');
      } catch {}
    }
  }

  public async watchStreamer(streamerId: string): Promise<void> {
    if (streamerId === this.selfId) return;
    this.stopWatching();
    this.watchingStreamerId = streamerId;
    this.callbacks.onWatchTargetChanged(streamerId);
    await this.signaling.send(streamerId, 'watch-request', {
      streamerId,
    });
  }

  public stopWatching(): void {
    if (this.inboundPc) {
      try {
        this.inboundPc.close();
      } catch {}
      this.inboundPc = null;
    }

    // If we were relaying someone else's stream to friends, close outbound relays cleanly
    if (!this.localStream) {
      for (const id of Array.from(this.outboundPcs.keys())) {
        this.closeOutboundPeer(id);
      }
    }

    const prevStreamer = this.watchingStreamerId;
    this.watchingStreamerId = null;
    this.callbacks.onWatchTargetChanged(null);
    this.inboundProviderId = null;
    this.receivedStream = null;
    if (prevStreamer) {
      this.callbacks.onRemoteStream(prevStreamer, null, '');
    }
    this.callbacks.onStatsUpdated(null);
  }

  private closeOutboundPeer(peerId: string) {
    const pc = this.outboundPcs.get(peerId);
    if (pc) {
      try {
        pc.close();
      } catch {}
      this.outboundPcs.delete(peerId);
    }
    this.directChildren.delete(peerId);
  }

  private async applySenderEncodingParams(pc: RTCPeerConnection) {
    for (const sender of pc.getSenders()) {
      if (sender.track?.kind === 'video') {
        try {
          const params = sender.getParameters();
          if (!params.encodings || params.encodings.length === 0) {
            params.encodings = [{}];
          }
          params.encodings[0].maxBitrate =
            Math.round(this.quality.bitrateMbps * 1_000_000);
          params.encodings[0].maxFramerate = this.quality.fps;
          params.encodings[0].scaleResolutionDownBy = 1.0;
          // @ts-ignore - Chromium priority hint
          params.encodings[0].priority = 'high';
          // @ts-ignore - Chromium DSCP network priority
          params.encodings[0].networkPriority = 'high';
          params.degradationPreference =
            this.quality.profile === 'cinema'
              ? 'maintain-framerate'
              : 'maintain-resolution';
          await sender.setParameters(params);
        } catch {}
      } else if (sender.track?.kind === 'audio') {
        try {
          const params = sender.getParameters();
          if (!params.encodings || params.encodings.length === 0) {
            params.encodings = [{}];
          }
          params.encodings[0].maxBitrate = 192000;
          // @ts-ignore
          params.encodings[0].priority = 'high';
          await sender.setParameters(params);
        } catch {}
      }
    }
  }

  private async createOutboundConnection(
    viewerId: string,
    sourceStream: MediaStream,
    streamerOriginId: string
  ) {
    this.closeOutboundPeer(viewerId);

    const pc = new RTCPeerConnection({
      iceServers: ICE_SERVERS,
      bundlePolicy: 'max-bundle',
    });

    this.outboundPcs.set(viewerId, pc);

    for (const track of sourceStream.getTracks()) {
      pc.addTrack(track, sourceStream);
    }

    preferHardwareVideoCodecs(pc);
    await this.applySenderEncodingParams(pc);

    pc.onicecandidate = (ev) => {
      if (ev.candidate) {
        void this.signaling.send(viewerId, 'ice', {
          role: 'provider',
          candidate: ev.candidate.toJSON(),
        });
      }
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') {
        try {
          pc.restartIce();
        } catch {}
      } else if (pc.connectionState === 'closed') {
        this.closeOutboundPeer(viewerId);
      }
    };

    const offer = await pc.createOffer();
    const cinemaSdp = enhanceSdpForCinema(offer.sdp || '', this.quality.bitrateMbps);
    await pc.setLocalDescription({ type: offer.type, sdp: cinemaSdp });
    await this.applySenderEncodingParams(pc);

    await this.signaling.send(viewerId, 'offer', {
      streamerId: streamerOriginId,
      sdp: pc.localDescription,
    });
  }

  private async handleSignal(env: SignalEnvelope) {
    const sender = env.from;
    const data = env.payload as any;

    if (env.type === 'announce' || env.type === 'welcome') {
      const prev = this.peers.get(sender);
      const wasStreaming = prev?.isStreaming ?? false;
      const nowStreaming = Boolean(data.isStreaming);

      this.peers.set(sender, {
        peerId: sender,
        nickname: data.nickname || 'Amigo',
        isStreaming: nowStreaming,
        cascadeRelay: Boolean(data.cascadeRelay),
        viewerCount: Number(data.viewerCount || 0),
        streamLabel: data.streamLabel || '',
        lastSeen: Date.now(),
      });
      this.emitPeers();

      if (env.type === 'announce' && !prev) {
        await this.broadcastPresence('welcome', sender);
      }

      // Auto-watch when a friend starts streaming and we aren't streaming or watching anyone else yet!
      if (
        nowStreaming &&
        !this.localStream &&
        !this.watchingStreamerId
      ) {
        await this.watchStreamer(sender);
      } else if (!nowStreaming && wasStreaming && this.watchingStreamerId === sender) {
        this.stopWatching();
      }
      return;
    }

    if (env.type === 'bye') {
      this.peers.delete(sender);
      this.closeOutboundPeer(sender);
      if (this.watchingStreamerId === sender) {
        this.stopWatching();
      }
      this.emitPeers();
      return;
    }

    if (env.type === 'reaction') {
      this.callbacks.onReaction(
        data?.nickname || 'Amigo',
        data?.emoji || '🍌'
      );
      return;
    }

    if (env.type === 'watch-request') {
      // Someone wants to watch our stream
      if (!this.localStream) return;

      // Optional Cascade P2P Relay: if host enabled cascadeRelay and already serves >= 2 direct viewers, delegate!
      const activeDirect = Array.from(this.directChildren).filter((id) => {
        const pc = this.outboundPcs.get(id);
        return pc && pc.connectionState === 'connected' && id !== sender;
      });

      if (this.quality.cascadeRelay && activeDirect.length >= 2) {
        const relayHelperId =
          activeDirect[Math.floor(Math.random() * activeDirect.length)];
        await this.signaling.send(relayHelperId, 'relay-assign', {
          viewerId: sender,
          streamerId: this.selfId,
        });
        return;
      }

      this.directChildren.add(sender);
      await this.createOutboundConnection(sender, this.localStream, this.selfId);
      return;
    }

    if (env.type === 'relay-assign') {
      // Host asked us to forward our received MediaStream to another friend in the room!
      if (this.receivedStream && data?.viewerId && data?.streamerId) {
        await this.createOutboundConnection(
          data.viewerId,
          this.receivedStream,
          data.streamerId
        );
      }
      return;
    }

    if (env.type === 'offer') {
      const streamerId = data?.streamerId || sender;
      if (
        this.watchingStreamerId &&
        this.watchingStreamerId !== streamerId
      ) {
        return;
      }

      this.watchingStreamerId = streamerId;
      this.inboundProviderId = sender;
      this.callbacks.onWatchTargetChanged(streamerId);

      if (this.inboundPc) {
        try {
          this.inboundPc.close();
        } catch {}
      }

      const pc = new RTCPeerConnection({
        iceServers: ICE_SERVERS,
        bundlePolicy: 'max-bundle',
      });
      this.inboundPc = pc;

      const remoteMedia = new MediaStream();
      pc.ontrack = (ev) => {
        // Minimize receiver jitter buffer target for ultra-low latency
        try {
          // @ts-ignore - Chromium jitterBufferTarget in ms
          if ('jitterBufferTarget' in ev.receiver) {
            // @ts-ignore
            ev.receiver.jitterBufferTarget = 20;
          }
        } catch {}

        const incoming = ev.streams[0];
        if (incoming) {
          for (const t of incoming.getTracks()) {
            if (!remoteMedia.getTracks().some((x) => x.id === t.id)) {
              remoteMedia.addTrack(t);
            }
          }
        }
        if (!remoteMedia.getTracks().some((x) => x.id === ev.track.id)) {
          remoteMedia.addTrack(ev.track);
        }

        // Always pass a fresh MediaStream wrapper so React detects when audio arrives after video
        const snapshot = new MediaStream(remoteMedia.getTracks());
        this.receivedStream = snapshot;
        this.callbacks.onRemoteStream(streamerId, snapshot, sender);
      };

      pc.onicecandidate = (ev) => {
        if (ev.candidate) {
          void this.signaling.send(sender, 'ice', {
            role: 'viewer',
            candidate: ev.candidate.toJSON(),
          });
        }
      };

      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'failed' && this.watchingStreamerId) {
          const target = this.watchingStreamerId;
          window.setTimeout(() => {
            if (this.watchingStreamerId === target) {
              void this.watchStreamer(target);
            }
          }, 1500);
        }
      };

      await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
      const answer = await pc.createAnswer();
      const stereoAnswerSdp = enhanceSdpForCinema(answer.sdp || '', this.quality.bitrateMbps);
      await pc.setLocalDescription({
        type: answer.type,
        sdp: stereoAnswerSdp,
      });

      await this.signaling.send(sender, 'answer', {
        sdp: pc.localDescription,
      });
      return;
    }

    if (env.type === 'answer') {
      const pc = this.outboundPcs.get(sender);
      if (pc && data?.sdp) {
        await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
        await this.applySenderEncodingParams(pc);
      }
      return;
    }

    if (env.type === 'ice' && data?.candidate) {
      if (data.role === 'viewer') {
        const pc = this.outboundPcs.get(sender);
        if (pc) {
          try {
            await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
          } catch {}
        }
      } else if (data.role === 'provider' && this.inboundPc && this.inboundProviderId === sender) {
        try {
          await this.inboundPc.addIceCandidate(
            new RTCIceCandidate(data.candidate)
          );
        } catch {}
      }
    }
  }

  private async collectStats() {
    const activePc =
      this.inboundPc ||
      Array.from(this.outboundPcs.values()).find(
        (p) => p.connectionState === 'connected'
      );

    if (!activePc) {
      this.callbacks.onStatsUpdated(null);
      return;
    }

    try {
      const report = await activePc.getStats();
      let fps = 0;
      let width = 0;
      let height = 0;
      let bytes = 0;
      let rttMs = 0;
      let packetsLost = 0;
      let packetsTotal = 0;
      let codecId = '';
      let codecName = '';
      let routeType = 'P2P Direto';
      let limitation = 'none';

      report.forEach((stat: any) => {
        if (
          this.inboundPc &&
          stat.type === 'inbound-rtp' &&
          stat.kind === 'video'
        ) {
          fps = Math.round(stat.framesPerSecond || 0);
          width = stat.frameWidth || 0;
          height = stat.frameHeight || 0;
          bytes = stat.bytesReceived || 0;
          packetsLost = stat.packetsLost || 0;
          packetsTotal = (stat.packetsReceived || 0) + packetsLost;
          codecId = stat.codecId || '';
        } else if (
          !this.inboundPc &&
          stat.type === 'outbound-rtp' &&
          stat.kind === 'video'
        ) {
          fps = Math.round(stat.framesPerSecond || 0);
          width = stat.frameWidth || 0;
          height = stat.frameHeight || 0;
          bytes = stat.bytesSent || 0;
          codecId = stat.codecId || '';
          if (stat.qualityLimitationReason) {
            limitation = String(stat.qualityLimitationReason);
          }
        } else if (
          stat.type === 'candidate-pair' &&
          stat.state === 'succeeded' &&
          stat.nominated
        ) {
          if (typeof stat.currentRoundTripTime === 'number') {
            rttMs = Math.round(stat.currentRoundTripTime * 1000);
          }
          const remoteCand = report.get(stat.remoteCandidateId) as any;
          if (remoteCand) {
            const addr: string = remoteCand.address || remoteCand.ip || '';
            if (addr.includes(':')) {
              routeType = 'IPv6 Direto';
            } else if (
              remoteCand.candidateType === 'host' ||
              addr.startsWith('192.168.') ||
              addr.startsWith('10.') ||
              addr.startsWith('26.') ||
              addr.startsWith('100.')
            ) {
              routeType = 'LAN / VPN Direta';
            } else {
              routeType = 'UDP P2P';
            }
          }
        }
      });

      if (codecId) {
        const c = report.get(codecId) as any;
        if (c?.mimeType) {
          codecName = String(c.mimeType).replace('video/', '').toUpperCase();
        }
      }

      const now = performance.now();
      let bitrateMbps = 0;
      if (this.prevStatsTs > 0 && bytes >= this.prevBytes) {
        const dtSec = (now - this.prevStatsTs) / 1000;
        if (dtSec > 0) {
          bitrateMbps = Number(
            (((bytes - this.prevBytes) * 8) / (dtSec * 1_000_000)).toFixed(1)
          );
        }
      }
      this.prevBytes = bytes;
      this.prevStatsTs = now;

      if (this.inboundProviderId && this.watchingStreamerId && this.inboundProviderId !== this.watchingStreamerId) {
        routeType = 'Cascata P2P';
      }

      const packetLossPct =
        packetsTotal > 0
          ? Number(((packetsLost / packetsTotal) * 100).toFixed(1))
          : 0;

      this.callbacks.onStatsUpdated({
        fps,
        width,
        height,
        bitrateMbps,
        rttMs,
        packetLossPct,
        codec: codecName || 'GPU',
        routeType,
        limitation,
      });
    } catch {}
  }
}
