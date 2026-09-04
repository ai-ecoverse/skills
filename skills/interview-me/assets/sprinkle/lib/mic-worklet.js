// mic-worklet.js
// AudioWorkletProcessor loaded via audioContext.audioWorklet.addModule(url).
// Runs on the audio render thread — converts incoming Float32 mic frames to
// PCM16 THERE (not on the main thread, per BRIEF.md), batches ~100ms of
// audio, and posts each batch to the main thread as a transferable
// ArrayBuffer so no copy is made.
/* eslint-disable no-undef */

const TARGET_CHUNK_MS = 100;

class MicCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    this._sampleRate = opts.sampleRate || sampleRate; // `sampleRate` is a worklet global
    this._chunkSamples = Math.max(1, Math.round((this._sampleRate * TARGET_CHUNK_MS) / 1000));
    this._buffer = new Int16Array(this._chunkSamples);
    this._writeIndex = 0;
    this._active = true;

    this.port.onmessage = (event) => {
      if (event.data && event.data.type === "stop") this._active = false;
    };
  }

  _flush() {
    if (this._writeIndex === 0) return;
    // Only send the samples actually written on the final partial chunk.
    const out = this._writeIndex === this._buffer.length ? this._buffer : this._buffer.slice(0, this._writeIndex);
    this.port.postMessage({ type: "chunk", buffer: out.buffer }, [out.buffer]);
    this._buffer = new Int16Array(this._chunkSamples);
    this._writeIndex = 0;
  }

  process(inputs) {
    if (!this._active) return false;
    const input = inputs[0];
    const channel = input && input[0];
    if (!channel) return true;

    for (let i = 0; i < channel.length; i++) {
      const s = Math.max(-1, Math.min(1, channel[i]));
      this._buffer[this._writeIndex++] = s < 0 ? s * 0x8000 : s * 0x7fff;
      if (this._writeIndex >= this._buffer.length) this._flush();
    }
    return true;
  }
}

registerProcessor("mic-capture-processor", MicCaptureProcessor);
