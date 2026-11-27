let sharedCtx: AudioContext | null = null;
let noiseBuffer: AudioBuffer | null = null;

function getAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const Ctor =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;

  if (!sharedCtx || sharedCtx.state === 'closed') {
    sharedCtx = new Ctor({ latencyHint: 'interactive' });
    noiseBuffer = null;
  }
  if (sharedCtx.state === 'suspended') {
    void sharedCtx.resume().catch(() => {});
  }
  return sharedCtx;
}

function getNoiseBuffer(ctx: AudioContext): AudioBuffer {
  if (noiseBuffer && noiseBuffer.sampleRate === ctx.sampleRate) {
    return noiseBuffer;
  }
  const len = Math.floor(ctx.sampleRate * 0.16);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const ch = buf.getChannelData(0);
  for (let i = 0; i < len; i++) {
    ch[i] = Math.random() * 2 - 1;
  }
  noiseBuffer = buf;
  return buf;
}

/**
 * Plays a lightweight synthesized cartoon banana sound:
 * parabolic whistle -> squishy splat + rubbery boing -> cheeky monkey "uh-uh!".
 */
export function playBananaSound(combo = 1, muted = false): void {
  if (muted) return;
  const ctx = getAudioContext();
  if (!ctx) return;

  try {
    const now = ctx.currentTime;
    const jitter = 0.94 + Math.random() * 0.14;
    const comboLift = 1 + Math.min(combo - 1, 6) * 0.055;
    const pitch = jitter * comboLift;

    const master = ctx.createGain();
    master.gain.setValueAtTime(0.28, now);
    master.connect(ctx.destination);

    // 1) Flying banana whistle sweep (0ms .. 125ms)
    const whooshOsc = ctx.createOscillator();
    const whooshGain = ctx.createGain();
    whooshOsc.type = 'triangle';
    whooshOsc.frequency.setValueAtTime(860 * pitch, now);
    whooshOsc.frequency.exponentialRampToValueAtTime(290 * pitch, now + 0.12);
    whooshGain.gain.setValueAtTime(0.001, now);
    whooshGain.gain.linearRampToValueAtTime(0.45, now + 0.025);
    whooshGain.gain.exponentialRampToValueAtTime(0.001, now + 0.125);
    whooshOsc.connect(whooshGain);
    whooshGain.connect(master);
    whooshOsc.start(now);
    whooshOsc.stop(now + 0.13);

    // 2) Squishy wet cartoon splat noise burst at impact (~110ms)
    const splatStart = now + 0.105;
    const splatSrc = ctx.createBufferSource();
    splatSrc.buffer = getNoiseBuffer(ctx);
    const splatFilter = ctx.createBiquadFilter();
    splatFilter.type = 'bandpass';
    splatFilter.Q.setValueAtTime(2.6, splatStart);
    splatFilter.frequency.setValueAtTime(1150 * pitch, splatStart);
    splatFilter.frequency.exponentialRampToValueAtTime(280 * pitch, splatStart + 0.11);

    const splatGain = ctx.createGain();
    splatGain.gain.setValueAtTime(0.001, splatStart);
    splatGain.gain.linearRampToValueAtTime(0.75, splatStart + 0.012);
    splatGain.gain.exponentialRampToValueAtTime(0.001, splatStart + 0.12);

    splatSrc.connect(splatFilter);
    splatFilter.connect(splatGain);
    splatGain.connect(master);
    splatSrc.start(splatStart);
    splatSrc.stop(splatStart + 0.13);

    // 3) Comedic rubbery "boing-plop" right on impact (110ms .. 280ms)
    const boingOsc = ctx.createOscillator();
    const boingGain = ctx.createGain();
    boingOsc.type = 'sine';
    boingOsc.frequency.setValueAtTime(165 * pitch, splatStart);
    boingOsc.frequency.exponentialRampToValueAtTime(410 * pitch, splatStart + 0.055);
    boingOsc.frequency.exponentialRampToValueAtTime(135 * pitch, splatStart + 0.17);
    boingGain.gain.setValueAtTime(0.001, splatStart);
    boingGain.gain.linearRampToValueAtTime(0.65, splatStart + 0.014);
    boingGain.gain.exponentialRampToValueAtTime(0.001, splatStart + 0.175);
    boingOsc.connect(boingGain);
    boingGain.connect(master);
    boingOsc.start(splatStart);
    boingOsc.stop(splatStart + 0.18);

    // 4) Playful monkey double chirp ("uh-uh!") (195ms .. 350ms)
    const chirps = [
      { t: now + 0.19, f0: 510, f1: 770 },
      { t: now + 0.275, f0: 580, f1: 910 },
    ];
    for (const c of chirps) {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(c.f0 * pitch, c.t);
      osc.frequency.exponentialRampToValueAtTime(c.f1 * pitch, c.t + 0.062);
      g.gain.setValueAtTime(0.001, c.t);
      g.gain.linearRampToValueAtTime(0.32, c.t + 0.012);
      g.gain.exponentialRampToValueAtTime(0.001, c.t + 0.07);
      osc.connect(g);
      g.connect(master);
      osc.start(c.t);
      osc.stop(c.t + 0.075);
    }
  } catch {
    // Ignore Web Audio autoplay blocks cleanly
  }
}

export function playChatPop(muted = false): void {
  if (muted) return;
  const ctx = getAudioContext();
  if (!ctx) return;

  try {
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(620, now);
    osc.frequency.exponentialRampToValueAtTime(860, now + 0.055);
    g.gain.setValueAtTime(0.001, now);
    g.gain.linearRampToValueAtTime(0.08, now + 0.01);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.07);
    osc.connect(g);
    g.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.075);
  } catch {}
}
