// Captures mono microphone audio and posts ~100 ms Int16 PCM frames to the main thread.
class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.frameSize = Math.round(sampleRate / 10);
    this.buffer = new Int16Array(this.frameSize);
    this.offset = 0;
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;
    let peak = 0;
    for (let i = 0; i < channel.length; i++) {
      const s = Math.max(-1, Math.min(1, channel[i]));
      peak = Math.max(peak, Math.abs(s));
      this.buffer[this.offset++] = s < 0 ? s * 0x8000 : s * 0x7fff;
      if (this.offset === this.frameSize) {
        this.port.postMessage({ pcm: this.buffer.buffer, peak }, [this.buffer.buffer]);
        this.buffer = new Int16Array(this.frameSize);
        this.offset = 0;
        peak = 0;
      }
    }
    return true;
  }
}

registerProcessor('pcm-capture', PcmCaptureProcessor);
