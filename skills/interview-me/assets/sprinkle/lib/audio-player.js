// audio-player.js
// Schedules base64 PCM16 deltas from the assistant into a single seamless
// playback graph. Keeps a running playhead so buffers butt up without
// clicking (per BRIEF.md), and exposes a MediaStreamDestination so the same
// audio can be captured by a MediaRecorder for the "agent audio" recording.

import { base64PCM16ToFloat32 } from "./pcm-codec.js";

export class AudioPlayer {
  constructor(audioContext, sampleRate = 24000) {
    this.ctx = audioContext;
    this.sampleRate = sampleRate;
    this.playheadTime = audioContext.currentTime;
    this.activeSources = [];

    this.destinationNode = this.ctx.createMediaStreamDestination();
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.gainNode = this.ctx.createGain();

    this.gainNode.connect(this.ctx.destination);
    this.gainNode.connect(this.destinationNode);
    this.gainNode.connect(this.analyser);
  }

  /** MediaStream to hand to a MediaRecorder for the agent-audio recording. */
  get stream() {
    return this.destinationNode.stream;
  }

  enqueueBase64(base64) {
    if (!base64) return;
    this.enqueueFloat32(base64PCM16ToFloat32(base64));
  }

  enqueueFloat32(float32Array) {
    if (!float32Array || !float32Array.length) return;
    const buffer = this.ctx.createBuffer(1, float32Array.length, this.sampleRate);
    buffer.copyToChannel(float32Array, 0);

    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.gainNode);

    const startAt = Math.max(this.ctx.currentTime, this.playheadTime);
    source.start(startAt);
    this.playheadTime = startAt + buffer.duration;

    this.activeSources.push(source);
    source.onended = () => {
      const idx = this.activeSources.indexOf(source);
      if (idx >= 0) this.activeSources.splice(idx, 1);
    };
  }

  /** Barge-in: stop and drop everything queued/playing right now. */
  flush() {
    for (const source of this.activeSources) {
      try {
        source.stop();
      } catch (err) {
        /* already stopped/ended */
      }
    }
    this.activeSources = [];
    this.playheadTime = this.ctx.currentTime;
  }

  /** True while there is still scheduled audio ahead of the play cursor. */
  isDraining() {
    return this.ctx.currentTime < this.playheadTime - 0.02;
  }

  /**
   * Resolves once everything currently scheduled has finished playing.
   * Capped at `maxWaitMs` (default 20s -- generous for a single response's
   * audio, but not unbounded): if the AudioContext ever stalls (e.g. gets
   * suspended without a user gesture to resume it) `ctx.currentTime` stops
   * advancing and `isDraining()` would never return false, hanging this
   * forever. Resolves rather than rejects on timeout, since the one caller
   * of this (the tool-call continuation in interview-me.shtml) has no
   * `.catch()` on the chain -- a rejection there would silently swallow the
   * pending `response.create` forever, which is worse than proceeding late.
   */
  waitForDrain(pollMs = 50, maxWaitMs = 20000) {
    return new Promise((resolve) => {
      const deadline = Date.now() + maxWaitMs;
      const check = () => {
        if (!this.isDraining() || Date.now() >= deadline) resolve();
        else setTimeout(check, pollMs);
      };
      check();
    });
  }

  /** 0..1 level for a simple waveform/level meter, sampled from the analyser. */
  currentLevel() {
    const data = new Uint8Array(this.analyser.fftSize);
    this.analyser.getByteTimeDomainData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i++) {
      const v = (data[i] - 128) / 128;
      sum += v * v;
    }
    return Math.sqrt(sum / data.length);
  }

  getTimeDomainData(target) {
    this.analyser.getByteTimeDomainData(target);
    return target;
  }
}
