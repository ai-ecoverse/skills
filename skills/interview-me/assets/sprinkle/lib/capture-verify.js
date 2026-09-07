// interview-me / capture-verify.js
//
// Proves the REAL save path and the REAL N-camera capture path end to end,
// into a scratch sessions root under /tmp. This exists because
// `writeSessionArtifacts()` / `saveMedia()` had never once executed -- they had
// only ever been parse-checked -- and the protection on `sessions/` (13
// irreplaceable recordings) was the thing blocking the only verification that
// matters.
//
// It drives the REAL functions: real `getUserMedia`, real `createHumanRecorder`
// / `createCameraRecorder` / `createAgentRecorder`, real `createChunkFlusher`,
// real `writeSessionArtifacts()` -- now via the SHARED lib/multicam-record.js
// (prepareMultiCamRecording + buildCameraSyncInfo), the same path beginSession
// uses, rather than an inline copy. Nothing here reimplements the pipeline; it
// only supplies the state that a live session would have supplied, exactly as
// `dryrun.js` already does for the transcript half.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createCaptureVerify(ctx) {
  const {
    el,
    state,
    withTimeout,
    createAgentRecorder,
    createChunkFlusher,
    AudioPlayer,
    TranscriptStore,
    PARTS_ROOT,
    writeSessionArtifacts,
    setSessionsRoot,
    safeDiag,
    MODEL,
    prepareMultiCamRecording,
    buildCameraSyncInfo,
  } = ctx;

  /**
   * @param {object} opts
   * @param {number} opts.cameras  how many cameras to open (1 = the Phase 0
   *                               single-camera save-path proof)
   * @param {number} opts.seconds  recording length
   * @param {string} opts.root     scratch sessions root (MUST be under /tmp)
   */
  async function runCaptureVerify({ cameras = 1, seconds = 6, root = "/tmp/im-capture-verify" } = {}) {
    if (!root.startsWith("/tmp/")) throw new Error(`refusing a scratch root outside /tmp: ${root}`);
    const out = { startedAt: new Date().toISOString(), requestedCameras: cameras, seconds, root, opens: [], streams: [] };
    const snapshot = {};
    for (const k of ["t0", "humanBlob", "agentBlob", "humanRecorder", "agentRecorder", "flushers", "cameras", "transcript", "config", "kb", "lastSessionConfig", "sessionDir", "player", "audioCtx", "rawStream", "micWatchdog", "streamWatchdog", "wrapupController", "session", "pendingForceMessageText", "forceMessageItemIds", "sessionLengthMs"]) {
      snapshot[k] = state[k];
    }
    let opened = [];
    let audioCtx = null;
    setSessionsRoot(root);
    try {
      // --- devices ------------------------------------------------------
      const devices = await withTimeout(navigator.mediaDevices.enumerateDevices(), 8000, "enumerateDevices");
      const vids = devices.filter((d) => d.kind === "videoinput");
      const mics = devices.filter((d) => d.kind === "audioinput");
      out.available = { videoinput: vids.length, audioinput: mics.length, videoLabels: vids.map((d) => d.label) };
      const wanted = Math.min(cameras, vids.length);
      if (wanted === 0) throw new Error("no video input devices");

      // --- ONE shared mic track, muxed into every file -------------------
      // DESIGN.md section 4: decoded PCM is byte-identical (same MD5) across
      // all five files at 5-minute scale, which is what makes alignment exact
      // for free. Open the mic ONCE.
      const micStream = await withTimeout(
        navigator.mediaDevices.getUserMedia({ audio: mics.length ? { deviceId: { exact: mics[0].deviceId } } : true }),
        10000,
        "getUserMedia(audio)"
      );
      const sharedAudioTrack = micStream.getAudioTracks()[0];
      out.sharedAudio = { label: sharedAudioTrack.label, settings: sharedAudioTrack.getSettings() };

      // --- open cameras + build recorders via the SHARED setup -----------
      // The SAME code path beginSession() uses for a real interview
      // (lib/multicam-record.js). This harness proves it end to end.
      const t0 = Date.now();
      state.t0 = t0;
      const iso = new Date(t0).toISOString().replace(/[:.]/g, "-");
      const partsRoot = `${PARTS_ROOT}/${iso}`;
      audioCtx = new AudioContext({ sampleRate: 24000 });
      const player = new AudioPlayer(audioCtx, 24000);
      state.player = player;
      state.audioCtx = audioCtx;

      const prep = await prepareMultiCamRecording({
        videoDevices: vids.slice(0, wanted),
        sharedAudioTrack,
        heroDeviceId: vids[0].deviceId,
        partsRoot,
        slicc,
      });
      opened = prep.opened;
      if (!opened.length) throw new Error("no camera opened");
      out.opens = opened.map((o) => ({ role: o.role, label: o.label, attempts: o.attempts, openMs: Math.round(o.openMs), firstTsUs: o.firstTsUs, settings: o.settings }));
      out.zeroFrameRetries = opened.reduce((a, o) => a + (o.attempts - 1), 0);

      // agent recorder (session playback capture; not a camera) -> agent.webm
      const agentRec = createAgentRecorder(player.stream);
      try {
        prep.flushers.agent = createChunkFlusher({ slicc, withTimeout, partsDir: `${partsRoot}/agent`, name: "agent", onDiagnostic: safeDiag });
        agentRec.attachFlusher(prep.flushers.agent);
      } catch (e) {
        safeDiag("multicam:flusher-setup-failed", { name: "agent", message: e && e.message });
      }
      state.humanRecorder = prep.heroRecorder;
      state.agentRecorder = agentRec;
      state.flushers = prep.flushers;
      state.cameras = prep.cameras;

      // --- START ALL RECORDERS IN ONE SYNCHRONOUS LOOP (shared) ----------
      const { recs, startWall, startSpreadMs } = prep.startAll([agentRec]);
      out.recorderStartSpreadMs = startSpreadMs;
      out.recorderStartWallMs = startWall;

      await sleep(seconds * 1000);

      // --- stop -----------------------------------------------------------
      const blobs = await Promise.all(recs.map((r) => r.stop()));
      const endedAt = Date.now();
      for (const o of opened) o.meter.stopped = true;
      state.humanBlob = blobs[0];
      state.agentBlob = blobs[blobs.length - 1];
      for (let i = 0; i < prep.cameras.length; i++) prep.cameras[i].blob = blobs[1 + i];

      // --- the REAL save path --------------------------------------------
      state.transcript = new TranscriptStore(t0);
      state.transcript.setUserTranscript("verify-user-1", "Capture verification utterance.");
      state.transcript.markUserFinal("verify-user-1");
      state.config = { voice: "helix", topic: "capture verification", kbMode: "collection", kbPath: null, collectionId: null, webSearch: false, xSearch: false };
      state.kb = { files: [] };
      state.lastSessionConfig = { verify: true };
      state.sessionLengthMs = seconds * 1000;

      const sync = buildCameraSyncInfo({ opened, cameras: prep.cameras, humanBlob: state.humanBlob, startWall, startSpreadMs, sharedAudioTrack, endedAt });
      state.syncInfo = sync.syncInfo;
      out.streams = sync.syncInfo.cameras;
      out.firstFrameSpreadMs = sync.firstFrameSpreadMs;
      await writeSessionArtifacts(endedAt, endedAt - t0, "capture-verify");
      out.sessionDir = state.sessionDir;
      out.mediaWrites = state.mediaWrites;
      out.expectedDir = `${root}/${iso}`;

      // --- listing, for the external verifier ----------------------------
      const listing = [];
      const walk = async (dir, prefix = "") => {
        let entries;
        try {
          entries = await slicc.readDir(dir);
        } catch (e) {
          return;
        }
        for (const e of entries || []) {
          const nm = typeof e === "string" ? e : e && e.name;
          if (!nm) continue;
          const full = `${dir}/${nm}`;
          let st = null;
          try {
            st = await slicc.stat(full);
          } catch (e2) {
            /* ignore */
          }
          if (st && st.type === "directory") await walk(full, `${prefix}${nm}/`);
          else listing.push({ path: `${prefix}${nm}`, bytes: st ? st.size : null });
        }
      };
      await walk(state.sessionDir);
      out.listing = listing;

      out.finishedAt = new Date().toISOString();
      return out;
    } catch (err) {
      out.error = err.message;
      out.stack = err.stack;
      return out;
    } finally {
      setSessionsRoot(null);
      for (const o of opened) {
        o.meter.stopped = true;
        try {
          for (const t of o.stream.getTracks()) t.stop();
        } catch (e) {
          /* ignore */
        }
      }
      try {
        if (audioCtx) await audioCtx.close();
      } catch (e) {
        /* ignore */
      }
      Object.assign(state, snapshot);
      try {
        await slicc.mkdir("/tmp/im-capture-verify");
        await slicc.writeFile("/tmp/im-capture-verify/report.json", JSON.stringify(out, null, 2));
      } catch (e) {
        /* best effort */
      }
      window.__imDiag && window.__imDiag("capture-verify-complete", { cameras: out.streams.length, dir: out.sessionDir, error: out.error || null });
    }
  }

  return { runCaptureVerify };
}
