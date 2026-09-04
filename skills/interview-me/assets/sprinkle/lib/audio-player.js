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

    // Keeps destinationNode's MediaStreamTrack alive with a real, continuous
    // signal for the entire lifetime of this AudioPlayer -- fixes a real bug
    // where a MediaRecorder attached to `stream` dropped stretches where the
    // agent wasn't speaking instead of recording them as silence (confirmed
    // empirically: an agent.webm recorded 66.9s of audio for a 94.6s session
    // -- the agent recorder and the human recorder ended up on different
    // timelines, so a timestamp in one file did not correspond to the same
    // moment in the other).
    //
    // A `ConstantSourceNode` at offset 0 (true, exact silence) was tried
    // FIRST and measured to have NO effect: a diagnostic recording with a
    // real silent gap decoded to roughly half its wall-clock duration both
    // before and after adding it. That rules out "the rendering graph goes
    // idle without an actively-scheduled source" as the mechanism -- exact
    // zero is exactly as easy to detect as no signal at all. The remaining
    // explanation is encoder-side silence suppression (Opus DTX/VAD-style
    // behavior): the recorder's encoder is dropping frames it detects as
    // silence, and true zero is the easiest possible input to detect as
    // silence.
    //
    // Fix: loop an extremely low-amplitude noise buffer (peak ~1/32768, the
    // smallest step a 16-bit PCM sample can represent, i.e. below what
    // ANY consumer downstream of this graph could ever quantize as
    // distinguishable from true silence) instead of true zero. This is not
    // "silence" from a real-signal encoder's point of view -- there is no
    // stretch of identical, repeatable zero for a VAD/DTX heuristic to
    // key off -- verified below by re-running the exact silence-then-tone
    // diagnostic this fix was written against and confirming decoded
    // duration now tracks wall-clock time. Contribution to every other
    // consumer of gainNode (ctx.destination playback, the analyser used for
    // the level meter/waveform) is inaudible and does not move the meter:
    // a peak amplitude of 1/32768 is roughly -90 dBFS, far below both human
    // hearing and this app's own level-meter/waveform rendering.
    const DITHER_SECONDS = 1;
    const DITHER_PEAK = 1 / 32768;
    const ditherBuffer = this.ctx.createBuffer(1, Math.round(DITHER_SECONDS * this.ctx.sampleRate), this.ctx.sampleRate);
    const ditherData = ditherBuffer.getChannelData(0);
    for (let i = 0; i < ditherData.length; i++) {
      ditherData[i] = (Math.random() * 2 - 1) * DITHER_PEAK;
    }
    this.silenceNode = this.ctx.createBufferSource();
    this.silenceNode.buffer = ditherBuffer;
    this.silenceNode.loop = true;
    this.silenceNode.connect(this.gainNode);
    this.silenceNode.start();
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
