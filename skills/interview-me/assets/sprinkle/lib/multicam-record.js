// interview-me / multicam-record.js
//
// SHARED multi-camera open + record setup, used by BOTH the real interview
// (session-start.js beginSession) and the capture-verify harness. The logic
// here was extracted from capture-verify.js's former inline copy with NO
// behavioural change, so a real interview records every camera angle the same
// way the harness proves.
//
// Invariants preserved from the multi-cam design campaign:
//  - Every camera opens through openCameraWithWatchdog (reads a frame, retries
//    the ~4% silent zero-frame opens; 9/9 recovered on first retry).
//  - ONE shared mic track is muxed into EVERY file (createCameraRecorder adds
//    it) AND is what the realtime session / mic-watchdog tap. The caller OWNS
//    that track: this module never opens or stops it, so none of those three
//    consumers is starved.
//  - Recorders start in ONE synchronous loop and each fps meter is armed in
//    that same loop (startAll), so per-angle offsetMs is measured from the
//    RECORDING phase, not from sequential open latency -- that bug produced a
//    bogus 2393 ms spread, fixed to ~63 ms.
//  - A camera that fails all retries is skipped (never throws out of setup).
//    Zero cameras -> an audio-only hero recorder, so the audio-only fallback
//    still yields a valid human.webm.
//  - Chunk Blobs cost ~0 heap; whole-file materialisation is what is
//    expensive, so recording streams to part files via createChunkFlusher and
//    a whole file is never held in memory here.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createMulticamRecord(ctx) {
  const {
    openCameraWithWatchdog,
    createHumanRecorder,
    createCameraRecorder,
    createChunkFlusher,
    safeDiag,
    withTimeout,
  } = ctx;

  /**
   * Open the hero + every additional camera, build one recorder per opened
   * camera (hero -> createHumanRecorder -> human.webm; angles ->
   * createCameraRecorder -> video/angleN.webm), attach chunk flushers, and
   * return everything the caller needs. Does NOT start the recorders -- call
   * the returned startAll() for the synchronous start loop, at the caller's
   * chosen moment.
   *
   * @param {object} o
   * @param {Array}  o.videoDevices     enumerated videoinput devices
   * @param {MediaStreamTrack|null} o.sharedAudioTrack the ONE mic track
   * @param {string} o.heroDeviceId     which device records human.webm
   * @param {string} o.partsRoot        chunk-flusher parts base dir (/tmp/...)
   * @param {object} o.slicc            the bridge (for the flushers)
   */
  async function prepareMultiCamRecording({
    videoDevices,
    sharedAudioTrack,
    heroDeviceId,
    partsRoot,
    slicc,
    heroWidth = 1920,
    heroHeight = 1080,
    angleWidth = 1280,
    angleHeight = 720,
    angleVideoBitsPerSecond = 900_000,
  }) {
    const vids = Array.isArray(videoDevices) ? videoDevices : [];
    // Hero first (the selected device if it is present), then the rest in
    // enumeration order.
    const heroDev = vids.find((d) => d.deviceId && d.deviceId === heroDeviceId) || vids[0];
    const ordered = [];
    if (heroDev) ordered.push(heroDev);
    for (const d of vids) if (d !== heroDev) ordered.push(d);

    const opened = []; // successfully opened cameras, hero at index 0
    const failures = [];
    for (const d of ordered) {
      const isHero = opened.length === 0; // the first SUCCESS becomes the hero
      const width = isHero ? heroWidth : angleWidth;
      const height = isHero ? heroHeight : angleHeight;
      try {
        const res = await openCameraWithWatchdog(d.deviceId || undefined, width, height, safeDiag);
        opened.push({
          ...res,
          role: isHero ? "main" : `angle${opened.length}`,
          label: d.label,
          deviceId: d.deviceId,
          requested: `${width}x${height}@30`,
        });
      } catch (err) {
        safeDiag("multicam:camera-open-failed", { deviceId: d.deviceId, label: d.label, message: err && err.message });
        failures.push({ deviceId: d.deviceId, label: d.label, message: err && err.message });
      }
    }

    const flushers = {};
    const attachFlusher = (recorder, name) => {
      try {
        flushers[name] = createChunkFlusher({ slicc, withTimeout, partsDir: `${partsRoot}/${name}`, name, onDiagnostic: safeDiag });
        recorder.attachFlusher(flushers[name]);
      } catch (err) {
        // Flushing is an optimisation, never a precondition for recording.
        safeDiag("multicam:flusher-setup-failed", { name, message: err && err.message });
      }
    };

    // Hero recorder -> human.webm. With at least one camera it records that
    // camera + the shared mic; with NO camera it records the mic only (the
    // audio-only fallback), still through createHumanRecorder so human.webm's
    // name/location/bitrates are unchanged.
    const heroTracks = [];
    if (opened.length) heroTracks.push(opened[0].track);
    if (sharedAudioTrack) heroTracks.push(sharedAudioTrack);
    const heroRecorder = createHumanRecorder(new MediaStream(heroTracks));
    attachFlusher(heroRecorder, "human");

    // Additional angles -> video/angleN.webm, each muxing the SAME mic track.
    const angles = [];
    for (let i = 1; i < opened.length; i++) {
      const name = opened[i].role; // angle1, angle2, ...
      const r = createCameraRecorder(opened[i].track, sharedAudioTrack, { videoBitsPerSecond: angleVideoBitsPerSecond });
      attachFlusher(r, name);
      angles.push({ name, recorder: r, opened: opened[i] });
    }

    const cameras = angles.map((a) => ({ name: a.name, recorder: a.recorder, meter: a.opened.meter, opened: a.opened, blob: null }));

    // Arm every fps meter and start every recorder in ONE synchronous loop.
    // extraRecorders (e.g. the agent recorder) are included so they start in
    // the same tick. Returns timing for buildCameraSyncInfo.
    function startAll(extraRecorders = []) {
      const recs = [heroRecorder, ...angles.map((a) => a.recorder), ...extraRecorders];
      const startWall = Date.now();
      const startMarks = [];
      for (const o of opened) o.meter.armed = true;
      for (const r of recs) {
        startMarks.push(performance.now());
        r.start();
      }
      const startSpreadMs = startMarks.length ? Number((Math.max(...startMarks) - Math.min(...startMarks)).toFixed(2)) : 0;
      return { recs, startWall, startSpreadMs, startMarks };
    }

    return { opened, failures, heroRecorder, heroOpened: opened[0] || null, angles, cameras, flushers, startAll };
  }

  /**
   * Build the syncInfo object (written to sync.json) from the opened cameras
   * and their meters, AFTER recording has stopped and the blobs are known.
   * `cameras` are the angle descriptors (index i-1 corresponds to opened[i]).
   */
  function buildCameraSyncInfo({ opened, cameras, humanBlob, startWall, startSpreadMs, sharedAudioTrack, endedAt }) {
    const list = Array.isArray(opened) ? opened : [];
    const angleCams = Array.isArray(cameras) ? cameras : [];
    const elapsedS = (endedAt - startWall) / 1000;
    const streams = list.map((o, i) => {
      const m = o.meter || {};
      const spanS = m.lastTsUs != null && m.recordingFirstTsUs != null ? (m.lastTsUs - m.recordingFirstTsUs) / 1e6 : elapsedS;
      const blob = i === 0 ? humanBlob : angleCams[i - 1] && angleCams[i - 1].blob;
      return {
        role: o.role,
        file: i === 0 ? "human.webm" : `video/${o.role}.webm`,
        label: o.label,
        deviceId: o.deviceId,
        requested: o.requested || null,
        settings: o.settings ? `${o.settings.width}x${o.settings.height}@${o.settings.frameRate}` : null,
        openFirstFrameTsUs: m.firstTsUs,
        firstFrameTsUs: m.recordingFirstTsUs,
        frames: m.framesSinceArmed,
        framesIncludingOpen: m.frames,
        measuredAvgFps: spanS > 0 ? Number(((m.framesSinceArmed || 0) / spanS).toFixed(2)) : null,
        openAttempts: o.attempts,
        bytes: blob ? blob.size : 0,
      };
    });
    const firsts = streams.map((s) => s.firstFrameTsUs).filter((v) => v != null);
    const minTs = firsts.length ? Math.min(...firsts) : 0;
    for (const s of streams) s.offsetMs = s.firstFrameTsUs != null ? Number(((s.firstFrameTsUs - minTs) / 1000).toFixed(2)) : null;
    const firstFrameSpreadMs = firsts.length ? Number(((Math.max(...firsts) - minTs) / 1000).toFixed(2)) : null;
    const syncInfo = {
      version: 1,
      recorderStartWallMs: startWall,
      recorderStartSpreadMs: startSpreadMs,
      timebase: "VideoFrame.timestamp (us), monotonic, shared across devices",
      audio: sharedAudioTrack
        ? {
            shared: true,
            deviceLabel: sharedAudioTrack.label,
            sampleRate: sharedAudioTrack.getSettings().sampleRate || null,
            channels: sharedAudioTrack.getSettings().channelCount || null,
            note: "identical Opus track muxed into every camera file; sample-accurate alignment",
          }
        : { shared: false },
      cameras: streams,
    };
    return { syncInfo, firstFrameSpreadMs };
  }

  return { prepareMultiCamRecording, buildCameraSyncInfo, sleep };
}
