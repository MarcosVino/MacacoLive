class MacacoPcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    // 1 second stereo ring buffer at 48kHz
    this.capacity = 48000;
    this.leftBuf = new Float32Array(this.capacity);
    this.rightBuf = new Float32Array(this.capacity);
    this.writePos = 0;
    this.readPos = 0;
    this.buffered = 0;

    // Max allowed queue before trimming (~75ms = 3600 frames) to guarantee zero audio drift over multi-hour sessions
    this.maxLatencyFrames = 3600;
    this.targetLatencyFrames = 1200; // ~25ms sweet spot

    this.port.onmessage = (event) => {
      const interleaved = event.data;
      if (!interleaved || interleaved.length < 2) return;

      const frames = (interleaved.length / 2) | 0;
      const cap = this.capacity;
      let wp = this.writePos;

      for (let i = 0; i < frames; i++) {
        this.leftBuf[wp] = interleaved[i * 2];
        this.rightBuf[wp] = interleaved[i * 2 + 1];
        wp++;
        if (wp >= cap) wp = 0;
      }

      this.writePos = wp;
      this.buffered += frames;

      // Prevent drift accumulation over long 5+ hour streams
      if (this.buffered > this.maxLatencyFrames) {
        this.readPos = (this.writePos - this.targetLatencyFrames + cap) % cap;
        this.buffered = this.targetLatencyFrames;
      }
    };
  }

  process(_inputs, outputs) {
    const output = outputs[0];
    if (!output || output.length === 0) return true;

    const outL = output[0];
    const outR = output.length > 1 ? output[1] : null;
    const len = outL.length;

    if (this.buffered < len) {
      // Underrun / silence: fill remaining cleanly without pops
      let rp = this.readPos;
      const cap = this.capacity;
      const avail = this.buffered;

      for (let i = 0; i < avail; i++) {
        outL[i] = this.leftBuf[rp];
        if (outR) outR[i] = this.rightBuf[rp];
        rp++;
        if (rp >= cap) rp = 0;
      }
      for (let i = avail; i < len; i++) {
        outL[i] = 0;
        if (outR) outR[i] = 0;
      }

      this.readPos = rp;
      this.buffered = 0;
      return true;
    }

    let rp = this.readPos;
    const cap = this.capacity;
    for (let i = 0; i < len; i++) {
      outL[i] = this.leftBuf[rp];
      if (outR) outR[i] = this.rightBuf[rp];
      rp++;
      if (rp >= cap) rp = 0;
    }

    this.readPos = rp;
    this.buffered -= len;
    return true;
  }
}

registerProcessor('macaco-pcm-processor', MacacoPcmProcessor);
