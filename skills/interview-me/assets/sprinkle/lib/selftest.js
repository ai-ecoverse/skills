// interview-me / selftest.js
//
// The sprinkle's built-in verification harness, extracted verbatim from
// interview-me.shtml (where it was ~103 KB of a 254 KB single file, the
// single biggest obstacle to working on that file). Behaviour is unchanged:
// same checks, same order, same report shape, same output paths.
//
// Loaded through `window.__imLoadModule` like every other module here --
// NOT via a native ESM import of a VFS path, which cannot work in an
// `about:srcdoc` iframe (see the loader's own header comment in the .shtml).
//
// `runSelfTest(ctx)` deliberately takes the host's live bindings as an
// explicit context object rather than importing lib modules itself: the
// point of these checks is to exercise the REAL objects the running app
// uses (the real `el`/`state`, the real `applyConfig`, the real module
// instances), so everything is forwarded from the .shtml's own scope.
// `buildSelfTestContext()` in the .shtml is the single place that mapping
// lives.

import { BASE_DIR, SESSIONS_ROOT } from "./constants.js";
import { listCollections } from "./collections.js";

/**
 * Run the full self-test suite.
 * Writes ${BASE_DIR}/selftest-report.json (BASE_DIR from constants.js) and returns the report.
 */
export async function runSelfTest(ctx) {
  const {
    AudioPlayer,
    RealtimeSession,
    TranscriptStore,
    TrackRecorder,
    createChunkFlusher,
    openFrameReader,
    FIRST_FRAME_TIMEOUT_MS,
    createCameraRecorder,
    createHumanRecorder,
    writeSessionArtifacts,
    setSessionsRoot,
    getSessionsRoot,
    UiState,
    createWrapupController,
    createMicWatchdog,
    createStreamWatchdog,
    buildDiagnosticsDocument,
    buildTools,
    buildInstructions,
    mintEphemeralToken,
    el,
    state,
    uiState,
    applyConfig,
    applyConfigPush,
    appendWrapupDirective,
    wireSessionHooks,
    wrapupOffsetMs,
    resolveWaveStrokeColor,
    showScreen,
    showSavingScreen,
    setMicWarning,
    setStreamWarning,
    clampSessionMinutes,
    safeAttachCameraPreview,
    getOrCreateVoicePreviewBytes,
    fmtMs,
    withTimeout,
    logStreamDiagnostics,
    gatherConfig,
    describeCameraDiagnostics,
    attachStreamToVideo,
    restartPreviewStream,
    renderPreviewGrid,
    createMulticamRecord,
    onKbModeChange,
    onTestSearch,
    MODEL,
    WRAP_UP_MESSAGE,
    WRAP_UP_DIRECTIVE,
    WRAP_UP_TIME_CHECK_CALL_ID,
    WRAP_UP_TIME_CHECK_PAYLOAD,
    HARD_BACKSTOP_GRACE_MS,
    MIN_SESSION_MINUTES,
    MAX_SESSION_MINUTES,
    getSessionLengthMs,
    setSessionLengthMs,
    getWaveStrokeColor,
    setWaveStrokeColor,
  } = ctx;

  const report = { startedAt: new Date().toISOString(), checks: [] };
  const check = (name, fn) =>
    Promise.resolve()
      .then(fn)
      .then((detail) => {
        report.checks.push({ name, ok: true, detail });
      })
      .catch((err) => {
        report.checks.push({ name, ok: false, error: err.message, stack: err.stack });
      });

  await check("dom-elements-present", () => {
    const missing = Object.entries(el).filter(([, node]) => !node).map(([key]) => key);
    if (missing.length) throw new Error(`Missing elements: ${missing.join(", ")}`);
    return { count: Object.keys(el).length };
  });

  await check("voices-populated", () => {
    const count = el.voice.options.length;
    if (count === 0) throw new Error("Voice dropdown is empty");
    return { count, selected: el.voice.value };
  });

  await check("collections-populated", async () => {
    // The dropdown must REFLECT the account's real collections, whatever that
    // number is -- including ZERO. A fresh install with no collections yet is a
    // valid state (the app defaults to local-KB mode and needs no collection),
    // and no private default is injected anymore. So assert the option count
    // equals the account's live listCollections count: 0 == 0 passes, N == N
    // passes, and a MISMATCH (the dropdown does not reflect the account) still
    // goes RED -- which is what proves population actually works.
    const account = await withTimeout(listCollections((cmd) => slicc.exec(cmd)), 10000, "listCollections");
    const accountCount = account.length;
    const count = el.collectionSelect.options.length;
    if (count !== accountCount) {
      throw new Error(`Collection dropdown has ${count} option(s) but the account has ${accountCount} collection(s) -- dropdown does not reflect the account`);
    }
    return { count, accountCount, options: Array.from(el.collectionSelect.options).map((o) => o.value) };
  });

  await check("ephemeral-token-mint", async () => {
    const token = await withTimeout(mintEphemeralToken((cmd) => slicc.exec(cmd), 60), 15000, "mintEphemeralToken");
    if (!token.value || !token.value.startsWith("xai-realtime-client-secret-")) {
      throw new Error("Unexpected token shape");
    }
    // Deliberately do NOT log token.value itself -- only shape/length, to
    // prove the long-lived key never surfaces in page-JS-reachable state.
    return { valuePrefixOk: true, valueLength: token.value.length, expiresAt: token.expires_at };
  });

  await check("voice-preview-real-call-and-cache", async () => {
    // Exercises the REAL shared function the "Play preview" button itself
    // calls (getOrCreateVoicePreviewBytes) -- not a reimplementation of
    // its logic -- against the real TTS endpoint, using a throwaway cache
    // Map (never state.voicePreviewCache) so this can never collide with
    // or leave residue in whatever a real user has already generated.
    const cache = new Map();
    const voiceId = "helix"; // the configured interview voice, per config.json
    const text = "Self-test preview line — not a real interview.";
    const execCalls = [];
    const countingExec = async (cmd) => {
      execCalls.push(cmd);
      return slicc.exec(cmd);
    };

    const first = await getOrCreateVoicePreviewBytes(countingExec, cache, voiceId, text);
    if (first.fromCache) throw new Error("First request should not be a cache hit");
    if (execCalls.length !== 1) throw new Error(`Expected exactly 1 real request, got ${execCalls.length}`);
    const bytes = first.bytes;
    if (!(bytes instanceof Uint8Array) || bytes.length < 1000) {
      throw new Error(`Response too small to be real audio: ${bytes && bytes.length} bytes`);
    }
    // MP3 frame sync -- checking the bytes, not trusting a 200 (there is
    // no HTTP status visible here at all -- see tts-preview.js's own
    // header for why content-sniffing is the only option in this path).
    if (!(bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0)) {
      throw new Error(`Leading bytes don't look like an MP3 frame: 0x${bytes[0].toString(16)} 0x${bytes[1].toString(16)}`);
    }

    // Second request for the IDENTICAL (voiceId, text): must be served from
    // the cache -- zero additional real requests, and the exact same bytes
    // back (not just equal length/content -- the literal cached reference).
    const second = await getOrCreateVoicePreviewBytes(countingExec, cache, voiceId, text);
    if (!second.fromCache) throw new Error("Second identical request should be a cache hit");
    if (execCalls.length !== 1) throw new Error(`Cache hit should not call exec; total real requests now ${execCalls.length}`);
    if (second.bytes !== bytes) throw new Error("Cache did not return the exact same cached result");

    return {
      byteLength: bytes.length,
      leadingBytes: [bytes[0].toString(16), bytes[1].toString(16)],
      realRequestCount: execCalls.length,
      cacheHitOnSecondCall: second.fromCache,
    };
  });

  await check("agent-track-duration-matches-wallclock", async () => {
    // Regression check for a real bug: a MediaRecorder attached to
    // AudioPlayer#stream dropped stretches where nothing was enqueued
    // (the agent not speaking) instead of recording them as silence, so
    // agent.webm ended up on a shorter, different timeline than
    // human.webm -- a timestamp in one file did not correspond to the
    // same moment in the other (confirmed on real evidence: a 94.6s
    // session's agent.webm decoded to only 66.9s of audio). Simulates a
    // session's silence/speech/silence shape at a small scale (~1.6s
    // wall-clock, a real ~600ms silent gap before AND after a short
    // tone) and asserts the recorded blob's decoded duration tracks
    // wall-clock elapsed time within a small tolerance -- this is the
    // check that would have caught the original bug (it measured
    // ratio ~0.45-0.49, roughly half, both before AND after a first
    // attempted fix using a true-zero ConstantSourceNode, which is
    // itself proof the check discriminates a real fix from a plausible
    // non-fix: only the second fix -- a continuously-looped low-amplitude
    // noise buffer, see AudioPlayer's constructor -- brought the ratio to
    // ~0.97 across repeated runs).
    //
    // Uses a throwaway AudioContext (not state.audioCtx) so this never
    // interferes with a real session.
    const ctx = new AudioContext();
    try {
      const player = new AudioPlayer(ctx, 24000);
      const recorder = new MediaRecorder(player.stream, { mimeType: "audio/webm;codecs=opus" });
      const chunks = [];
      recorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunks.push(e.data); };
      const stopped = new Promise((resolve) => { recorder.onstop = resolve; });

      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const t0 = performance.now();
      recorder.start(100);
      await wait(600); // silence #1 -- nothing enqueued
      // ~200ms tone so there is real signal in the middle
      const n = Math.round(0.2 * 24000);
      const tone = new Float32Array(n);
      for (let i = 0; i < n; i++) tone[i] = Math.sin((2 * Math.PI * 440 * i) / 24000) * 0.2;
      player.enqueueFloat32(tone);
      await wait(400); // covers the ~200ms tone plus margin
      await wait(600); // silence #2
      recorder.stop();
      await stopped;
      const wallClockMs = performance.now() - t0;

      const blob = new Blob(chunks, { type: "audio/webm;codecs=opus" });
      const arrayBuf = await blob.arrayBuffer();
      const decoded = await ctx.decodeAudioData(arrayBuf.slice(0)); // slice: decodeAudioData detaches the buffer
      const decodedMs = decoded.duration * 1000;
      const ratio = decodedMs / wallClockMs;

      // Tolerance: +/-15% comfortably covers normal MediaRecorder chunk-
      // boundary/container-timestamp jitter (measured ~0.97 across
      // repeated real runs) while still reliably catching a regression
      // back to the original bug's ~0.45-0.49 ratio.
      if (ratio < 0.85 || ratio > 1.15) {
        throw new Error(
          `agent track duration diverged from wall-clock time: recorded ${Math.round(decodedMs)}ms of audio for ${Math.round(wallClockMs)}ms elapsed (ratio ${ratio.toFixed(3)}) -- silence is likely being dropped again`
        );
      }

      return {
        wallClockMs: Math.round(wallClockMs),
        decodedMs: Math.round(decodedMs),
        ratio: +ratio.toFixed(3),
        chunkCount: chunks.length,
        blobBytes: blob.size,
      };
    } finally {
      await ctx.close();
    }
  });

  await check("chunk-flush-assembles-byte-identical-valid-webm", async () => {
    // The load-bearing claim of lib/chunk-flusher.js: a file assembled by
    // byte-wise concatenation of ordered MediaRecorder timeslice parts is
    // EXACTLY the bytes `new Blob(chunks)` produced before, and is a
    // structurally valid WebM. Both are asserted here against a REAL
    // MediaRecorder recording a REAL (synthetic) media stream, through the
    // REAL createChunkFlusher and the REAL slicc bridge -- not a fake.
    //
    // Scratch lives under /tmp; nothing here touches sessions/.
    const scratch = `/tmp/im-selftest-flush-${Date.now()}`;
    const ctxA = new AudioContext({ sampleRate: 24000 });
    let flusher = null;
    try {
      // A canvas captureStream + an oscillator gives a real A/V stream with no
      // camera or microphone permission involved.
      const canvas = document.createElement("canvas");
      canvas.width = 160;
      canvas.height = 120;
      const g2d = canvas.getContext("2d");
      let frame = 0;
      const paint = setInterval(() => {
        frame++;
        g2d.fillStyle = frame % 2 ? "#123456" : "#654321";
        g2d.fillRect(0, 0, 160, 120);
        g2d.fillStyle = "#fff";
        g2d.fillRect((frame * 7) % 150, 10, 10, 10);
      }, 33);
      const vStream = canvas.captureStream(30);
      const osc = ctxA.createOscillator();
      const dest = ctxA.createMediaStreamDestination();
      osc.frequency.value = 440;
      osc.connect(dest);
      osc.start();
      const stream = new MediaStream([...vStream.getVideoTracks(), ...dest.stream.getAudioTracks()]);

      const rec = new TrackRecorder(stream, ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"], 250);
      flusher = createChunkFlusher({
        slicc,
        withTimeout,
        partsDir: `${scratch}/parts`,
        name: "selftest",
        onDiagnostic: (stage, detail) => window.__imDiag && window.__imDiag(stage, detail),
        // 64 KB target so a ~2 s recording still produces SEVERAL parts --
        // a single-part assembly would prove nothing about ordering.
        targetPartBytes: 64 * 1024,
      });
      rec.attachFlusher(flusher);
      rec.start();
      await new Promise((r) => setTimeout(r, 2200));
      const blob = await rec.stop();
      clearInterval(paint);
      osc.stop();
      for (const t of stream.getTracks()) t.stop();

      if (!blob || blob.size < 2000) throw new Error(`recording too small to be real: ${blob && blob.size} bytes`);

      // --- assemble through the real module ------------------------------
      const destPath = `${scratch}/assembled.webm`;
      const asm = await flusher.assemble(destPath);
      const stats = flusher.getStats();
      if (!asm.ok) throw new Error(`assembly failed: ${asm.reason || asm.method} (${JSON.stringify(stats)})`);
      if (stats.partsWritten < 2) throw new Error(`expected multiple parts, got ${stats.partsWritten} -- ordering is untested with one part`);
      // The exec path is the entire memory argument for this design: it keeps
      // every byte out of the JS heap. The page-side fallback works but
      // reintroduces the whole-file spike, so silently taking it is a real
      // regression (it already happened once, via a broken xargs -0).
      if (asm.method !== "exec-cat") {
        throw new Error(`assembly took the degraded "${asm.method}" path instead of exec-cat`);
      }

      // --- PROOF 1: byte-identical to the old whole-blob path ------------
      const expected = new Uint8Array(await blob.arrayBuffer());
      const actual = await slicc.readFileBinary(destPath);
      const got = actual instanceof Uint8Array ? actual : new Uint8Array(actual);
      if (got.length !== expected.length) {
        throw new Error(`assembled length ${got.length} != Blob length ${expected.length}`);
      }
      let firstDiff = -1;
      for (let i = 0; i < expected.length; i++) {
        if (got[i] !== expected[i]) {
          firstDiff = i;
          break;
        }
      }
      if (firstDiff !== -1) throw new Error(`assembled bytes differ from the Blob at offset ${firstDiff}`);

      // --- PROOF 2: structural WebM validity (EBML walk) -----------------
      // `remotion inspect` cannot parse VP9-in-WebM (media-parser limitation:
      // "cannot handle the private data for VP9"), so validity is established
      // structurally instead: walk the real EBML element tree and require the
      // header, Segment, Tracks and at least one Cluster with SimpleBlocks.
      const dv = new DataView(got.buffer, got.byteOffset, got.byteLength);
      const readVint = (pos, keepMarker) => {
        const b0 = got[pos];
        if (b0 === 0) throw new Error(`invalid VINT at ${pos}`);
        let len = 1;
        for (let m = 0x80; m > 0 && !(b0 & m); m >>= 1) len++;
        let val = keepMarker ? b0 : b0 & (0xff >> len);
        for (let i = 1; i < len; i++) val = val * 256 + got[pos + i];
        return { val, len };
      };
      // EBML magic
      if (!(got[0] === 0x1a && got[1] === 0x45 && got[2] === 0xdf && got[3] === 0xa3)) {
        throw new Error(`missing EBML magic: ${[...got.slice(0, 4)].map((b) => b.toString(16)).join(" ")}`);
      }
      const found = { ebmlHeader: false, segment: false, tracks: false, clusters: 0, simpleBlocks: 0, unknownSizeSegment: false };
      const walk = (start, end, depth) => {
        let p = start;
        while (p < end - 1 && depth < 4) {
          const id = readVint(p, true);
          const sz = readVint(p + id.len, false);
          const contentStart = p + id.len + sz.len;
          // An "unknown size" element (all size bits set) runs to the end --
          // MediaRecorder emits exactly this for the live Segment.
          const maxSizeVal = 2 ** (7 * sz.len) - 1;
          const unknown = sz.val === maxSizeVal;
          const contentEnd = unknown ? end : Math.min(end, contentStart + sz.val);
          if (id.val === 0x1a45dfa3) found.ebmlHeader = true;
          if (id.val === 0x18538067) {
            found.segment = true;
            if (unknown) found.unknownSizeSegment = true;
            walk(contentStart, contentEnd, depth + 1);
          } else if (id.val === 0x1654ae6b) {
            found.tracks = true;
          } else if (id.val === 0x1f43b675) {
            found.clusters++;
            let q = contentStart;
            while (q < contentEnd - 1) {
              const cid = readVint(q, true);
              const csz = readVint(q + cid.len, false);
              if (cid.val === 0xa3 || cid.val === 0xa0) found.simpleBlocks++;
              const next = q + cid.len + csz.len + csz.val;
              if (next <= q) break;
              q = next;
            }
          }
          if (contentEnd <= p) break;
          p = unknown ? contentEnd : contentStart + sz.val;
        }
      };
      walk(0, got.length, 0);
      if (!found.ebmlHeader) throw new Error("no EBML header element");
      if (!found.segment) throw new Error("no Segment element");
      if (!found.tracks) throw new Error("no Tracks element");
      if (found.clusters < 1) throw new Error("no Cluster elements -- file carries no media");
      if (found.simpleBlocks < 10) throw new Error(`only ${found.simpleBlocks} blocks -- too few to be a real 2 s recording`);

      // --- PROOF 3: the browser itself will decode it --------------------
      // Structure is necessary but not sufficient, so also require a real
      // decode: load the assembled bytes into a <video> and read its duration.
      const url = URL.createObjectURL(new Blob([got], { type: rec.mimeType }));
      let decoded = null;
      try {
        decoded = await new Promise((resolve, reject) => {
          const v = document.createElement("video");
          v.preload = "metadata";
          v.muted = true;
          const done = setTimeout(() => reject(new Error("video metadata never loaded")), 8000);
          v.onloadedmetadata = () => {
            clearTimeout(done);
            resolve({ duration: v.duration, videoWidth: v.videoWidth, videoHeight: v.videoHeight });
          };
          v.onerror = () => {
            clearTimeout(done);
            reject(new Error(`video decode error: ${v.error && v.error.code}`));
          };
          v.src = url;
        });
      } finally {
        URL.revokeObjectURL(url);
      }
      // MediaRecorder's live WebM has an unknown-size Segment and no Duration
      // element, so duration is legitimately Infinity/NaN until fully buffered.
      // Dimensions are the real assertion that a decoder parsed the tracks.
      if (decoded.videoWidth !== 160 || decoded.videoHeight !== 120) {
        throw new Error(`decoder reported ${decoded.videoWidth}x${decoded.videoHeight}, expected 160x120`);
      }

      // Cleanup must actually work: the bridge's rm ignores
      // { recursive: true } (ENOTEMPTY), so a naive cleanup silently leaks
      // every session's part files under /tmp. Assert it, don't hope.
      const cleaned = await flusher.cleanup();
      if (!cleaned) throw new Error("flusher.cleanup() reported failure -- part files would leak on every save");
      const leftover = await slicc.readDir(`${scratch}/parts`).catch(() => null);
      if (leftover && leftover.length) {
        throw new Error(`cleanup left ${leftover.length} part file(s) behind`);
      }
      await slicc.exec(`rm -rf ${scratch}`).catch(() => {});

      return {
        mimeType: rec.mimeType,
        blobBytes: expected.length,
        assembledBytes: got.length,
        byteIdentical: true,
        method: asm.method,
        parts: stats.partsWritten,
        chunksFlushed: stats.chunksFlushed,
        retries: stats.retries,
        peakPendingBytes: stats.peakPendingBytes,
        ebml: found,
        decoded,
      };
    } finally {
      try {
        await ctxA.close();
      } catch (err) {
        /* best effort */
      }
      try {
        // exec rm -rf, not slicc.rm(..., {recursive:true}) -- see cleanup()
        await slicc.exec(`rm -rf ${scratch}`);
      } catch (err) {
        /* best effort */
      }
    }
  });

  await check("chunk-flush-retries-transient-and-degrades-cleanly", async () => {
    // Two things the flush path must do, proven with a fake bridge so the
    // failures are deterministic:
    //   (a) a NotReadableError (the PR #2924 ZenFS snapshot-invalidation
    //       fault, which more concurrent VFS traffic makes more likely)
    //       is RETRIED, and the retry is COUNTED, not swallowed;
    //   (b) a permanently failing part poisons the sequence so assemble()
    //       refuses rather than producing a file with a hole in it.
    const diags = [];
    const onDiagnostic = (stage, detail) => diags.push({ stage, detail });

    // (a) fail the first write with NotReadableError, then succeed.
    const writes = [];
    let failuresLeft = 1;
    const flakyBridge = {
      mkdir: async () => {},
      rm: async () => true,
      stat: async (p) => ({ size: writes.reduce((a, w) => a + w.bytes, 0) }),
      readDir: async () => writes.map((w) => w.name),
      readFileBinary: async () => new Uint8Array(0),
      writeFileBinary: async (p, b) => {
        if (failuresLeft > 0) {
          failuresLeft--;
          const err = new Error("The requested file could not be read");
          err.name = "NotReadableError";
          throw err;
        }
        writes.push({ name: p.split("/").pop(), bytes: b.length });
      },
      exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    };
    const f1 = createChunkFlusher({
      slicc: flakyBridge,
      withTimeout,
      partsDir: "/tmp/__selftest_never_written__/a",
      name: "flaky",
      onDiagnostic,
      targetPartBytes: 1,
      retryBackoffMs: 1,
    });
    f1.append(new Blob([new Uint8Array(64)]));
    const s1 = await f1.settle();
    if (s1.retries !== 1) throw new Error(`expected exactly 1 counted retry, got ${s1.retries}`);
    if (s1.failedParts !== 0) throw new Error(`retry should have recovered the part, failedParts=${s1.failedParts}`);
    if (!f1.isUsable()) throw new Error("a recovered retry must leave the sequence usable");
    const retryDiag = diags.filter((d) => d.stage === "chunk-flush:retry");
    if (retryDiag.length !== 1) throw new Error(`retry must be reported in diagnostics, saw ${retryDiag.length} entries`);
    if (retryDiag[0].detail.errorName !== "NotReadableError") {
      throw new Error(`diagnostic lost the error name: ${JSON.stringify(retryDiag[0].detail)}`);
    }
    const succeeded = diags.filter((d) => d.stage === "chunk-flush:retry-succeeded");
    if (succeeded.length !== 1) throw new Error("a recovered retry must also be reported as recovered");

    // (b) a permanently failing write must poison the sequence.
    const deadBridge = {
      ...flakyBridge,
      writeFileBinary: async () => {
        const err = new Error("The requested file could not be read");
        err.name = "NotReadableError";
        throw err;
      },
    };
    const f2 = createChunkFlusher({
      slicc: deadBridge,
      withTimeout,
      partsDir: "/tmp/__selftest_never_written__/b",
      name: "dead",
      onDiagnostic,
      targetPartBytes: 1,
      retryBackoffMs: 1,
    });
    f2.append(new Blob([new Uint8Array(64)]));
    const s2 = await f2.settle();
    if (s2.failedParts !== 1) throw new Error(`expected 1 failed part, got ${s2.failedParts}`);
    if (s2.retries !== 2) throw new Error(`expected 2 retries before giving up (3 attempts), got ${s2.retries}`);
    if (f2.isUsable()) throw new Error("an incomplete part sequence must NOT report itself usable");
    const asm = await f2.assemble("/tmp/__selftest_never_written__/out.webm");
    if (asm.ok) throw new Error("assemble() must refuse an incomplete part sequence");
    if (asm.method !== "none") throw new Error(`expected method "none", got ${asm.method}`);
    if (!diags.some((d) => d.stage === "chunk-flush:assemble-skipped")) {
      throw new Error("a refused assembly must be reported");
    }

    // (c) backpressure must bound memory rather than queue without limit.
    const stalled = { ...flakyBridge, writeFileBinary: () => new Promise(() => {}) };
    const f3 = createChunkFlusher({
      slicc: stalled,
      withTimeout,
      partsDir: "/tmp/__selftest_never_written__/c",
      name: "stalled",
      onDiagnostic,
      maxPendingBytes: 4096,
      partWriteTimeoutMs: 50,
      retryBackoffMs: 1,
    });
    for (let i = 0; i < 20; i++) f3.append(new Blob([new Uint8Array(1024)]));
    const s3 = f3.getStats();
    if (s3.peakPendingBytes > 4096 + 1024) {
      throw new Error(`pending bytes exceeded the cap: ${s3.peakPendingBytes} > ${4096 + 1024}`);
    }
    if (s3.droppedForBackpressure < 1) throw new Error("backpressure never engaged despite a stalled bridge");
    if (!diags.some((d) => d.stage === "chunk-flush:backpressure")) throw new Error("backpressure must be reported");

    return {
      retryRecovered: { retries: s1.retries, usable: true },
      permanentFailure: { failedParts: s2.failedParts, retries: s2.retries, assembleRefused: true },
      backpressure: { peakPendingBytes: s3.peakPendingBytes, dropped: s3.droppedForBackpressure },
      diagnosticStages: [...new Set(diags.map((d) => d.stage))].sort(),
    };
  });

  await check("collapsible-expands-and-collapses", async () => {
    // Blind spot this closes: the suite passed 39/39 while the "Create a new
    // collection from a folder" disclosure did not visibly open or close.
    // Cause was a CSS cascade collision, invisible to any check that only
    // looked at ids/handlers: the framework hides the body with
    // `.sprinkle-collapsible__body { display: none }` (specificity 0,1,0) and
    // our `.im-stack { display: flex }` (also 0,1,0) won on cascade order, so
    // the body was permanently shown. Asserts the RESOLVED display in both
    // states, which is the only thing that would have caught it.
    const wrap = document.getElementById("im-create-collection");
    if (!wrap) throw new Error("#im-create-collection missing");
    const body = wrap.querySelector(".sprinkle-collapsible__body");
    const header = wrap.querySelector(".sprinkle-collapsible__header");
    if (!body) throw new Error("collapsible body missing");
    if (!header) throw new Error("collapsible header missing");

    // Structural guard against the exact regression: our layout class must not
    // sit on the element whose display the framework controls.
    if (body.classList.contains("im-stack")) {
      throw new Error("`im-stack` is back on .sprinkle-collapsible__body -- its display:flex overrides the framework's display:none and the disclosure will never collapse");
    }

    const startedOpen = wrap.classList.contains("sprinkle-collapsible--open");
    try {
      wrap.classList.remove("sprinkle-collapsible--open");
      const closed = getComputedStyle(body).display;
      wrap.classList.add("sprinkle-collapsible--open");
      const opened = getComputedStyle(body).display;

      if (closed !== "none") throw new Error(`collapsed body computed display "${closed}", expected "none"`);
      if (opened === "none") throw new Error(`expanded body computed display "${opened}", expected something visible`);

      // The header's inline onclick is what a user actually triggers; prove it
      // still flips the class (not just that the CSS responds to the class).
      wrap.classList.remove("sprinkle-collapsible--open");
      header.click();
      const afterClick = wrap.classList.contains("sprinkle-collapsible--open");
      if (!afterClick) throw new Error("clicking the collapsible header did not add sprinkle-collapsible--open");
      const displayAfterClick = getComputedStyle(body).display;
      if (displayAfterClick === "none") throw new Error("body still display:none after a real header click");
      header.click();
      if (wrap.classList.contains("sprinkle-collapsible--open")) throw new Error("second header click did not collapse it again");
      if (getComputedStyle(body).display !== "none") throw new Error("body did not return to display:none after collapsing");

      return { closed, opened, displayAfterClick, headerClickToggles: true, bodyClasses: Array.from(body.classList) };
    } finally {
      if (startedOpen) wrap.classList.add("sprinkle-collapsible--open");
      else wrap.classList.remove("sprinkle-collapsible--open");
    }
  });

  await check("device-dropdowns-populated", async () => {
    // Blind spot this closes: the mic/camera <select>s showed only their
    // "Microphone…"/"Camera…" placeholders because populateDeviceLists() was
    // reachable only from inside onEnableDevices(), i.e. only after the user
    // pressed a button. Nothing asserted the selects ever held real devices.
    // Compares the RAW enumerateDevices result against what the DOM shows, so
    // "the platform returned nothing" and "we failed to render it" cannot be
    // confused -- they are different bugs with different fixes.
    if (!(navigator.mediaDevices && navigator.mediaDevices.enumerateDevices)) {
      return { skipped: "navigator.mediaDevices.enumerateDevices unavailable" };
    }
    const devices = await withTimeout(navigator.mediaDevices.enumerateDevices(), 8000, "enumerateDevices");
    const audioIn = devices.filter((d) => d.kind === "audioinput");
    const videoIn = devices.filter((d) => d.kind === "videoinput");
    // Labels are empty strings until a permission is granted; without them
    // there is nothing meaningful to render and the placeholder is correct.
    const labelled = devices.some((d) => (d.label || "").length > 0);
    const detail = {
      rawTotal: devices.length,
      audioInputs: audioIn.length,
      videoInputs: videoIn.length,
      anyLabels: labelled,
      micOptions: el.micSelect.options.length,
      camOptions: el.camSelect.options.length,
    };
    if (!labelled) {
      // Legitimate state, not a failure: assert we degrade to the placeholder
      // rather than rendering blank rows.
      if (el.micSelect.options.length > 1 || el.camSelect.options.length > 1) {
        throw new Error(`no device labels available yet, but the selects hold ${el.micSelect.options.length}/${el.camSelect.options.length} options`);
      }
      return { ...detail, note: "no permission yet -- placeholders retained, which is correct" };
    }
    // Labels exist, so init must have rendered them.
    if (audioIn.length > 0 && el.micSelect.options.length < audioIn.length) {
      throw new Error(`enumerateDevices reported ${audioIn.length} microphones but the select holds only ${el.micSelect.options.length} options -- populateDeviceLists() did not run at init`);
    }
    if (videoIn.length > 0 && el.camSelect.options.length < videoIn.length) {
      throw new Error(`enumerateDevices reported ${videoIn.length} cameras but the select holds only ${el.camSelect.options.length} options -- populateDeviceLists() did not run at init`);
    }
    if (el.micSelect.options.length === 0 || el.camSelect.options.length === 0) {
      throw new Error("a device select is completely empty -- not even a placeholder");
    }
    return detail;
  });

  await check("test-search-guard-reports-instead-of-silence", async () => {
    // Blind spot this closes: clicking "Test search" with an empty query hit a
    // bare `return` BEFORE any DOM write, so the button was
    // indistinguishable from a dead control and logged nothing. Drives the
    // REAL onTestSearch and the REAL button click; asserts visible feedback
    // AND a diagnostic, since the missing diagnostic is what made the original
    // report unfixable from a session artifact.
    const beforeQuery = el.testQuery.value;
    const beforeResults = el.testResults.innerHTML;
    const diagLenBefore = (window.__IM_DIAG__ || []).length;
    try {
      // (a) empty query -- must explain itself, must not silently no-op
      el.testQuery.value = "   ";
      el.testResults.innerHTML = "";
      await onTestSearch();
      const emptyFeedback = el.testResults.textContent.trim();
      if (!emptyFeedback) throw new Error("empty-query click produced no feedback at all (the original silent-return bug)");
      const diags = (window.__IM_DIAG__ || []).slice(diagLenBefore);
      const skipDiag = diags.find((d) => d.stage === "test-search-skipped");
      if (!skipDiag) throw new Error(`empty-query click logged no "test-search-skipped" diagnostic; stages seen: ${diags.map((d) => d.stage).join(",") || "(none)"}`);
      if (skipDiag.detail.reason !== "empty-query") throw new Error(`wrong skip reason: ${JSON.stringify(skipDiag.detail)}`);

      // (b) the real button, via a real click, must reach the same guard --
      //     proving the listener is actually attached.
      el.testResults.innerHTML = "";
      el.testQuery.value = "";
      el.testSearchBtn.click();
      await new Promise((r) => setTimeout(r, 60));
      const clickFeedback = el.testResults.textContent.trim();
      if (!clickFeedback) throw new Error("a real click on #im-test-search-btn produced no feedback -- the handler may not be wired");

      return { emptyFeedback, clickFeedback, skipReason: skipDiag.detail.reason };
    } finally {
      el.testQuery.value = beforeQuery;
      el.testResults.innerHTML = beforeResults;
    }
  });

  await check("zero-frame-detection-rejects-frameless-stream", async () => {
    // The single most important guard in the multi-camera path. DESIGN.md
    // measured ~4% of camera opens (8/160 on the Studio Display cameras)
    // returning a stream that resolves in 33-54 ms with readyState "live",
    // muted false, active true and a plausible 1920x1080@30 from
    // getSettings() -- and never delivers a frame. NO PROPERTY DETECTS IT.
    // Without frame-read detection roughly one interview in five silently
    // records a 0-byte angle.
    //
    // Proven here against a stream that is PROVABLY frameless rather than a
    // real misbehaving camera: canvas.captureStream(0) produces frames only on
    // an explicit requestFrame(), so the track is live but starved -- exactly
    // the shape of the real fault.
    if (typeof MediaStreamTrackProcessor === "undefined") {
      throw new Error("MediaStreamTrackProcessor unavailable -- the zero-frame watchdog cannot work at all in this runtime");
    }
    const mkCanvas = () => {
      const c = document.createElement("canvas");
      c.width = 64;
      c.height = 48;
      const g = c.getContext("2d");
      g.fillStyle = "#123456";
      g.fillRect(0, 0, 64, 48);
      return { c, g };
    };

    // (a) STARVED track: live, but no frame will ever arrive.
    // MeasuredTrackGenerator is the clean fixture (a track nobody writes to).
    // canvas.captureStream(0) is NOT frameless -- it emits one initial frame at
    // timestamp 0 and then stops, which this check caught on its first run --
    // so with that fallback the initial frame is drained first and the NEXT
    // read is what must time out. Either way the track stays "live".
    let starvedResult;
    let starvedProps;
    let starvedFixture;
    if (typeof MediaStreamTrackGenerator !== "undefined") {
      starvedFixture = "MediaStreamTrackGenerator (never written to)";
      const gen = new MediaStreamTrackGenerator({ kind: "video" });
      try {
        starvedProps = { readyState: gen.readyState, muted: gen.muted, enabled: gen.enabled, settings: gen.getSettings() };
        const probe = openFrameReader(gen);
        starvedResult = await probe.firstFrame(600);
        try {
          await probe.reader.cancel();
        } catch (e) {
          /* ignore */
        }
      } finally {
        gen.stop();
      }
    } else {
      starvedFixture = "canvas.captureStream(0), initial frame drained";
      const starved = mkCanvas();
      const starvedStream = starved.c.captureStream(0);
      const starvedTrack = starvedStream.getVideoTracks()[0];
      try {
        starvedProps = { readyState: starvedTrack.readyState, muted: starvedTrack.muted, enabled: starvedTrack.enabled, settings: starvedTrack.getSettings() };
        const probe = openFrameReader(starvedTrack);
        const initial = await probe.firstFrame(1500);
        if (initial === "TIMEOUT") throw new Error("fixture invalid: captureStream(0) produced no initial frame at all");
        starvedResult = await probe.firstFrame(600);
        try {
          await probe.reader.cancel();
        } catch (e) {
          /* ignore */
        }
      } finally {
        for (const t of starvedStream.getTracks()) t.stop();
      }
    }
    // The point of the whole exercise: the PROPERTIES look healthy.
    if (starvedProps.readyState !== "live") throw new Error(`fixture invalid: starved track readyState "${starvedProps.readyState}", expected "live" (it must LOOK healthy for this test to mean anything)`);
    if (starvedProps.muted !== false) throw new Error("fixture invalid: starved track reports muted -- a property would then detect it and the test proves nothing");
    if (starvedResult !== "TIMEOUT") {
      throw new Error(`frameless stream was NOT detected: firstFrame() returned ${JSON.stringify(starvedResult)} instead of "TIMEOUT"`);
    }

    // (b) HEALTHY track: a real animated canvas must be accepted, so the
    //     watchdog cannot pass by rejecting everything.
    const live = mkCanvas();
    const liveStream = live.c.captureStream(30);
    const liveTrack = liveStream.getVideoTracks()[0];
    const paint = setInterval(() => {
      live.g.fillStyle = `hsl(${Date.now() % 360} 50% 40%)`;
      live.g.fillRect(0, 0, 64, 48);
    }, 20);
    let liveResult;
    try {
      const probe2 = openFrameReader(liveTrack);
      liveResult = await probe2.firstFrame(3000);
      try {
        await probe2.reader.cancel();
      } catch (e) {
        /* ignore */
      }
    } finally {
      clearInterval(paint);
      for (const t of liveStream.getTracks()) t.stop();
    }
    if (liveResult === "TIMEOUT" || liveResult == null) {
      throw new Error("a healthy animated canvas track was rejected as frameless -- the watchdog would retry every good camera to exhaustion");
    }

    return {
      starvedFixture,
      starvedLooksHealthy: starvedProps,
      starvedDetectedAs: starvedResult,
      healthyFirstFrameTsUs: liveResult,
      watchdogTimeoutMs: FIRST_FRAME_TIMEOUT_MS,
    };
  });

  await check("camera-recorder-muxes-shared-audio-into-every-file", async () => {
    // DESIGN.md section 4: one shared mic track muxed into every camera file is
    // what makes cross-angle alignment exact for free (decoded PCM measured
    // byte-identical, same MD5, across all five files at 5-minute scale). If a
    // camera recorder ever stops carrying the audio track, alignment silently
    // degrades to container timestamps, which carry no absolute time.
    //
    // Uses the REAL createCameraRecorder against synthetic A/V so no camera is
    // opened, and asserts the track actually reaches the recorded stream.
    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 48;
    const g = canvas.getContext("2d");
    const paint = setInterval(() => {
      g.fillStyle = `hsl(${Date.now() % 360} 50% 40%)`;
      g.fillRect(0, 0, 64, 48);
    }, 25);
    const vStream = canvas.captureStream(30);
    const actx = new AudioContext({ sampleRate: 48000 });
    try {
      const osc = actx.createOscillator();
      const dest = actx.createMediaStreamDestination();
      osc.connect(dest);
      osc.start();
      const sharedAudioTrack = dest.stream.getAudioTracks()[0];
      const videoTrack = vStream.getVideoTracks()[0];

      const rec = createCameraRecorder(videoTrack, sharedAudioTrack, { videoBitsPerSecond: 300_000 });
      const recorded = rec.recorder.stream;
      const vCount = recorded.getVideoTracks().length;
      const aCount = recorded.getAudioTracks().length;
      if (vCount !== 1) throw new Error(`camera recorder stream has ${vCount} video tracks, expected 1`);
      if (aCount !== 1) throw new Error("camera recorder stream carries NO audio track -- the shared sync signal is missing from this angle");
      if (recorded.getAudioTracks()[0] !== sharedAudioTrack) {
        throw new Error("camera recorder muxed a DIFFERENT audio track than the shared one -- angles would not be sample-aligned");
      }
      // The hero recorder must be left alone: its options are the ones the
      // single-camera path has always used.
      const heroStream = new MediaStream([videoTrack, sharedAudioTrack]);
      const hero = createHumanRecorder(heroStream);
      if (hero.recorder.audioBitsPerSecond === rec.recorder.audioBitsPerSecond) {
        // Not fatal, but the design deliberately raises angle audio to 128k
        // because in a multi-angle recording that track IS the sync signal.
        // Flag only if BOTH are the hero's old 64k, which would mean the
        // camera-recorder options never applied.
        if (rec.recorder.audioBitsPerSecond === 64000) throw new Error("createCameraRecorder did not apply its own audioBitsPerSecond (still 64k)");
      }
      // Prove it actually records with audio, not just that the stream is shaped right.
      rec.start();
      await new Promise((r) => setTimeout(r, 900));
      const blob = await rec.stop();
      if (!blob || blob.size < 500) throw new Error(`camera recorder produced ${blob && blob.size} bytes`);

      return {
        videoTracks: vCount,
        audioTracks: aCount,
        sameSharedTrack: true,
        angleAudioBitsPerSecond: rec.recorder.audioBitsPerSecond,
        heroAudioBitsPerSecond: hero.recorder.audioBitsPerSecond,
        mimeType: rec.mimeType,
        blobBytes: blob.size,
      };
    } finally {
      clearInterval(paint);
      for (const t of vStream.getTracks()) t.stop();
      try {
        await actx.close();
      } catch (e) {
        /* ignore */
      }
    }
  });

  await check("sync-json-has-an-entry-per-stream", async () => {
    // sync.json is the only alignment record: WebM carries no absolute time, so
    // without one entry per written file (with the MEASURED fps, because
    // getSettings() lies -- Studio Display cameras have been measured at 24.2
    // fps while reporting 30) a multi-angle session cannot be laid on a common
    // timeline. Drives the REAL writeSessionArtifacts into a /tmp scratch root
    // via the internal sessions-root override, so this exercises the production
    // save path rather than a reimplementation.
    const root = `/tmp/im-selftest-sync-${Date.now()}`;
    const snapshot = {};
    for (const k of ["t0", "humanBlob", "agentBlob", "humanRecorder", "agentRecorder", "flushers", "cameras", "syncInfo", "transcript", "config", "kb", "lastSessionConfig", "sessionDir"]) snapshot[k] = state[k];
    try {
      const t0 = Date.now();
      state.t0 = t0;
      state.humanBlob = null;
      state.agentBlob = null;
      state.humanRecorder = null;
      state.agentRecorder = null;
      state.flushers = {};
      state.cameras = [];
      state.transcript = new TranscriptStore(t0);
      state.config = { voice: "helix", topic: "sync check", kbMode: "collection", kbPath: null, collectionId: null, webSearch: false, xSearch: false };
      state.kb = { files: [] };
      state.lastSessionConfig = { selftest: true };
      state.syncInfo = {
        version: 1,
        recorderStartWallMs: t0,
        recorderStartSpreadMs: 0.09,
        timebase: "VideoFrame.timestamp (us), monotonic, shared across devices",
        audio: { shared: true, deviceLabel: "selftest", sampleRate: 48000, channels: 1 },
        cameras: [
          { role: "main", file: "human.webm", firstFrameTsUs: 1000, offsetMs: 0, measuredAvgFps: 30.1, frames: 301, openAttempts: 1, bytes: 1 },
          { role: "angle1", file: "video/angle1.webm", firstFrameTsUs: 12000, offsetMs: 11, measuredAvgFps: 30.11, frames: 300, openAttempts: 1, bytes: 1 },
        ],
      };

      setSessionsRoot(root);
      await writeSessionArtifacts(Date.now(), 1000, "selftest-sync");
      const dir = state.sessionDir;
      if (!dir || !dir.startsWith(root)) throw new Error(`sessions-root override ignored: wrote to ${dir}`);

      const raw = await slicc.readFile(`${dir}/sync.json`);
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed.cameras)) throw new Error("sync.json has no cameras array");
      if (parsed.cameras.length !== state.syncInfo.cameras.length) {
        throw new Error(`sync.json has ${parsed.cameras.length} camera entries, expected ${state.syncInfo.cameras.length}`);
      }
      for (const c of parsed.cameras) {
        for (const field of ["role", "file", "firstFrameTsUs", "offsetMs", "measuredAvgFps"]) {
          if (c[field] === undefined || c[field] === null) throw new Error(`sync.json camera "${c.role}" is missing ${field}`);
        }
      }
      if (!parsed.audio || parsed.audio.shared !== true) throw new Error("sync.json does not record a shared audio track");
      // The hero must still be named human.webm at the top level.
      const main = parsed.cameras.find((c) => c.role === "main");
      if (!main || main.file !== "human.webm") throw new Error(`hero entry must be human.webm, got ${main && main.file}`);
      return { dir, cameras: parsed.cameras.length, files: parsed.cameras.map((c) => c.file), audioShared: parsed.audio.shared };
    } finally {
      setSessionsRoot(null);
      Object.assign(state, snapshot);
      try {
        await slicc.exec(`rm -rf ${root}`);
      } catch (e) {
        /* best effort */
      }
    }
  });

  await check("waitfordrain-timeout-cap", async () => {
    // Proves the fix for a real audit finding: waitForDrain() previously
    // had no cap and could hang forever if the AudioContext ever stalled.
    // Uses a throwaway AudioContext (not state.audioCtx) so this never
    // interferes with a real session.
    const ctx = new AudioContext();
    try {
      const player = new AudioPlayer(ctx, 24000);
      player.playheadTime = ctx.currentTime + 999999; // pretend a huge amount is queued forever
      const t0 = performance.now();
      await player.waitForDrain(20, 400); // small cap so this check stays fast
      const elapsedMs = performance.now() - t0;
      if (elapsedMs > 2000) throw new Error(`waitForDrain did not respect its cap: took ${elapsedMs}ms`);
      return { elapsedMs, cappedAt: 400 };
    } finally {
      await ctx.close();
    }
  });

  await check("apply-config-updates-ui", () => {
    // Exercises the shared applyConfig() function directly with a
    // synthetic config object -- never touches the real config.json file
    // -- and restores every field it changes immediately, so this can
    // never be the thing that clobbers the user's real briefing.
    const before = {
      brief: el.brief.value,
      webSearch: el.webSearch.checked,
      xSearch: el.xSearch.checked,
      kbMode: el.kbMode.value,
      collectionId: el.collectionSelect.value,
    };
    try {
      applyConfig({ brief: "__selftest_probe_brief__", webSearch: false, xSearch: true, kbMode: "collection" });
      const applied = el.brief.value === "__selftest_probe_brief__" && el.webSearch.checked === false;
      if (!applied) throw new Error("applyConfig did not update the DOM");
      return { applied };
    } finally {
      applyConfig(before);
    }
  });

  await check("config-push-handler-applies-real-config", async () => {
    // Exercises the ACTUAL push handler (applyConfigPush(), the same
    // function `{"type":"reloadconfig"}` invokes) against the REAL
    // config.json -- read-only, never writes anything -- to verify the
    // handler wiring end to end without needing an actual `sprinkle send`
    // round-trip inside a self-test.
    const briefBefore = el.brief.value;
    await applyConfigPush();
    const statusText = el.setupStatus.textContent;
    if (!/Config updated from CLI/.test(statusText)) throw new Error(`Expected a "Config updated from CLI" status message, got: ${JSON.stringify(statusText)}`);
    return { statusText, briefUnchangedByPush: el.brief.value === briefBefore };
  });

  await check("brief-textarea-present", () => {
    if (el.brief.tagName !== "TEXTAREA") throw new Error(`#im-brief is a <${el.brief.tagName.toLowerCase()}>, expected <textarea>`);
    const before = el.brief.value;
    el.brief.value = "__selftest_probe__";
    const roundTrips = el.brief.value === "__selftest_probe__";
    el.brief.value = before;
    if (!roundTrips) throw new Error("textarea value did not round-trip");
    return { tag: el.brief.tagName, rows: el.brief.rows };
  });

  await check("brief-field-layout", () => {
    // A screenshot showed the "Briefing" label sitting oddly next to the
    // textarea rather than clearly above it. Check the REAL computed
    // layout rather than trust screenshot pixels (slicc.screenshot()'s
    // SVG-foreignObject clone has documented fidelity issues with form
    // controls) -- distinguishes an actual CSS bug from a rendering
    // artifact of the screenshot mechanism itself.
    const field = el.brief.closest(".im-field");
    if (!field) throw new Error("#im-brief is not inside a .im-field");
    const style = getComputedStyle(field);
    const labelEl = field.querySelector("label");
    if (style.display !== "flex" || style.flexDirection !== "column") {
      throw new Error(`.im-field computed as display:${style.display} flex-direction:${style.flexDirection}, expected flex/column`);
    }
    const labelRect = labelEl.getBoundingClientRect();
    const textareaRect = el.brief.getBoundingClientRect();
    const labelAboveTextarea = labelRect.bottom <= textareaRect.top + 1;
    if (!labelAboveTextarea) {
      throw new Error(`label bottom (${labelRect.bottom}) is not above textarea top (${textareaRect.top}) -- real layout bug, not just a screenshot artifact`);
    }
    return { display: style.display, flexDirection: style.flexDirection, labelAboveTextarea };
  });

  await check("button-slot-shows-exactly-one-button", () => {
    // The contract: "the enable camera button should sit where the start
    // interview button sits, and you replace one with the other". So the
    // failure this check exists to catch is BOTH buttons being visible at
    // once (which is exactly what the screen did before: two separate rows,
    // two separate buttons, both on screen), plus the layout shifting when
    // they swap. Measured from the REAL computed styles and rects, never
    // from a screenshot -- slicc.screenshot() is known to serialise this
    // sprinkle from parsed markup rather than live DOM state.
    const slot = el.btnSlot;
    if (!slot) throw new Error("#im-btn-slot is missing -- the single button slot markup is gone");
    if (document.getElementById("im-cam-note")) {
      throw new Error("#im-cam-note is back -- the camera status readout (enabled/model/resolution/deviceId) was deliberately deleted; the preview is the status");
    }
    for (const [name, btn] of [
      ["#im-enable-btn", el.enableBtn],
      ["#im-start-btn", el.startBtn],
    ]) {
      if (!btn) throw new Error(`${name} is missing`);
      const cell = btn.closest(".im-btn-slot__cell");
      if (!cell || cell.parentElement !== slot) {
        throw new Error(`${name} is not in a .im-btn-slot__cell directly inside #im-btn-slot -- both buttons must share ONE slot position`);
      }
      // The framework sets display:inline-flex on .sprinkle-btn. Hiding a
      // state by setting display on the BUTTON would be this file fighting
      // the framework over one property on one element -- the
      // .sprinkle-collapsible__body bug. The cell wrappers exist so that can
      // never happen; assert it stayed that way.
      if (btn.style.display) {
        throw new Error(`${name} has an inline display (${btn.style.display}) -- .sprinkle-btn's display belongs to the framework; toggle the .im-btn-slot__cell wrapper instead`);
      }
    }

    const isVisible = (node) => {
      const cs = getComputedStyle(node);
      if (cs.visibility === "hidden" || cs.opacity === "0") return false;
      for (let n = node; n && n !== document.documentElement; n = n.parentElement) {
        if (getComputedStyle(n).display === "none") return false;
      }
      return true;
    };
    const r2 = (v) => Number(v.toFixed(2));
    const rectOf = (node) => {
      const r = node.getBoundingClientRect();
      return { width: r2(r.width), height: r2(r.height), left: r2(r.left), right: r2(r.right), top: r2(r.top) };
    };

    const original = slot.hasAttribute("data-state") ? slot.getAttribute("data-state") : null;
    const snap = {};
    try {
      for (const [stateName, expected] of [
        ["enable", "enable"],
        ["ready", "start"],
      ]) {
        slot.dataset.state = stateName;
        const enableVisible = isVisible(el.enableBtn);
        const startVisible = isVisible(el.startBtn);
        if (enableVisible && startVisible) {
          throw new Error(`data-state="${stateName}" shows BOTH buttons at once -- one must REPLACE the other, never sit alongside it`);
        }
        const shown = enableVisible ? "enable" : startVisible ? "start" : "none";
        if (shown !== expected) {
          throw new Error(`data-state="${stateName}" shows "${shown}", expected "${expected}"`);
        }
        snap[stateName] = {
          shown,
          slot: rectOf(slot),
          button: rectOf(enableVisible ? el.enableBtn : el.startBtn),
        };
      }
    } finally {
      // Restore exactly what was there, including "no attribute at all".
      if (original === null) slot.removeAttribute("data-state");
      else slot.setAttribute("data-state", original);
    }

    // The no-layout-shift half needs real geometry, which needs this iframe
    // to actually be laid out. `sprinkle reload` leaves it 0x0 (slicc#2942),
    // so every rect can legitimately read 0 through no fault of this CSS --
    // in that case the exclusivity assertions above still hold (they are
    // computed-display based, not geometric) and this half reports
    // laidOut:false instead of failing for an environmental reason.
    const laidOut = snap.enable.slot.width > 0 && snap.ready.slot.width > 0;
    if (laidOut) {
      for (const key of ["width", "height", "left", "right"]) {
        const delta = Math.abs(snap.enable.slot[key] - snap.ready.slot[key]);
        if (delta > 0.5) {
          throw new Error(`slot ${key} changed by ${r2(delta)}px between the two states (${snap.enable.slot[key]} -> ${snap.ready.slot[key]}) -- swapping the buttons must not shift layout`);
        }
      }
      const wDelta = r2(Math.abs(snap.enable.button.width - snap.ready.button.width));
      if (wDelta > 0.5) {
        throw new Error(`the two buttons render ${wDelta}px apart in width (${snap.enable.button.width} vs ${snap.ready.button.width}) -- the shared min-width is what keeps the slot stable`);
      }
    }

    return { laidOut, restoredState: slot.dataset.state || null, enable: snap.enable, ready: snap.ready };
  });

  await check("sessions-root-override-refuses-non-tmp", () => {
    // The scratch sessions-root override (setSessionsRoot) is what lets the
    // verification path write into /tmp instead of the 13 irreplaceable real
    // recordings under SESSIONS_ROOT. This proves the guard actually refuses
    // anything that is not under /tmp -- if it is ever removed, a test run
    // could silently overwrite real sessions.
    const prior = getSessionsRoot();
    try {
      // Anything outside /tmp, and prefix tricks that merely START with the
      // letters "/tmp", MUST throw.
      const mustReject = [SESSIONS_ROOT, "/tmpevil", "/shared/../tmp/x", "/tmp/../shared/x", "", 42];
      for (const bad of mustReject) {
        let threw = false;
        try {
          setSessionsRoot(bad);
        } catch (e) {
          threw = true;
        }
        if (!threw) {
          throw new Error(`setSessionsRoot(${JSON.stringify(bad)}) was accepted -- the /tmp-only guard is missing; real recordings are unprotected`);
        }
      }
      // A real /tmp path is accepted and getSessionsRoot() reflects it.
      setSessionsRoot("/tmp/xyz");
      if (getSessionsRoot() !== "/tmp/xyz") {
        throw new Error(`setSessionsRoot("/tmp/xyz") did not take effect: getSessionsRoot() === ${JSON.stringify(getSessionsRoot())}`);
      }
      return { rejected: 6, accepted: "/tmp/xyz" };
    } finally {
      // Restore the prior state so this check has no side effect on later
      // checks. null clears the override back to the real SESSIONS_ROOT,
      // which is the normal resting state; only restore an explicit prior
      // override if one somehow existed.
      setSessionsRoot(null);
    }
  });

  await check("tabs-wired", () => {
    const tabs = [el.tabInterview, el.tabAdvanced];
    for (const t of tabs) {
      if (t.getAttribute("role") !== "tab") throw new Error(`${t.id} missing role="tab"`);
    }
    if (el.panelInterview.getAttribute("role") !== "tabpanel" || el.panelAdvanced.getAttribute("role") !== "tabpanel") {
      throw new Error("panels missing role=\"tabpanel\"");
    }
    // Default state: Interview selected/visible, Advanced not.
    const defaultOk =
      el.tabInterview.getAttribute("aria-selected") === "true" &&
      el.tabAdvanced.getAttribute("aria-selected") === "false" &&
      el.panelInterview.style.display !== "none" &&
      el.panelAdvanced.style.display === "none";
    if (!defaultOk) throw new Error("unexpected default tab state");

    // Click Advanced, confirm inline style.display flips on BOTH panels
    // (not a class -- slicc.screenshot() does not honor class-based hiding).
    el.tabAdvanced.click();
    const afterClickOk =
      el.tabAdvanced.getAttribute("aria-selected") === "true" &&
      el.tabInterview.getAttribute("aria-selected") === "false" &&
      el.panelAdvanced.style.display !== "none" &&
      el.panelInterview.style.display === "none";
    if (!afterClickOk) throw new Error("clicking Advanced tab did not switch panels via inline style.display");

    // Home/End keyboard nav, then restore to Interview so the UI is left
    // in its default state for whoever looks at it next.
    el.tabAdvanced.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true, cancelable: true }));
    const homeOk = el.tabInterview.getAttribute("aria-selected") === "true";
    el.tabInterview.click();

    return { defaultOk, afterClickOk, homeKeyOk: homeOk };
  });

  await check("kb-mode-toggle", () => {
    const before = el.kbMode.value;
    el.kbMode.value = "local";
    onKbModeChange();
    const localVisible = !el.kbLocalPanel.classList.contains("im-hidden");
    const collectionHidden = el.kbCollectionPanel.classList.contains("im-hidden");
    el.kbMode.value = before;
    onKbModeChange();
    if (!localVisible || !collectionHidden) throw new Error("Local mode panel toggle did not switch visibility");
    return { ok: true };
  });

  await check("build-tools-and-instructions", async () => {
    const config = gatherConfig();
    const tools = buildTools(config);
    const minutes = getSessionLengthMs() / 60000;
    const instructions = buildInstructions({ topic: config.topic || "the interview topic", sourceMaterial: "", sessionMinutes: minutes });
    if (!tools.length) throw new Error("buildTools returned empty array");
    if (!instructions.includes("## Goal")) throw new Error("instructions missing expected section");
    // Regression check for the sessionMinutes wiring: the prompt must state
    // the REAL configured duration, not a hardcoded "five minutes" -- see
    // tools.js#buildInstructions's own header comment for why a fixed
    // duration actively mis-steers the model at any length other than 5.
    const expectedLabel = Number.isInteger(minutes) ? String(minutes) : minutes.toFixed(1);
    const expectedDuration = `${expectedLabel} minute${minutes === 1 ? "" : "s"}`;
    if (!instructions.includes(`in under ${expectedDuration}`)) {
      throw new Error(`instructions did not state the configured duration "${expectedDuration}": ${instructions.slice(0, 200)}`);
    }
    return { toolTypes: tools.map((t) => t.type), collectionId: config.collectionId, kbMode: config.kbMode, sessionMinutes: minutes, expectedDuration };
  });

  await check("getusermedia-availability", () => {
    const available = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
    return { available, note: "availability only -- NOT requesting permission from a self-test" };
  });

  await check("camera-mic-wiring", () => {
    // Existence/wiring only -- deliberately does NOT call getUserMedia
    // (that needs a real permission gesture this self-test must not fake).
    const fns = { attachStreamToVideo, logStreamDiagnostics, restartPreviewStream, describeCameraDiagnostics };
    const missing = Object.entries(fns).filter(([, f]) => typeof f !== "function").map(([k]) => k);
    if (missing.length) throw new Error(`Missing functions: ${missing.join(", ")}`);
    // Confirm the change listeners exist by dispatching one at rest (no
    // rawStream yet -- restartPreviewStream returns immediately) and
    // checking it doesn't throw.
    const before = state.rawStream;
    el.camSelect.dispatchEvent(new Event("change"));
    el.micSelect.dispatchEvent(new Event("change"));
    return { functionsPresent: Object.keys(fns), dispatchedChangeWithoutThrow: true, hadRawStream: !!before };
  });

  await check("preview-grid-one-tile-per-camera", () => {
    // The live preview grid must render EXACTLY one tile per camera, and a
    // camera that failed to open must yield a FAILURE tile -- never a missing
    // one (that is the real bug this guards: a failed angle silently dropped,
    // so the grid shows fewer tiles than cameras). Driven with synthetic
    // camera descriptors (stream:null) so it never touches getUserMedia -- the
    // grid lays out from CSS regardless of whether a video frame ever arrives.
    // Rects are MEASURED here so the report has authoritative geometry.
    if (typeof renderPreviewGrid !== "function") throw new Error("renderPreviewGrid is not wired into the self-test context");
    const grid = el.previewGrid;
    if (!grid) throw new Error("#im-preview-grid is missing");

    const priorClass = el.previewRow.className;
    const priorDisplay = el.previewRow.style.display;
    const priorSrc = el.previewVideo ? el.previewVideo.srcObject : null;
    const fakeCams = (n) => Array.from({ length: n }, (_, i) => ({ failed: false, stream: null, label: `cam${i}` }));
    const rectOf = (node) => {
      const r = node.getBoundingClientRect();
      const r2 = (v) => Number(v.toFixed(2));
      return { width: r2(r.width), height: r2(r.height), left: r2(r.left), top: r2(r.top) };
    };

    const out = { counts: {}, laidOut: false, border: {}, failure: {} };
    try {
      // The grid only has real geometry when the preview row is visible.
      el.previewRow.classList.remove("im-hidden");
      el.previewRow.style.display = "";

      for (const n of [1, 2, 5]) {
        const res = renderPreviewGrid(fakeCams(n));
        const tiles = grid.querySelectorAll(".im-video-wrap");
        if (res.tileCount !== n || tiles.length !== n) {
          throw new Error(`rendered ${res.tileCount}/${tiles.length} tiles for ${n} cameras -- expected exactly ${n} (one per camera)`);
        }
        out.counts[n] = Array.from(tiles).map((t) => rectOf(t));
      }
      out.laidOut = (out.counts[1][0].width > 0);

      // Mic-level BORDER responds to --mic-pct (quiet -> subtle, loud -> accent).
      renderPreviewGrid(fakeCams(2));
      grid.style.setProperty("--mic-pct", "0%");
      out.border.quiet = getComputedStyle(grid).borderTopColor;
      grid.style.setProperty("--mic-pct", "100%");
      out.border.loud = getComputedStyle(grid).borderTopColor;
      grid.style.setProperty("--mic-pct", "0%");
      if (out.border.quiet === out.border.loud) {
        throw new Error(`grid border colour did not change with mic level (${out.border.quiet}) -- the --mic-pct treatment is not wired`);
      }

      // A failed camera yields a failure tile, not a missing one. Test both a
      // failed HERO (index 0) and a failed EXTRA.
      let res = renderPreviewGrid([{ failed: true, stream: null }, { failed: false, stream: null }]);
      let failedTiles = grid.querySelectorAll(".im-video-wrap--failed");
      let allTiles = grid.querySelectorAll(".im-video-wrap");
      if (allTiles.length !== 2) throw new Error(`failed-hero case rendered ${allTiles.length} tiles, expected 2 (failure tile must not be dropped)`);
      if (failedTiles.length !== 1) throw new Error(`failed-hero case produced ${failedTiles.length} failure tiles, expected exactly 1`);
      const failTextOk = grid.querySelector(".im-video-wrap__fail") && grid.querySelector(".im-video-wrap__fail").textContent.length > 0;
      if (!failTextOk) throw new Error("failure tile has no failure text");

      res = renderPreviewGrid([{ failed: false, stream: null }, { failed: true, stream: null }]);
      allTiles = grid.querySelectorAll(".im-video-wrap");
      failedTiles = grid.querySelectorAll(".im-video-wrap--failed");
      if (allTiles.length !== 2 || failedTiles.length !== 1) {
        throw new Error(`failed-extra case: ${allTiles.length} tiles / ${failedTiles.length} failed, expected 2 / 1`);
      }
      out.failure = { failedHeroTiles: 2, failedExtraTiles: 2, failedCount: res.failedCount };
    } finally {
      // Reset the grid to just the (clean) static hero tile and restore the
      // preview row exactly as it was, so no later check sees a side effect.
      renderPreviewGrid([]);
      grid.style.removeProperty("--mic-pct");
      if (el.previewVideo) el.previewVideo.srcObject = priorSrc || null;
      el.previewRow.className = priorClass;
      el.previewRow.style.display = priorDisplay;
    }

    return out;
  });

  // --- Multi-camera recording (lib/multicam-record.js) -------------------
  // These drive the REAL prepareMultiCamRecording / buildCameraSyncInfo with
  // FAKE recorder/flusher factories and permission-free REAL tracks (a canvas
  // captureStream video track + an AudioContext MediaStreamDestination audio
  // track), so they exercise the actual open/hero/angle/sync logic WITHOUT
  // getUserMedia (no permission gesture allowed in a self-test). The real
  // recorder wiring is proven separately by the capture-verify harness.
  const buildMulticamHarness = () => {
    if (typeof createMulticamRecord !== "function") throw new Error("createMulticamRecord not in self-test ctx (loader/wiring)");
    const cleanup = [];
    const made = { human: [], camera: [] };
    const fakeRecorder = (kind) => ({ _kind: kind, attachFlusher() {}, start() { this._started = true; }, stop() { return Promise.resolve({ size: 100 }); }, blob() { return { size: 100 }; }, extension() { return "webm"; } });
    const fakeMeter = () => ({ armed: false, stopped: false, frames: 5, framesSinceArmed: 0, firstTsUs: 1000, recordingFirstTsUs: 2000, lastTsUs: 5000 });
    // Real, permission-free tracks so prepareMultiCamRecording's own
    // `new MediaStream([...])` calls succeed.
    const makeVideoTrack = () => {
      const c = document.createElement("canvas");
      c.width = 32; c.height = 24;
      c.getContext("2d").fillRect(0, 0, 32, 24);
      const s = c.captureStream(5);
      const t = s.getVideoTracks()[0];
      cleanup.push(() => { try { t.stop(); } catch (e) {} });
      return t;
    };
    const audioCtx = new AudioContext();
    cleanup.push(() => { try { audioCtx.close(); } catch (e) {} });
    const sharedAudioTrack = audioCtx.createMediaStreamDestination().stream.getAudioTracks()[0];
    const mk = createMulticamRecord({
      openCameraWithWatchdog: async (deviceId, w, h) => ({ stream: new MediaStream([makeVideoTrack()]), track: makeVideoTrack(), meter: fakeMeter(), firstTsUs: 1000, openMs: 10, attempts: 1, settings: { width: w, height: h, frameRate: 30 } }),
      createHumanRecorder: (stream) => { const r = fakeRecorder("human"); r._stream = stream; made.human.push(r); return r; },
      createCameraRecorder: (vt, at) => { const r = fakeRecorder("camera"); r._video = vt; r._audio = at; made.camera.push(r); return r; },
      createChunkFlusher: () => ({}),
      safeDiag: () => {},
      withTimeout: (p) => p,
    });
    const devices = (n) => Array.from({ length: n }, (_, i) => ({ deviceId: `cam-${i}`, kind: "videoinput", label: `Cam ${i}` }));
    return { mk, made, sharedAudioTrack, devices, cleanupAll: () => cleanup.forEach((f) => f()) };
  };

  await check("multicam-one-recorder-and-sync-entry-per-camera", async () => {
    const h = buildMulticamHarness();
    try {
      const prep = await h.mk.prepareMultiCamRecording({ videoDevices: h.devices(3), sharedAudioTrack: h.sharedAudioTrack, heroDeviceId: "cam-0", partsRoot: "/tmp/selftest-multicam", slicc: {} });
      if (prep.opened.length !== 3) throw new Error(`opened ${prep.opened.length}, expected 3`);
      // exactly one recorder per opened camera: hero (createHumanRecorder) + angles (createCameraRecorder)
      const recorders = h.made.human.length + h.made.camera.length;
      if (h.made.human.length !== 1) throw new Error(`${h.made.human.length} hero recorders, expected 1`);
      if (recorders !== prep.opened.length) throw new Error(`${recorders} recorders for ${prep.opened.length} cameras -- must be one per camera`);
      if (prep.cameras.length !== 2) throw new Error(`${prep.cameras.length} angle descriptors, expected 2`);
      // the ONE shared mic muxed into every angle recorder
      for (const cam of prep.cameras) {
        if (cam.recorder._audio !== h.sharedAudioTrack) throw new Error("an angle recorder did not receive the shared mic track (mux broken)");
      }
      // one sync.json entry per opened camera
      const { syncInfo } = h.mk.buildCameraSyncInfo({ opened: prep.opened, cameras: prep.cameras, humanBlob: { size: 999 }, startWall: Date.now(), startSpreadMs: 0.1, sharedAudioTrack: h.sharedAudioTrack, endedAt: Date.now() + 10000 });
      if (syncInfo.cameras.length !== prep.opened.length) throw new Error(`sync.json has ${syncInfo.cameras.length} entries for ${prep.opened.length} cameras`);
      return { opened: prep.opened.length, recorders, angles: prep.cameras.length, syncEntries: syncInfo.cameras.length };
    } finally {
      h.cleanupAll();
    }
  });

  await check("multicam-hero-maps-to-human-webm", async () => {
    const h = buildMulticamHarness();
    try {
      const prep = await h.mk.prepareMultiCamRecording({ videoDevices: h.devices(3), sharedAudioTrack: h.sharedAudioTrack, heroDeviceId: "cam-0", partsRoot: "/tmp/selftest-multicam", slicc: {} });
      // The hero recorder is the createHumanRecorder one, records the first
      // opened camera's video + the shared mic, and maps to human.webm.
      const heroRec = h.made.human[0];
      if (!heroRec || heroRec !== prep.heroRecorder) throw new Error("heroRecorder is not the createHumanRecorder instance");
      const vids = heroRec._stream.getVideoTracks();
      const auds = heroRec._stream.getAudioTracks();
      if (vids.length !== 1 || vids[0] !== prep.opened[0].track) throw new Error("hero recorder does not carry the hero (index 0) video track");
      if (auds.length !== 1 || auds[0] !== h.sharedAudioTrack) throw new Error("hero recorder does not carry the shared mic track");
      const { syncInfo } = h.mk.buildCameraSyncInfo({ opened: prep.opened, cameras: prep.cameras, humanBlob: { size: 999 }, startWall: Date.now(), startSpreadMs: 0.1, sharedAudioTrack: h.sharedAudioTrack, endedAt: Date.now() + 10000 });
      if (syncInfo.cameras[0].role !== "main" || syncInfo.cameras[0].file !== "human.webm") throw new Error(`hero maps to ${syncInfo.cameras[0].role}/${syncInfo.cameras[0].file}, expected main/human.webm`);
      for (let i = 1; i < syncInfo.cameras.length; i++) {
        if (syncInfo.cameras[i].file !== `video/angle${i}.webm`) throw new Error(`angle ${i} maps to ${syncInfo.cameras[i].file}, expected video/angle${i}.webm`);
      }
      return { heroFile: syncInfo.cameras[0].file, angleFiles: syncInfo.cameras.slice(1).map((c) => c.file) };
    } finally {
      h.cleanupAll();
    }
  });

  await check("multicam-audio-only-fallback-yields-human-recorder", async () => {
    const h = buildMulticamHarness();
    try {
      // No camera available: prepareMultiCamRecording must still build a valid
      // hero recorder (mic only) so human.webm is produced -- the audio-only
      // fallback beginSession relies on when there is no camera.
      const prep = await h.mk.prepareMultiCamRecording({ videoDevices: [], sharedAudioTrack: h.sharedAudioTrack, heroDeviceId: undefined, partsRoot: "/tmp/selftest-multicam", slicc: {} });
      if (prep.opened.length !== 0) throw new Error(`opened ${prep.opened.length}, expected 0 (no cameras)`);
      if (prep.cameras.length !== 0) throw new Error(`${prep.cameras.length} angle recorders, expected 0`);
      if (!prep.heroRecorder || h.made.human.length !== 1) throw new Error("no hero (human) recorder built for the audio-only fallback");
      const heroRec = h.made.human[0];
      if (heroRec._stream.getVideoTracks().length !== 0) throw new Error("audio-only hero recorder unexpectedly has a video track");
      if (heroRec._stream.getAudioTracks().length !== 1 || heroRec._stream.getAudioTracks()[0] !== h.sharedAudioTrack) throw new Error("audio-only hero recorder is missing the shared mic track");
      // No angles -> no sync.json entries (beginSession skips sync.json for a lone hero).
      const { syncInfo } = h.mk.buildCameraSyncInfo({ opened: prep.opened, cameras: prep.cameras, humanBlob: { size: 555 }, startWall: Date.now(), startSpreadMs: 0, sharedAudioTrack: h.sharedAudioTrack, endedAt: Date.now() + 1000 });
      return { opened: 0, heroRecorder: true, heroAudioOnly: true, syncEntries: syncInfo.cameras.length };
    } finally {
      h.cleanupAll();
    }
  });

  await check("mic-watchdog-constructed", () => {
    // Loader-array wiring check: createMicWatchdog must have been
    // destructured from the mic-watchdog.js module load, and the object it
    // returns must expose everything beginSession()/stopInterview() call.
    if (typeof createMicWatchdog !== "function") throw new Error("createMicWatchdog was not loaded from mic-watchdog.js");
    const wd = createMicWatchdog({ setIntervalFn: () => null, clearIntervalFn: () => {} });
    const methods = ["attachAudioContext", "attachStream", "start", "stop", "dispose", "noteFrameAppended", "poll", "getEvents", "getStatus", "shouldAbortSession"];
    const missing = methods.filter((m) => typeof wd[m] !== "function");
    if (missing.length) throw new Error(`MicWatchdog missing methods: ${missing.join(", ")}`);
    wd.dispose();
    return { methodsPresent: methods };
  });

  await check("mic-watchdog-stall-simulates-warning-and-resume", async () => {
    // Cannot test with a real mic/AudioContext (no getUserMedia gesture
    // allowed here) -- simulates the exact failure mode instead: a fake
    // AudioContext that reports 'suspended' with a spyable resume(), and
    // zero noteFrameAppended() calls. Drives time via an injectable clock
    // and a no-op setIntervalFn so this test is instant and does not
    // depend on real timers; manually calls .poll() the same way the
    // watchdog's own interval would. Uses the REAL setMicWarning() helper
    // (wired via onStall/onRecovered, same as beginSession() does) so this
    // also proves the visible-warning path, not just the module in
    // isolation.
    let now = 1000000;
    let resumeCalls = 0;
    const fakeCtx = {
      state: "suspended",
      onstatechange: null,
      resume() {
        resumeCalls += 1;
        fakeCtx.state = "running";
        return Promise.resolve();
      },
    };
    const indicatorBefore = {
      className: el.speakingIndicator.className,
      textContent: el.speakingIndicator.textContent,
      micWarning: el.speakingIndicator.dataset.micWarning,
    };
    let stallInfo = null;
    let recoveredInfo = null;
    const wd = createMicWatchdog({
      now: () => now,
      setIntervalFn: () => null, // no real timer -- this test drives time via manual poll() calls
      clearIntervalFn: () => {},
      stallThresholdMs: 1000,
      onStall: (info) => {
        stallInfo = info;
        setMicWarning(true);
      },
      onRecovered: (info) => {
        recoveredInfo = info;
        setMicWarning(false);
      },
    });
    try {
      wd.attachAudioContext(fakeCtx);
      wd.start();
      now += 2000; // simulate 2s of silence past the (shortened) stall threshold
      wd.poll();
      // poll()'s defensive resume attempt awaits ctx.resume() internally;
      // flush a timer tick so it settles before asserting.
      await new Promise((resolve) => setTimeout(resolve, 0));

      if (!stallInfo) throw new Error("onStall did not fire for a stalled fake AudioContext");
      if (resumeCalls < 1) throw new Error("watchdog did not attempt ctx.resume() on the suspended fake context");
      if (fakeCtx.state !== "running") throw new Error("fake context was not left running after resume");
      const warningVisible =
        el.speakingIndicator.dataset.micWarning === "1" &&
        /Mic stalled/.test(el.speakingIndicator.textContent) &&
        el.speakingIndicator.classList.contains("sprinkle-status-light--negative");
      if (!warningVisible) throw new Error("stall did not surface a visible warning on #im-speaking-indicator");

      wd.noteFrameAppended(); // simulate audio flowing again
      if (!recoveredInfo) throw new Error("onRecovered did not fire after noteFrameAppended()");
      const warningCleared = !el.speakingIndicator.dataset.micWarning;
      if (!warningCleared) throw new Error("recovered warning was not cleared from #im-speaking-indicator");

      return { stallInfo, resumeCalls, recoveredInfo, warningVisible, warningCleared };
    } finally {
      wd.stop(); // detach the real document/window lifecycle listeners start() attached
      el.speakingIndicator.className = indicatorBefore.className;
      el.speakingIndicator.textContent = indicatorBefore.textContent;
      if (indicatorBefore.micWarning === undefined) delete el.speakingIndicator.dataset.micWarning;
      else el.speakingIndicator.dataset.micWarning = indicatorBefore.micWarning;
    }
  });

  await check("stream-watchdog-constructed", () => {
    // Loader-array wiring check: createStreamWatchdog must have been
    // destructured from the new stream-watchdog.js module load, and the
    // object it returns must expose everything beginSession()/
    // wireSessionHooks()/stopInterview() call.
    if (typeof createStreamWatchdog !== "function") throw new Error("createStreamWatchdog was not loaded from stream-watchdog.js");
    const wd = createStreamWatchdog({ setIntervalFn: () => null, clearIntervalFn: () => {} });
    const methods = [
      "attachSession",
      "start",
      "stop",
      "dispose",
      "noteServerEvent",
      "noteAssistantDelta",
      "noteAssistantResponseDone",
      "poll",
      "getEvents",
      "getStatus",
      "shouldAbortSession",
    ];
    const missing = methods.filter((m) => typeof wd[m] !== "function");
    if (missing.length) throw new Error(`StreamWatchdog missing methods: ${missing.join(", ")}`);
    wd.dispose();
    return { methodsPresent: methods };
  });

  await check("stream-watchdog-stall-simulates-warning-recovery-and-fatal", async () => {
    // Cannot simulate a real dead WebSocket -- exercises the exact
    // mechanism instead: a fake RealtimeSession-shaped object (isOpen/
    // updateSession/onRawEvent, the only three members this module
    // touches) and an injectable clock, driven manually via .poll() (no
    // real timer), matching mic-watchdog's self-test pattern above. Also
    // exercises the "a response was created but produced no transcript at
    // all" detector -- the second half of this task, and the exact shape
    // of the real failure's empty entry at 4:30 in
    // a recorded session's transcript.json.
    let now = 5000000;
    let nudgeSends = 0;
    const fakeSession = {
      _open: true,
      isOpen() {
        return this._open;
      },
      updateSession() {
        nudgeSends += 1;
        return this._open;
      },
      onRawEvent: null,
    };
    const indicatorBefore = {
      className: el.speakingIndicator.className,
      textContent: el.speakingIndicator.textContent,
      streamWarning: el.speakingIndicator.dataset.streamWarning,
    };
    let stallInfo = null;
    let recoveredInfo = null;
    let fatalInfo = null;
    let emptyResponseInfo = null;
    const wd = createStreamWatchdog({
      now: () => now,
      setIntervalFn: () => null, // no real timer -- this test drives time via manual poll() calls
      clearIntervalFn: () => {},
      silenceThresholdMs: 1000, // shortened for a fast, deterministic test -- real default is 20000, see stream-watchdog.js
      fatalAfterMs: 3000, // real default is 45000
      onStall: (info) => {
        stallInfo = info;
        setStreamWarning(true);
      },
      onRecovered: (info) => {
        recoveredInfo = info;
        setStreamWarning(false);
      },
      onFatal: (info) => {
        fatalInfo = info;
      },
      onEmptyResponse: (info) => {
        emptyResponseInfo = info;
      },
    });
    try {
      wd.attachSession(fakeSession);
      wd.start();

      // A response WITH a delta must never be flagged empty.
      wd.noteAssistantDelta("item-with-content");
      wd.noteAssistantResponseDone("item-with-content", "Hello there");
      if (emptyResponseInfo) throw new Error("a response with content was incorrectly flagged empty");

      // The real failure's exact shape: a response settles with no delta
      // ever received and no final text either.
      wd.noteAssistantResponseDone("item-empty", "");
      if (!emptyResponseInfo || emptyResponseInfo.itemId !== "item-empty") {
        throw new Error("empty-response was not flagged for a response with no delta and no text");
      }

      now += 1500; // simulate 1.5s of silence past the (shortened) threshold
      wd.poll();
      if (!stallInfo) throw new Error("onStall did not fire for simulated inbound silence");
      if (nudgeSends < 1) throw new Error("watchdog did not attempt the session.update() recovery nudge");
      const warningVisible =
        el.speakingIndicator.dataset.streamWarning === "1" &&
        /Connection stalled/.test(el.speakingIndicator.textContent) &&
        el.speakingIndicator.classList.contains("sprinkle-status-light--negative");
      if (!warningVisible) throw new Error("stall did not surface a visible warning on #im-speaking-indicator");

      // Recovery via a real inbound event arriving through the attached
      // session's onRawEvent -- proves attachSession()'s wiring, not just
      // noteServerEvent() called directly.
      fakeSession.onRawEvent({ type: "session.updated" });
      if (!recoveredInfo) throw new Error("onRecovered did not fire after a real inbound event via onRawEvent");
      const warningCleared = !el.speakingIndicator.dataset.streamWarning;
      if (!warningCleared) throw new Error("recovered warning was not cleared from #im-speaking-indicator");

      // A stall that never recovers must escalate to fatal -- the path
      // that ends the session with endReason:"stream-stalled" instead of
      // silently running to the 5-minute cap the way the real failure did.
      now += 1500; // past threshold again
      wd.poll();
      now += 3000; // past fatalAfterMs, counted from this stall's own start
      wd.poll();
      if (!fatalInfo) throw new Error("onFatal did not fire after sustained inbound silence");
      if (!wd.shouldAbortSession()) throw new Error("shouldAbortSession() did not report true after a fatal escalation");

      return { stallInfo, nudgeSends, recoveredInfo, warningVisible, warningCleared, fatalInfo, emptyResponseInfo };
    } finally {
      wd.stop();
      el.speakingIndicator.className = indicatorBefore.className;
      el.speakingIndicator.textContent = indicatorBefore.textContent;
      if (indicatorBefore.streamWarning === undefined) delete el.speakingIndicator.dataset.streamWarning;
      else el.speakingIndicator.dataset.streamWarning = indicatorBefore.streamWarning;
    }
  });

  await check("saving-screen-appears-and-clears", () => {
    // Exercises the REAL showSavingScreen() -- the exact function
    // stopInterview() calls synchronously, before any of its slow
    // recorder-stop/artifact-write awaits -- not a reimplementation.
    // Cannot drive this through a real stopInterview() call here (no live
    // session in a self-test), so this proves the screen-transition half
    // of the fix directly: the Saving screen becomes visible and every
    // other screen becomes hidden, the Stop button is disabled AND
    // relabelled (both, not just one), and then moving to another real
    // screen (showScreen(), same as showReview() does) clears it again --
    // "appears, then clears". Real DOM reads via getComputedStyle()/
    // inline style, per this sprinkle's documented slicc.screenshot()
    // unreliability -- never judged from a screenshot.
    const screens = [el.screenSetup, el.screenLive, el.screenSaving, el.screenReview];
    const before = {
      display: screens.map((s) => s.style.display),
      hiddenClass: screens.map((s) => s.classList.contains("im-hidden")),
      stopBtnDisabled: el.stopBtn.disabled,
      stopBtnText: el.stopBtn.textContent,
      // showScreen() now persists via ui-state.js (this round's other
      // task) -- calling the real showScreen("review") below has the real
      // side effect of persisting screen:"review", so restore the
      // persisted value too, not just the DOM, or every self-test run
      // would drift the real saved screen away from whatever it actually
      // was. getSnapshot() is synchronous/in-memory, no bridge call.
      persistedScreen: uiState.getSnapshot().uiState.screen,
    };
    try {
      showSavingScreen();

      const savingVisible = el.screenSaving.style.display !== "none" && getComputedStyle(el.screenSaving).display !== "none";
      const othersHidden =
        el.screenSetup.style.display === "none" && el.screenLive.style.display === "none" && el.screenReview.style.display === "none";
      if (!savingVisible) throw new Error("screen-saving is not visible after showSavingScreen()");
      if (!othersHidden) throw new Error("another screen is still visible while screen-saving is shown");
      if (!el.stopBtn.disabled) throw new Error("Stop button was not disabled by showSavingScreen()");
      if (el.stopBtn.textContent === "Stop") throw new Error("Stop button was not relabelled by showSavingScreen()");
      const relabelled = el.stopBtn.textContent;

      // "...then clears" -- the same transition showReview() performs
      // after a real session's writes finish.
      showScreen("review");
      const savingClearedAfterReview =
        el.screenSaving.style.display === "none" && getComputedStyle(el.screenSaving).display === "none" && el.screenReview.style.display !== "none";
      if (!savingClearedAfterReview) throw new Error("screen-saving did not clear after moving to another screen");

      return { savingVisible, othersHidden, relabelled, savingClearedAfterReview };
    } finally {
      screens.forEach((s, i) => {
        s.style.display = before.display[i];
        s.classList.toggle("im-hidden", before.hiddenClass[i]);
      });
      el.stopBtn.disabled = before.stopBtnDisabled;
      el.stopBtn.textContent = before.stopBtnText;
      uiState.update({ screen: before.persistedScreen });
      uiState.flush();
    }
  });

  await check("session-length-configurable", () => {
    // SESSION_LENGTH_MS/WRAP_UP_AT_MS became mutable `sessionLengthMs`,
    // driven by config.json's `sessionMinutes` through the REAL
    // applyConfig() -- the exact function both init() and the CLI's
    // {"type":"reloadconfig"} push handler call -- so this proves the
    // whole chain, not a reimplementation. Snapshots and restores
    // sessionLengthMs (and everything else applyConfig() touches) so this
    // never disturbs whatever is actually configured right now.
    const before = getSessionLengthMs();
    const domBefore = { webSearch: el.webSearch.checked, xSearch: el.xSearch.checked, setupIntro: el.setupIntro.textContent };
    try {
      // Bounds/validation, direct.
      if (clampSessionMinutes("not-a-number") !== null) throw new Error("clampSessionMinutes accepted a non-numeric value");
      if (clampSessionMinutes(0) !== null) throw new Error("clampSessionMinutes accepted a non-positive value");
      if (clampSessionMinutes(100) !== MAX_SESSION_MINUTES) throw new Error("clampSessionMinutes did not clamp an absurdly large value to the max");
      if (clampSessionMinutes(0.001) !== MIN_SESSION_MINUTES) throw new Error("clampSessionMinutes did not clamp a near-zero value to the min");

      // Through the real applyConfig() -- same path a CLI push takes.
      applyConfig({ sessionMinutes: 3 });
      if (getSessionLengthMs() !== 3 * 60000) throw new Error(`applyConfig({sessionMinutes:3}) left sessionLengthMs at ${getSessionLengthMs()}, expected 180000`);

      applyConfig({ sessionMinutes: 7 });
      if (getSessionLengthMs() !== 7 * 60000) throw new Error(`applyConfig({sessionMinutes:7}) left sessionLengthMs at ${getSessionLengthMs()}, expected 420000`);

      // Absent field -> leave the current value alone (matches every
      // other optional config field's "only apply if present" convention).
      applyConfig({});
      if (getSessionLengthMs() !== 7 * 60000) throw new Error("applyConfig({}) incorrectly changed sessionLengthMs");

      // Invalid value -> rejected, not silently clamped or thrown.
      applyConfig({ sessionMinutes: "banana" });
      if (getSessionLengthMs() !== 7 * 60000) throw new Error("applyConfig() with an invalid sessionMinutes changed sessionLengthMs anyway");

      // Wrap-up rule: proportional (25%) capped at 45s -- widened in
      // round 2 of the wrap-up fix (see wrapupOffsetMs()'s own comment
      // for why: the directive is now sent immediately/unconditionally,
      // not deferred, so the reserved window no longer needs to absorb
      // deferral latency, and real evidence showed more total runway
      // helps the model actually get to a natural close). 5min->45s (up
      // from the old 30s), 3min->45s (25% of 180s, still under the cap),
      // 1min->15s (shrinks so it can never eat too much of a short
      // session -- 25% here, same shape as before just a bigger ratio).
      const wrap5 = wrapupOffsetMs(5 * 60000);
      const wrap3 = wrapupOffsetMs(3 * 60000);
      const wrap1 = wrapupOffsetMs(1 * 60000);
      if (wrap5 !== 45000) throw new Error(`wrapupOffsetMs(5min) = ${wrap5}, expected 45000`);
      if (wrap3 !== 45000) throw new Error(`wrapupOffsetMs(3min) = ${wrap3}, expected 45000`);
      if (wrap1 !== 15000) throw new Error(`wrapupOffsetMs(1min) = ${wrap1}, expected 15000 (25% of 60000)`);

      // Same fmtMs() the Live screen's countdown tick renders with --
      // proves a 3-minute-configured session's countdown actually starts
      // at "03:00", independent of whatever config.json is set to right
      // now (this asserts the formatting mechanism, not today's value).
      const countdownAt3Min = fmtMs(3 * 60000);
      if (countdownAt3Min !== "03:00") throw new Error(`fmtMs(3 minutes) = "${countdownAt3Min}", expected "03:00"`);

      // The intro no longer states the session length: the UI-cleanup spec
      // classed the mechanics it narrated (recorded, transcribed, "up to N
      // minutes") as things the user does not decide here, so the copy is now
      // one short static line. This previously asserted /Up to 3 minutes/.
      // The behaviour that assertion protected -- a config push really moving
      // the live session length into the UI -- is still covered above by the
      // getSessionLengthMs() checks and by fmtMs(3 * 60000) === "03:00", which
      // is the value the user actually sees counting down. What is asserted
      // here now is only that updateSetupIntro() is still wired and writes
      // non-empty copy through applyConfig().
      applyConfig({ sessionMinutes: 3 });
      const introText = el.setupIntro.textContent.trim();
      if (!introText) throw new Error("applyConfig() left the setup intro empty -- updateSetupIntro() is no longer wired");
      if (/minute|recorded|transcribed/i.test(introText)) {
        throw new Error(`Setup intro reverted to the wordy copy the spec removed: ${JSON.stringify(introText)}`);
      }

      return { wrap5, wrap3, wrap1, setupIntroText: introText };
    } finally {
      setSessionLengthMs(before);
      el.webSearch.checked = domBefore.webSearch;
      el.xSearch.checked = domBefore.xSearch;
      el.setupIntro.textContent = domBefore.setupIntro;
    }
  });

  await check("ui-state-constructed", () => {
    // Loader-array wiring check: UiState must have been destructured from
    // ui-state.js, and the module-scope singleton constructed against the
    // real bridge must expose everything init()/beginSession()/
    // stopInterview()/showScreen()/selectTab() call.
    if (typeof UiState !== "function") throw new Error("UiState was not loaded from ui-state.js");
    if (!(uiState instanceof UiState)) throw new Error("the module-scope `uiState` singleton is not a UiState instance");
    const methods = ["update", "markSessionStarted", "clearSession", "flush", "restore", "getSnapshot"];
    const missing = methods.filter((m) => typeof uiState[m] !== "function");
    if (missing.length) throw new Error(`UiState missing methods: ${missing.join(", ")}`);
    return { methodsPresent: methods };
  });

  await check("ui-state-save-restore-and-interrupted-marker", async () => {
    // Part A: a FAKE in-memory bridge (not the real slicc.setState/
    // getState) -- hermetic, fast, and proves the REAL UiState class's
    // own save/restore/marker logic in isolation, same house style as the
    // fake-AudioContext/fake-session watchdog checks above. Simulates
    // exactly what a panel resize does: construct a BRAND NEW UiState
    // (matching the real `const uiState = new UiState(...)` at module
    // scope, rebuilt from scratch on every re-render) and restore from
    // whatever the previous instance saved.
    let store; // the fake "bridge" storage -- whatever was last setState()'d
    const fakeBridge = { setState: (v) => { store = v; }, getState: () => store };

    const a = new UiState(fakeBridge, { debounceMs: 0, timeoutMs: 500 });
    a.update({ tab: "advanced", brief: "hello from the textarea" });
    await a.flush();

    const b = new UiState(fakeBridge, { debounceMs: 0, timeoutMs: 500 });
    const restored1 = await b.restore();
    if (restored1.uiState.tab !== "advanced") throw new Error(`restored tab = "${restored1.uiState.tab}", expected "advanced"`);
    if (restored1.uiState.brief !== "hello from the textarea") throw new Error("restored brief did not round-trip across a fresh instance");
    if (restored1.interruptedSession !== null) throw new Error("a fresh save with no session marker was incorrectly reported as interrupted");

    // Mark a session started (as beginSession() does), WITHOUT ever
    // calling clearSession() -- simulating a re-render mid-interview,
    // exactly the case this whole feature exists for.
    await a.markSessionStarted({ sessionDir: `${SESSIONS_ROOT}/__selftest_fake_marker__`, startedAt: 123456 });

    const c = new UiState(fakeBridge, { debounceMs: 0, timeoutMs: 500 });
    const restored2 = await c.restore();
    if (!restored2.interruptedSession) throw new Error("markSessionStarted()'s marker was not visible to a fresh UiState instance restoring the same bridge");
    if (restored2.interruptedSession.sessionDir !== `${SESSIONS_ROOT}/__selftest_fake_marker__`) {
      throw new Error("interruptedSession.sessionDir did not round-trip");
    }
    if (restored2.uiState.tab !== "advanced") throw new Error("the interrupted-session marker save lost the previously-saved tab");

    // Normal end of session (stopInterview()'s uiState.clearSession() call) clears it.
    await a.clearSession();
    const d = new UiState(fakeBridge, { debounceMs: 0, timeoutMs: 500 });
    const restored3 = await d.restore();
    if (restored3.interruptedSession !== null) throw new Error("clearSession() did not clear the marker for a fresh restore");
    if (restored3.uiState.tab !== "advanced") throw new Error("clearSession() incorrectly disturbed the persisted tab/brief");

    // Part B: the REAL module-scope `uiState` singleton against the REAL
    // slicc.setState/getState bridge -- proves the actual wiring works in
    // THIS environment, not just that the module's own logic is correct
    // against a fake. Uses an obviously-fake sessionDir that is never
    // written to disk (this marker lives entirely in the bridge's
    // persisted state, not under sessions/ -- no file is created), and
    // restores to a clean (no marker) state in a `finally` so this can
    // never leave a false "interrupted" report for the next real load.
    // Does NOT touch tab/screen/brief on the real singleton.
    const FAKE_DIR = `${SESSIONS_ROOT}/__selftest_fake_marker__`;
    const realBridge = { setState: (v) => slicc.setState(v), getState: () => slicc.getState() };
    let liveRestored = null;
    let liveRestoredAfterClear = null;
    try {
      await uiState.markSessionStarted({ sessionDir: FAKE_DIR, startedAt: Date.now() });
      liveRestored = await new UiState(realBridge).restore();
      if (!liveRestored.interruptedSession || liveRestored.interruptedSession.sessionDir !== FAKE_DIR) {
        throw new Error("the real slicc.setState/getState bridge round-trip did not surface the interrupted-session marker");
      }
    } finally {
      await uiState.clearSession();
    }
    liveRestoredAfterClear = await new UiState(realBridge).restore();
    if (liveRestoredAfterClear.interruptedSession !== null) {
      throw new Error("clearSession() did not clear the marker on the real bridge");
    }

    return { fakeBridge: { restored1, restored2, restored3 }, realBridge: { liveRestored, liveRestoredAfterClear } };
  });

  await check("hung-play-does-not-block", async () => {
    // Directly reproduces the confirmed regression mechanism: a
    // videoEl.play() that never settles (neither resolves nor rejects).
    // Uses a fake video element and a fake audio-only-shaped stream, NOT
    // el.previewVideo/state.rawStream, so this never touches real devices
    // or the real preview. Proves safeAttachCameraPreview returns within
    // its timeout bound (not hanging the caller) and reports the failure
    // rather than throwing.
    const fakeVideoEl = {
      muted: false,
      autoplay: false,
      playsInline: false,
      srcObject: null,
      addEventListener() {},
      play() {
        return new Promise(() => {}); // never settles, on purpose
      },
    };
    const fakeStream = { getVideoTracks: () => [] };
    const t0 = performance.now();
    const result = await safeAttachCameraPreview(fakeVideoEl, fakeStream, "selftest-hang-sim", 300, { simulated: true });
    const elapsedMs = performance.now() - t0;
    if (elapsedMs > 2000) throw new Error(`safeAttachCameraPreview did not respect its timeout: took ${elapsedMs}ms`);
    if (result.ok) throw new Error("expected result.ok === false for a permanently-hung play()");
    if (!result.errors.some((e) => e.stage === "attach")) throw new Error("expected an 'attach' stage error");
    return { elapsedMs, cappedAt: 300, errors: result.errors };
  });

  await check("canvas-var-color-bug-fixed", async () => {
    // Reproduces the confirmed dark-mode bug and proves the fix, both by
    // the SAME method used to discover it: assign to a real
    // CanvasRenderingContext2D and read the property back (not pixel
    // data) -- canvas 2D color parsing runs outside the CSS cascade, so
    // `var(...)` inside a color string is silently rejected and the
    // property keeps its previous value (canvas default: #000000).
    const buggyCtx = document.createElement("canvas").getContext("2d");
    buggyCtx.strokeStyle = "color-mix(in srgb, var(--s2-accent) 80%, transparent)";
    const buggyReadback = buggyCtx.strokeStyle;
    if (buggyReadback !== "#000000") {
      throw new Error(`Expected the classic var()-in-canvas bug to read back as #000000 (confirming the bug still reproduces), got ${buggyReadback}`);
    }

    const root = document.documentElement;
    const originalClassName = root.className;
    const settle = () => new Promise((resolve) => setTimeout(resolve, 0)); // let the MutationObserver microtask run

    try {
      // Current theme: the actual fix (resolveWaveStrokeColor(), what
      // startWaveforms() really uses via the cached `waveStrokeColor`).
      const fixedCtxBefore = document.createElement("canvas").getContext("2d");
      fixedCtxBefore.strokeStyle = resolveWaveStrokeColor();
      const resolvedBefore = fixedCtxBefore.strokeStyle;
      if (resolvedBefore === "#000000") throw new Error("resolveWaveStrokeColor() produced black in the starting theme -- fix did not resolve a real color");

      const cachedBefore = getWaveStrokeColor();

      // Flip the theme (same mechanism the parent uses) and prove BOTH
      // that the resolver still works post-toggle AND that the live
      // cache (what the waveform draw loop actually reads every frame)
      // auto-refreshes via the MutationObserver, with no page reload and
      // no manual re-resolve call.
      root.classList.toggle("theme-light");
      await settle();
      const resolvedAfterToggle = resolveWaveStrokeColor();
      if (resolvedAfterToggle === "#000000") throw new Error("resolveWaveStrokeColor() produced black after a theme toggle");
      const fixedCtxAfter = document.createElement("canvas").getContext("2d");
      fixedCtxAfter.strokeStyle = resolvedAfterToggle;
      const readbackAfter = fixedCtxAfter.strokeStyle;
      if (readbackAfter === "#000000") throw new Error("post-toggle resolved color read back as black from the canvas");

      const cachedAfterToggle = getWaveStrokeColor();
      if (cachedAfterToggle !== resolvedAfterToggle) {
        throw new Error(`Live cache did not auto-refresh after the theme toggle: cache=${cachedAfterToggle} fresh=${resolvedAfterToggle}`);
      }

      // Toggle back and confirm the cache tracks that too (not a one-shot
      // refresh that only ever fires once).
      root.classList.toggle("theme-light");
      await settle();
      const resolvedRestored = resolveWaveStrokeColor();
      const cachedRestored = getWaveStrokeColor();
      if (cachedRestored !== resolvedRestored) {
        throw new Error(`Live cache did not auto-refresh back after restoring the theme: cache=${cachedRestored} fresh=${resolvedRestored}`);
      }

      return {
        buggyVarInCanvasReadback: buggyReadback,
        fixedResolvedColorBeforeToggle: resolvedBefore,
        fixedResolvedColorAfterToggle: resolvedAfterToggle,
        cacheTrackedToggle: true,
        cacheTrackedRestore: true,
      };
    } finally {
      root.className = originalClassName;
      await settle();
      setWaveStrokeColor(resolveWaveStrokeColor()); // belt-and-suspenders: never leave the live cache stale after this test
    }
  });

  await check("dark-mode-computed-styles-and-contrast", async () => {
    // Verifies actual resolved colors from the LIVE DOM in both theme
    // states -- NOT slicc.screenshot(), which uses an SVG foreignObject
    // clone that has repeatedly misrendered this sprinkle (four prior
    // confirmed instances). getComputedStyle() reads the real rendered
    // values the browser is actually using.
    const root = document.documentElement;
    const originalClassName = root.className;
    const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

    // Ground-truth CSS color string -> {r,g,b,a} via a real canvas (the
    // browser's own parser, not a hand-rolled one). getComputedStyle()
    // always returns an already-resolved literal (rgb()/rgba()), so this
    // never has to deal with an unresolved var() here.
    const parseColor = (str) => {
      const ctx = document.createElement("canvas").getContext("2d");
      ctx.canvas.width = 1;
      ctx.canvas.height = 1;
      ctx.fillStyle = str;
      ctx.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
      return { r, g, b, a: a / 255 };
    };
    const composite = (fg, bg) => (fg.a >= 1 ? fg : { r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a) });
    const luminance = ({ r, g, b }) => {
      const f = (v) => {
        v /= 255;
        return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
      };
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const contrastRatio = (c1, c2) => {
      const l1 = luminance(c1);
      const l2 = luminance(c2);
      const [lighter, darker] = l1 > l2 ? [l1, l2] : [l2, l1];
      return (lighter + 0.05) / (darker + 0.05);
    };

    // Detached elements for framework/state classes not present at rest
    // (e.g. the mic-stall warning, an error chip) -- built with the SAME
    // classes the real code applies, appended into the real DOM (so they
    // inherit the real cascade/tokens) just long enough to measure, then
    // removed. Never touches state.* or any real session data.
    const withTemp = (html, parent, fn) => {
      const wrap = document.createElement("div");
      wrap.innerHTML = html;
      const node = wrap.firstElementChild;
      (parent || document.body).appendChild(node);
      try {
        return fn(node);
      } finally {
        node.remove();
      }
    };

    // Each target: a text/foreground element paired with the element whose
    // background it actually sits on. `bg` defaults to the nearest
    // ancestor with a non-transparent background if not given explicitly
    // (we always give it explicitly below for clarity).
    const measure = () => {
      const out = {};

      const pairs = {
        "body-text": [document.body, document.body],
        // Was el.camNote, deleted with the rest of the camera status
        // readouts (the preview is the status). el.setupStatus is the same
        // `.im-note` class over the same body background, so this measures
        // exactly the same token pairing it always did.
        "im-note": [el.setupStatus, document.body],
        "im-screen-sub": [el.reviewSub, document.body],
        "im-wave-label": [document.querySelector(".im-wave-label"), document.querySelector(".im-wave-box")],
        "im-tab-inactive": [el.tabAdvanced, document.body],
        "im-tab-active": [el.tabInterview, document.body],
      };
      for (const [name, [fgEl, bgEl]] of Object.entries(pairs)) {
        if (!fgEl || !bgEl) {
          out[name] = { skipped: true };
          continue;
        }
        const fg = parseColor(getComputedStyle(fgEl).color);
        const bg = parseColor(getComputedStyle(bgEl).backgroundColor);
        const bgResolved = bg.a > 0 ? bg : parseColor(getComputedStyle(document.body).backgroundColor);
        const fgComposited = composite(fg, bgResolved);
        out[name] = { color: getComputedStyle(fgEl).color, backgroundColor: getComputedStyle(bgEl).backgroundColor, contrast: Number(contrastRatio(fgComposited, bgResolved).toFixed(2)) };
      }

      // Synthetic transcript rows -- real classes, inside the real
      // .im-transcript container so they inherit its actual background.
      out["transcript-timestamp"] = withTemp('<div class="im-transcript-entry"><span class="im-ts">00:00</span></div>', el.transcript, (node) => {
        const ts = node.querySelector(".im-ts");
        const fg = parseColor(getComputedStyle(ts).color);
        const bg = parseColor(getComputedStyle(el.transcript).backgroundColor);
        return { color: getComputedStyle(ts).color, backgroundColor: getComputedStyle(el.transcript).backgroundColor, contrast: Number(contrastRatio(composite(fg, bg), bg).toFixed(2)) };
      });
      out["transcript-tool-entry"] = withTemp('<div class="im-transcript-entry im-transcript-entry--tool">TOOL lookup_documents</div>', el.transcript, (node) => {
        const fg = parseColor(getComputedStyle(node).color);
        const bg = parseColor(getComputedStyle(el.transcript).backgroundColor);
        return { color: getComputedStyle(node).color, backgroundColor: getComputedStyle(el.transcript).backgroundColor, contrast: Number(contrastRatio(composite(fg, bg), bg).toFixed(2)) };
      });

      // The new stall warning (this round's watchdog integration) and the
      // existing negative badge variant -- built with the exact classes
      // setMicWarning()/addChip() apply, per the user's explicit ask to check
      // "any chip/warning styling, including the new stall warning".
      out["mic-stall-warning"] = withTemp('<span class="sprinkle-status-light sprinkle-status-light--negative">Mic stalled — recovering…</span>', document.body, (node) => {
        const fg = parseColor(getComputedStyle(node).color);
        const bg = parseColor(getComputedStyle(node).backgroundColor);
        const bgResolved = bg.a > 0 ? bg : parseColor(getComputedStyle(document.body).backgroundColor);
        return { color: getComputedStyle(node).color, backgroundColor: getComputedStyle(node).backgroundColor, contrast: Number(contrastRatio(composite(fg, bgResolved), bgResolved).toFixed(2)) };
      });
      out["error-chip"] = withTemp('<span class="sprinkle-badge sprinkle-badge--subtle sprinkle-badge--negative">mic failed: audio-track-ended</span>', el.chipRow, (node) => {
        const fg = parseColor(getComputedStyle(node).color);
        const bg = parseColor(getComputedStyle(node).backgroundColor);
        const bgResolved = bg.a > 0 ? bg : parseColor(getComputedStyle(document.body).backgroundColor);
        return { color: getComputedStyle(node).color, backgroundColor: getComputedStyle(node).backgroundColor, contrast: Number(contrastRatio(composite(fg, bgResolved), bgResolved).toFixed(2)) };
      });

      // Non-text checks: borders (3:1 UI-component threshold, not the
      // 4.5:1 text threshold) and the two backgrounds that were
      // light-dark() before this round's fix -- report both resolved
      // values so a human can eyeball whether they are genuinely distinct
      // per theme, not just "still technically a token".
      const dividerBorder = parseColor(getComputedStyle(document.querySelector(".im-divider")).borderTopColor);
      const pageBg = parseColor(getComputedStyle(document.body).backgroundColor);
      out["divider-border"] = { borderTopColor: getComputedStyle(document.querySelector(".im-divider")).borderTopColor, pageBackground: getComputedStyle(document.body).backgroundColor, contrastVsPage: Number(contrastRatio(dividerBorder, pageBg).toFixed(2)) };

      out["video-wrap-background"] = { backgroundColor: getComputedStyle(el.previewVideo.closest(".im-video-wrap")).backgroundColor, pageBackground: getComputedStyle(document.body).backgroundColor };
      out["review-media-background"] = { backgroundColor: getComputedStyle(el.reviewHuman).backgroundColor };

      out["accent-underline"] = { borderBottomColor: getComputedStyle(el.tabInterview, null).borderBottomColor };

      out["rec-indicator"] = withTemp('<div class="im-rec-indicator"><span class="im-rec-dot"></span>REC</div>', document.body, (node) => {
        const fg = parseColor(getComputedStyle(node).color);
        const bg = parseColor(getComputedStyle(node).backgroundColor);
        // Composited against black -- the realistic worst case for what
        // is actually behind this badge (a camera preview), not the page
        // background it happens to be measured against here.
        const overBlack = composite(bg, { r: 0, g: 0, b: 0 });
        return { color: getComputedStyle(node).color, backgroundColor: getComputedStyle(node).backgroundColor, contrastOverBlackVideo: Number(contrastRatio(composite(fg, overBlack), overBlack).toFixed(2)) };
      });

      return out;
    };

    let before, afterToggle, restored;
    try {
      before = measure();
      root.classList.toggle("theme-light");
      await settle();
      afterToggle = measure();
      root.classList.toggle("theme-light");
      await settle();
      restored = measure();
    } finally {
      root.className = originalClassName;
      await settle();
    }

    // Sanity: restoring the class must reproduce the original theme's
    // values exactly, not just "close" -- proves the toggle-and-restore
    // sequence really is symmetric and this test does not leave the
    // sprinkle in a mixed state.
    const restoredMatches = JSON.stringify(restored) === JSON.stringify(before);
    if (!restoredMatches) {
      throw new Error(`Computed styles after restore did not match the original theme exactly. before=${JSON.stringify(before)} restored=${JSON.stringify(restored)}`);
    }

    // Flag anything below WCAG 4.5:1 for body text in EITHER theme -- the
    // whole point of measuring both states.
    const textTargets = ["body-text", "im-note", "im-screen-sub", "im-wave-label", "im-tab-inactive", "im-tab-active", "transcript-timestamp", "transcript-tool-entry", "mic-stall-warning", "error-chip"];
    const belowThreshold = [];
    for (const name of textTargets) {
      for (const [themeLabel, snap] of [["theme-A", before], ["theme-B", afterToggle]]) {
        const entry = snap[name];
        if (entry && !entry.skipped && typeof entry.contrast === "number" && entry.contrast < 4.5) {
          belowThreshold.push({ name, theme: themeLabel, contrast: entry.contrast });
        }
      }
    }

    const originalWasLight = originalClassName.split(/\s+/).includes("theme-light");
    return {
      themeA: { isLight: originalWasLight, snapshot: before },
      themeB: { isLight: !originalWasLight, snapshot: afterToggle },
      restoredMatchesOriginal: restoredMatches,
      belowWcagAAThreshold: belowThreshold,
    };
  });

  await check("form-controls-readable-in-both-themes", async () => {
    // the user reported the briefing <textarea> has a white background even
    // in dark mode, with bright S2-token text on it -- unreadable. Same
    // "sprinkle-text-field" class is on every text <input>/<select> in
    // the Advanced tab. Reads REAL computed styles (never
    // slicc.screenshot(), which drops external stylesheets and has
    // misled this sprinkle's own audits before) for every one of them,
    // in BOTH theme states, including ::placeholder -- a common second
    // offender for the same root cause. Unlike the sibling
    // "dark-mode-computed-styles-and-contrast" check above (which only
    // REPORTS anything under threshold), this one THROWS on a violation --
    // it exists specifically to catch a regression of this bug, not just
    // to document contrast numbers.
    const root = document.documentElement;
    const originalClassName = root.className;
    const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

    const parseColor = (str) => {
      const ctx = document.createElement("canvas").getContext("2d");
      ctx.canvas.width = 1;
      ctx.canvas.height = 1;
      ctx.fillStyle = str;
      ctx.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
      return { r, g, b, a: a / 255 };
    };
    const composite = (fg, bg) => (fg.a >= 1 ? fg : { r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a) });
    const luminance = ({ r, g, b }) => {
      const f = (v) => {
        v /= 255;
        return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
      };
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const contrastRatio = (c1, c2) => {
      const l1 = luminance(c1);
      const l2 = luminance(c2);
      const [lighter, darker] = l1 > l2 ? [l1, l2] : [l2, l1];
      return (lighter + 0.05) / (darker + 0.05);
    };

    // Every element carrying "sprinkle-text-field" in this file: the
    // briefing textarea, every text <input>, and every <select> in the
    // Advanced tab -- exactly the set the user named.
    const FIELD_IDS = [
      "im-brief",
      "im-web-domains",
      "im-x-handles",
      "im-voice",
      "im-kb-mode",
      "im-collection-select",
      "im-new-collection-path",
      "im-new-collection-name",
      "im-test-query",
      "im-kb-path",
      "im-mic-select",
      "im-cam-select",
    ];

    const measure = () => {
      const out = {};
      const pageBg = parseColor(getComputedStyle(document.body).backgroundColor);
      for (const id of FIELD_IDS) {
        const node = document.getElementById(id);
        if (!node) {
          out[id] = { skipped: true };
          continue;
        }
        const cs = getComputedStyle(node);
        const bg = parseColor(cs.backgroundColor);
        const bgResolved = bg.a > 0 ? bg : pageBg;
        const fg = parseColor(cs.color);
        const contrast = Number(contrastRatio(composite(fg, bgResolved), bgResolved).toFixed(2));

        // ::placeholder is a pseudo-element -- getComputedStyle(el, pseudo)
        // reads its resolved style without needing to touch the DOM.
        // Only <input>/<textarea> have one; <select> does not.
        let placeholderColor = null;
        let placeholderContrast = null;
        if (node.tagName === "INPUT" || node.tagName === "TEXTAREA") {
          const phCs = getComputedStyle(node, "::placeholder");
          placeholderColor = phCs.color;
          if (placeholderColor) {
            const phFg = parseColor(placeholderColor);
            placeholderContrast = Number(contrastRatio(composite(phFg, bgResolved), bgResolved).toFixed(2));
          }
        }

        out[id] = {
          tag: node.tagName.toLowerCase(),
          backgroundColor: cs.backgroundColor,
          color: cs.color,
          contrast,
          placeholderColor,
          placeholderContrast,
        };
      }
      return out;
    };

    let before, afterToggle, restored;
    try {
      before = measure();
      root.classList.toggle("theme-light");
      await settle();
      afterToggle = measure();
      root.classList.toggle("theme-light");
      await settle();
      restored = measure();
    } finally {
      root.className = originalClassName;
      await settle();
    }

    const restoredMatches = JSON.stringify(restored) === JSON.stringify(before);
    if (!restoredMatches) {
      throw new Error(`Computed styles after restore did not match the original theme exactly. before=${JSON.stringify(before)} restored=${JSON.stringify(restored)}`);
    }

    const belowThreshold = [];
    for (const id of FIELD_IDS) {
      for (const [themeLabel, snap] of [["theme-A", before], ["theme-B", afterToggle]]) {
        const entry = snap[id];
        if (!entry || entry.skipped) continue;
        if (typeof entry.contrast === "number" && entry.contrast < 4.5) {
          belowThreshold.push({ id, theme: themeLabel, kind: "text", contrast: entry.contrast });
        }
        if (typeof entry.placeholderContrast === "number" && entry.placeholderContrast < 4.5) {
          belowThreshold.push({ id, theme: themeLabel, kind: "placeholder", contrast: entry.placeholderContrast });
        }
      }
    }

    const originalWasLight = originalClassName.split(/\s+/).includes("theme-light");
    const result = {
      themeA: { isLight: originalWasLight, snapshot: before },
      themeB: { isLight: !originalWasLight, snapshot: afterToggle },
      restoredMatchesOriginal: restoredMatches,
      belowWcagAAThreshold: belowThreshold,
    };
    if (belowThreshold.length) {
      throw new Error(`Form control(s) below WCAG AA 4.5:1 in at least one theme: ${JSON.stringify(belowThreshold)}. Full snapshot: ${JSON.stringify(result)}`);
    }
    return result;
  });

  await check("transcript-merge-continuation-exact-and-prefix", () => {
    // Exercises the REAL TranscriptStore._maybeMergeContinuation() (via
    // its only public entry point, markAssistantFinal()) with fresh,
    // isolated instances -- never touches state.transcript or any real
    // session.
    const FULL_TEXT =
      "That's a sharp pivot—using the browser's own isolation instead of Docker. The anti-stack explicitly calls out Docker Desktop as something you replaced with Colima over licensing. How does framing the browser itself as the container—tab close equals stop—change the security model compared to those container approaches?";
    const TRUNCATED_TEXT = "That's a sharp pivot—using the browser's own isolation instead of Docker. The anti-stack explicitly calls";
    if (FULL_TEXT.length !== 319) throw new Error(`test fixture drifted: FULL_TEXT is ${FULL_TEXT.length} chars, expected 319 (the real session's length)`);
    if (TRUNCATED_TEXT.length !== 105) throw new Error(`test fixture drifted: TRUNCATED_TEXT is ${TRUNCATED_TEXT.length} chars, expected 105`);
    if (!FULL_TEXT.startsWith(TRUNCATED_TEXT)) throw new Error("test fixture is not actually a prefix relationship");

    // Case 1: exact-match re-emission (the ORIGINAL bug this function
    // fixed, from the real earlier session) -- no formal
    // self-test coverage existed for this before now.
    {
      const t = new TranscriptStore(0);
      t.markAssistantFinal("item-a1", "Happy to have you here today.");
      t.logTool("collections_search", "");
      t.logTool("collections_search", "");
      t.markAssistantFinal("item-a2", "Happy to have you here today.");
      const assistantEntries = t.toJSON().filter((e) => e.role === "assistant");
      if (assistantEntries.length !== 1) throw new Error(`exact-match case: expected 1 merged assistant entry, got ${assistantEntries.length}`);
      if (assistantEntries[0].text !== "Happy to have you here today.") throw new Error("exact-match case: merged text is wrong");
      if (assistantEntries[0].item_id !== "item-a1") throw new Error("exact-match case: did not keep the EARLIER item id");
      if (!assistantEntries[0].merged_item_ids || !assistantEntries[0].merged_item_ids.includes("item-a2")) {
        throw new Error("exact-match case: merged_item_ids did not record the dropped item id");
      }
    }

    // Case 2: prefix-match re-emission, the REAL shapes from
    // a recorded session (the user flagged this live, mid-interview) --
    // full question first, then a truncated re-say cut off mid-word, with
    // two tool calls in between and no intervening user turn.
    let prefixResult;
    {
      const t = new TranscriptStore(0);
      t.markAssistantFinal("item-3ce1a186", FULL_TEXT);
      t.logTool("collections_search", "");
      t.logTool("collections_search", "");
      t.markAssistantFinal("item-dd6cbae9", TRUNCATED_TEXT);
      const assistantEntries = t.toJSON().filter((e) => e.role === "assistant");
      if (assistantEntries.length !== 1) {
        throw new Error(`prefix-match case: expected 1 merged assistant entry, got ${assistantEntries.length} -- the duplicate-question bug is NOT fixed`);
      }
      if (assistantEntries[0].text !== FULL_TEXT) {
        throw new Error(`prefix-match case: merged text should be the LONGER (319-char) version, got ${assistantEntries[0].text.length} chars: ${JSON.stringify(assistantEntries[0].text)}`);
      }
      if (assistantEntries[0].item_id !== "item-3ce1a186") throw new Error("prefix-match case: did not keep the EARLIER item id");
      prefixResult = {
        before: { fullTextLength: FULL_TEXT.length, truncatedTextLength: TRUNCATED_TEXT.length },
        after: { mergedEntryCount: assistantEntries.length, mergedTextLength: assistantEntries[0].text.length, keptItemId: assistantEntries[0].item_id },
      };
    }

    // Negative test: the SAME prefix relationship, but with a real user
    // turn between the two assistant entries -- must NOT merge. This is
    // the "genuine short repeats ('Go on.'...user...'Go on.')" guarantee
    // the function's own doc comment already promised; re-verified here
    // specifically against the NEW prefix-matching logic, since that is
    // exactly the kind of change that could accidentally weaken it.
    {
      const t = new TranscriptStore(0);
      t.markAssistantFinal("item-b1", FULL_TEXT);
      t.setUserTranscript("item-u1", "Wait, can you repeat that?");
      t.markUserFinal("item-u1");
      t.markAssistantFinal("item-b2", TRUNCATED_TEXT);
      const assistantEntries = t.toJSON().filter((e) => e.role === "assistant");
      if (assistantEntries.length !== 2) {
        throw new Error(`negative test: a real user turn between two prefix-related assistant entries must prevent merging, but got ${assistantEntries.length} assistant entr(ies)`);
      }
    }

    return { exactMatchOk: true, prefixResult, negativeTestOk: true };
  });

  await check("force-message-excluded-from-empty-response-check", () => {
    // Exercises the REAL wireSessionHooks()-installed
    // onAssistantTranscriptDone/Delta handlers (not a reimplementation)
    // against a throwaway fake session object, with
    // state.transcript/streamWatchdog swapped for isolated fakes --
    // proves both halves of Bug 2's fix end-to-end: (a) the recorded
    // entry holds the real wrap-up text, not empty, marked forced:true,
    // and (b) the stream-watchdog's empty-response detector is never even
    // invoked for that item id -- the actual mechanism that made it
    // false-positive on every session's wrap-up before this fix. Real
    // evidence this reproduces: a recorded session --
    // response.output_audio_transcript.done fired for the wrap-up
    // force_message with an EMPTY transcript string.
    const previous = {
      transcript: state.transcript,
      pendingForceMessageText: state.pendingForceMessageText,
      forceMessageItemIds: state.forceMessageItemIds,
      streamWatchdog: state.streamWatchdog,
    };
    try {
      state.transcript = new TranscriptStore(0);
      state.pendingForceMessageText = WRAP_UP_MESSAGE;
      state.forceMessageItemIds = new Set();
      let noteAssistantResponseDoneCalls = 0;
      state.streamWatchdog = {
        noteAssistantDelta: () => {},
        noteAssistantResponseDone: () => {
          noteAssistantResponseDoneCalls += 1;
        },
      };

      const fakeSession = {};
      wireSessionHooks(fakeSession);

      const FORCE_MESSAGE_ITEM_ID = "item-force-message-real-shape";
      // The exact real event shape: response.output_audio_transcript.done
      // for a brand-new item id, empty transcript.
      fakeSession.onAssistantTranscriptDone(FORCE_MESSAGE_ITEM_ID, "");

      const entry = state.transcript.toJSON().find((e) => e.item_id === FORCE_MESSAGE_ITEM_ID);
      if (!entry) throw new Error("no transcript entry was created for the force_message's item id");
      if (entry.text !== WRAP_UP_MESSAGE) throw new Error(`expected the real wrap-up text, got ${JSON.stringify(entry.text)}`);
      if (entry.text.length === 0) throw new Error("regression: the force_message entry is empty, exactly the original bug");
      if (!entry.forced) throw new Error("force_message entry was not marked forced:true");
      if (state.pendingForceMessageText !== null) throw new Error("pendingForceMessageText was not cleared after being claimed");
      if (noteAssistantResponseDoneCalls !== 0) {
        throw new Error(`noteAssistantResponseDone was called ${noteAssistantResponseDoneCalls} time(s) for a force_message item id -- it must be excluded entirely, not just recorded non-empty`);
      }

      // A second, later event for the SAME item id (e.g. a delta arriving
      // after the claiming .done) must be swallowed too, not duplicate
      // the entry or trigger the watchdog.
      fakeSession.onAssistantTranscriptDelta(FORCE_MESSAGE_ITEM_ID, "should be ignored");
      const entriesAfterSecondEvent = state.transcript.toJSON().filter((e) => e.item_id === FORCE_MESSAGE_ITEM_ID);
      if (entriesAfterSecondEvent.length !== 1 || entriesAfterSecondEvent[0].text !== WRAP_UP_MESSAGE) {
        throw new Error("a later event for the already-claimed item id altered or duplicated the entry");
      }

      // A genuinely unrelated new item id, with no pending force_message,
      // must go through the NORMAL path untouched -- proves this cannot
      // swallow a real turn.
      fakeSession.onAssistantTranscriptDone("item-totally-unrelated", "a real generated answer");
      const unrelatedEntry = state.transcript.toJSON().find((e) => e.item_id === "item-totally-unrelated");
      if (!unrelatedEntry || unrelatedEntry.text !== "a real generated answer" || unrelatedEntry.forced) {
        throw new Error("an unrelated real turn was mishandled by the force_message claim logic");
      }
      if (noteAssistantResponseDoneCalls !== 1) {
        throw new Error(`expected exactly 1 noteAssistantResponseDone call (for the real unrelated turn), got ${noteAssistantResponseDoneCalls}`);
      }

      return { forcedText: entry.text, forcedFlag: entry.forced, noteAssistantResponseDoneCallsForForceMessage: 0, unrelatedTurnHandledNormally: true };
    } finally {
      state.transcript = previous.transcript;
      state.pendingForceMessageText = previous.pendingForceMessageText;
      state.forceMessageItemIds = previous.forceMessageItemIds;
      state.streamWatchdog = previous.streamWatchdog;
    }
  });

  await check("response-lifecycle-diagnostics-wired", () => {
    // Diagnostics-only addition (the user asked for evidence-gathering, not a
    // fix, for a real session's unexplained 59s response-generation gap
    // that the stream watchdog never flagged since inbound events kept
    // arriving). Proves the wiring: RealtimeSession must expose
    // onResponseCreated (a new hook, symmetric with the existing
    // onResponseDone), and wireSessionHooks()'s real handlers must log
    // response-created/response-done into window.__IM_DIAG__ with a
    // response id + elapsed-time pairing, using throwaway fake objects --
    // never a real session.
    const session = new RealtimeSession({ model: MODEL });
    if (!("onResponseCreated" in session)) throw new Error("RealtimeSession no longer exposes onResponseCreated");

    const before = window.__IM_DIAG__.length;
    const fakeSession = {};
    wireSessionHooks(fakeSession);
    if (typeof fakeSession.onResponseCreated !== "function") throw new Error("wireSessionHooks() did not install onResponseCreated");
    if (typeof fakeSession.onResponseDone !== "function") throw new Error("wireSessionHooks() did not install onResponseDone");

    const RESPONSE_ID = "resp_selftest_" + Math.random().toString(36).slice(2);
    fakeSession.onResponseCreated({ type: "response.created", response: { id: RESPONSE_ID, output: [] } });
    fakeSession.onResponseDone({ type: "response.done", response: { id: RESPONSE_ID, output: [{ id: "item_x", type: "message" }] } });

    const entries = window.__IM_DIAG__.slice(before);
    const createdEntry = entries.find((e) => e.stage === "response-created" && e.detail && e.detail.responseId === RESPONSE_ID);
    const doneEntry = entries.find((e) => e.stage === "response-done" && e.detail && e.detail.responseId === RESPONSE_ID);
    if (!createdEntry) throw new Error("response-created diagnostic was not logged");
    if (!doneEntry) throw new Error("response-done diagnostic was not logged");
    if (typeof doneEntry.detail.elapsedMs !== "number") throw new Error("response-done diagnostic did not compute elapsedMs");
    if (doneEntry.detail.elapsedMs < 0) throw new Error(`elapsedMs was negative: ${doneEntry.detail.elapsedMs}`);
    if (!Array.isArray(doneEntry.detail.outputItemIds) || !doneEntry.detail.outputItemIds.includes("item_x")) {
      throw new Error("response-done diagnostic did not capture output item ids");
    }

    return { createdEntry, doneEntry };
  });

  await check("server-side-tool-call-never-answered", async () => {
    // Proves the root-cause fix, end to end, against the REAL
    // RealtimeSession class (not a reimplementation): a server-side tool
    // call (file_search, which arrives under the name "collections_search"
    // -- the real, verified shape from a real session) must produce NO
    // function_call_output and must NEVER reach onToolCallsSettled (which
    // is what triggered an unsolicited response.create that pre-empted a
    // user's in-flight answer and made the model duplicate/truncate its
    // own previous turn). A genuinely local function tool
    // (lookup_documents) must still work exactly as before: output sent,
    // THEN onToolCallsSettled fires.
    //
    // Uses a real RealtimeSession instance with `ws` swapped for a fake
    // that just records what would have been sent over the wire, and
    // calls the instance's own message handler directly with the exact
    // real event shape -- never touches a real WebSocket or a real
    // interview.
    const sentMessages = [];
    const fakeWs = {
      readyState: WebSocket.OPEN,
      send: (str) => sentMessages.push(JSON.parse(str)),
    };

    const eventLog = []; // ordered labels, to prove output-before-settled ordering for the local case

    const session = new RealtimeSession({ model: MODEL, localFunctionNames: ["lookup_documents"] });
    session.ws = fakeWs; // bypass connect() -- this test never opens a real socket

    const serverToolCalls = [];
    session.onServerToolCall = (info) => serverToolCalls.push(info);
    session.onFunctionCall = async ({ name, arguments: args }) => {
      eventLog.push("onFunctionCall");
      if (name === "lookup_documents") return { results: [`fake result for ${args.query}`] };
      throw new Error(`onFunctionCall was called for a non-local name "${name}" -- this must never happen, RealtimeSession should have gated it out`);
    };
    let settledCalls = 0;
    session.onToolCallsSettled = () => {
      settledCalls += 1;
      eventLog.push("onToolCallsSettled");
    };

    // --- Server-side tool call: file_search, arrives as "collections_search" ---
    await session._handleMessage({
      data: JSON.stringify({
        type: "response.function_call_arguments.done",
        name: "collections_search",
        call_id: "call_server_1",
        arguments: JSON.stringify({ query: "SLICC architecture" }),
      }),
    });

    if (sentMessages.length !== 0) {
      throw new Error(`a server-side tool call produced ${sentMessages.length} outbound message(s) -- must be 0 (no function_call_output, no response.create)`);
    }
    if (settledCalls !== 0) throw new Error(`onToolCallsSettled fired ${settledCalls} time(s) for a server-side tool call -- must be 0`);
    if (serverToolCalls.length !== 1 || serverToolCalls[0].name !== "collections_search" || serverToolCalls[0].callId !== "call_server_1") {
      throw new Error(`onServerToolCall did not fire correctly for the server-side call: ${JSON.stringify(serverToolCalls)}`);
    }
    const serverSideResult = { sentMessages: sentMessages.length, settledCalls, serverToolCalls: serverToolCalls.length };

    // --- Genuinely local tool call: lookup_documents -- must be unaffected ---
    await session._handleMessage({
      data: JSON.stringify({
        type: "response.function_call_arguments.done",
        name: "lookup_documents",
        call_id: "call_local_1",
        arguments: JSON.stringify({ query: "vanilla JS" }),
      }),
    });

    if (sentMessages.length !== 1) throw new Error(`lookup_documents should have produced exactly 1 outbound function_call_output, got ${sentMessages.length}`);
    const sent = sentMessages[0];
    if (sent.type !== "conversation.item.create" || !sent.item || sent.item.type !== "function_call_output" || sent.item.call_id !== "call_local_1") {
      throw new Error(`lookup_documents' outbound message has the wrong shape: ${JSON.stringify(sent)}`);
    }
    if (settledCalls !== 1) throw new Error(`onToolCallsSettled should have fired exactly once for lookup_documents, fired ${settledCalls} time(s)`);
    if (eventLog.join(",") !== "onFunctionCall,onToolCallsSettled") {
      throw new Error(`wrong ordering -- expected output to be sent (via onFunctionCall's return) BEFORE onToolCallsSettled, got: ${eventLog.join(",")}`);
    }
    // The server-side call from before must still not have produced
    // anything retroactively, and its onServerToolCall count is unchanged.
    if (serverToolCalls.length !== 1) throw new Error("the earlier server-side call was retroactively affected by the local call");

    return {
      serverSideToolCall: serverSideResult,
      localToolCall: { sentMessages: sentMessages.length, settledCalls, eventOrder: eventLog },
    };
  });

  await check("wrapup-controller-constructed", () => {
    // Loader-array wiring check: createWrapupController must have been
    // destructured from wrapup-controller.js, and the object it returns
    // must expose everything beginSession()/wireSessionHooks()/
    // startCountdown() call.
    if (typeof createWrapupController !== "function") throw new Error("createWrapupController was not loaded from wrapup-controller.js");
    const wd = createWrapupController({ wrapAtMs: 1000 });
    const methods = ["noteUserSpeechStarted", "noteUserSpeechStopped", "noteResponseCreated", "noteResponseDone", "poll", "getEvents", "getStatus"];
    const missing = methods.filter((m) => typeof wd[m] !== "function");
    if (missing.length) throw new Error(`WrapupController missing methods: ${missing.join(", ")}`);
    return { methodsPresent: methods };
  });

  await check("wrapup-directive-immediate-fallback-still-defers-and-appends-instructions", () => {
    // Exercises the REAL WrapupController + the REAL appendWrapupDirective()
    // helper (the exact function beginSession()'s sendDirective callback
    // uses) end to end, against a fake session recording outbound
    // messages -- no real timers, time driven purely by the elapsedMs
    // (and, for silence, the playbackDrained boolean) values fed to
    // poll() (see wrapup-controller.js's own header for why that is the
    // "injectable clock" for this module: it never reads a real clock or
    // touches audio for its decisions at all).
    //
    // Proves the ROUND 2 correction (round 1 deferred the silent
    // directive send while the user was speaking, which lost a real race
    // against the model's own next turn in production
    // (a recorded session)) AND the ROUND 3 additions (the
    // time-check tool-result channel the user verified against the live API,
    // and stopping on sustained silence rather than only on a recognised
    // closing turn):
    //   (a) the time-check tool result AND the directive are BOTH sent
    //       IMMEDIATELY at the threshold, even WHILE the user is
    //       actively speaking -- never deferred, with the right item
    //       shape for the tool result;
    //   (b) the instructions update APPENDS to the real instructions,
    //       never replaces them;
    //   (c) the fallback, unlike the time-check/directive, DOES still
    //       defer indefinitely while the user is speaking;
    //   (d) the fallback never fires while a response that might still
    //       be the natural closing turn is actively in flight;
    //   (e) a natural close (onClosingTurnComplete) fires instead of the
    //       fallback when the model closes in time on its own;
    //   (f) if nothing closes it naturally, the fallback still fires
    //       eventually, once the user is not speaking;
    //   (g) stop-on-silence fires only once ALL THREE conditions (not
    //       speaking, no response in flight, playback drained) have held
    //       CONTINUOUSLY for the full sustain window -- any interruption
    //       resets the clock;
    //   (h) continuous user speech, forever, never triggers the fallback
    //       or stop-on-silence -- only the host's own separate hard
    //       backstop (never reachable from this module) can end that
    //       session, confirmed via the real HARD_BACKSTOP_GRACE_MS
    //       constant.
    const ORIGINAL_INSTRUCTIONS = "You are an interviewer. Ask about the anti-stack.";
    const WRAP_AT_MS = 1000;
    const FALLBACK_DELAY_MS = 2000;

    // --- Part 1: time-check + directive sent immediately DESPITE active
    // user speech, right item shape, append-not-replace,
    // fallback-blocked-by-an-in-flight-response, then a natural close. ---
    {
      let liveInstructions = ORIGINAL_INSTRUCTIONS;
      const sentUpdates = [];
      const sentTimeChecks = [];
      const sentForceMessages = [];
      let closingCompleteCalls = 0;
      const fakeSession = {
        isOpen: () => true,
        updateSession: (patch) => sentUpdates.push(patch),
        sendFunctionCallOutput: (callId, output) => sentTimeChecks.push({ callId, output }),
        sendForceMessage: (text, interruptible) => sentForceMessages.push({ text, interruptible }),
      };
      const wd = createWrapupController({
        wrapAtMs: WRAP_AT_MS,
        fallbackDelayMs: FALLBACK_DELAY_MS,
        sendTimeCheck: () => fakeSession.sendFunctionCallOutput(WRAP_UP_TIME_CHECK_CALL_ID, WRAP_UP_TIME_CHECK_PAYLOAD),
        sendDirective: () => {
          const updated = appendWrapupDirective(liveInstructions, WRAP_UP_DIRECTIVE);
          liveInstructions = updated;
          fakeSession.updateSession({ instructions: updated });
        },
        sendFallbackMessage: () => fakeSession.sendForceMessage(WRAP_UP_MESSAGE, true),
        onClosingTurnComplete: () => {
          closingCompleteCalls += 1;
        },
      });

      wd.poll(500); // before the threshold -- nothing should happen yet
      if (sentUpdates.length !== 0 || sentTimeChecks.length !== 0) throw new Error("time-check/directive were sent before the wrap-up threshold");

      // THE ROUND-2/3 FIX ITSELF: the user is actively speaking, right
      // through and past the threshold -- BOTH the time-check and the
      // directive must still fire the instant they're due, because
      // neither emits audio and neither can interrupt anyone. Deferring
      // either (round 1's mistake) is what lost the real race in
      // production.
      wd.noteUserSpeechStarted();
      wd.poll(1200); // past threshold, user STILL speaking
      if (sentTimeChecks.length !== 1) {
        throw new Error(`the time-check tool result must be sent IMMEDIATELY at the threshold even while the user is speaking -- got ${sentTimeChecks.length}`);
      }
      const tc = sentTimeChecks[0];
      if (tc.callId !== WRAP_UP_TIME_CHECK_CALL_ID) throw new Error(`time-check call_id mismatch: ${JSON.stringify(tc.callId)}`);
      if (!tc.output || tc.output.time_check !== WRAP_UP_TIME_CHECK_PAYLOAD.time_check) {
        throw new Error(`time-check payload did not match WRAP_UP_TIME_CHECK_PAYLOAD: ${JSON.stringify(tc.output)}`);
      }
      if (sentUpdates.length !== 1) {
        throw new Error(`directive must be sent IMMEDIATELY at the threshold even while the user is speaking (it is silent, it cannot interrupt) -- got ${sentUpdates.length} update(s)`);
      }
      const sentInstructions = sentUpdates[0] && sentUpdates[0].instructions;
      if (typeof sentInstructions !== "string" || !sentInstructions.startsWith(ORIGINAL_INSTRUCTIONS)) {
        throw new Error(`instructions were not appended (original text missing/not a prefix): ${JSON.stringify(sentInstructions)}`);
      }
      if (!sentInstructions.includes(WRAP_UP_DIRECTIVE)) throw new Error("sent instructions did not include the wrap-up directive");
      if (sentInstructions === WRAP_UP_DIRECTIVE) throw new Error("instructions were REPLACED with just the directive, not appended to the original");

      // Still speaking, well past the fallback delay too -- the FALLBACK
      // (unlike the time-check/directive) must still defer, because it
      // is audible.
      wd.poll(1200 + FALLBACK_DELAY_MS + 500);
      if (sentForceMessages.length !== 0) throw new Error("fallback fired WHILE THE USER WAS SPEAKING -- must never happen, this is the one stage that can actually interrupt");

      wd.noteUserSpeechStopped();

      // A genuine response starts (the presumed closing turn) right as
      // the fallback window would otherwise open -- must NOT fire the
      // fallback while it's still in flight.
      wd.noteResponseCreated();
      wd.poll(1200 + FALLBACK_DELAY_MS + 800);
      if (sentForceMessages.length !== 0) throw new Error("fallback fired while a genuine (potentially closing) response was still in flight");

      // That response completes -- this IS the natural close.
      wd.noteResponseDone();
      if (closingCompleteCalls !== 1) throw new Error("onClosingTurnComplete did not fire when the closing response completed naturally");
      if (sentForceMessages.length !== 0) throw new Error("fallback fired even though the closing turn completed naturally -- it must never fire once a natural close has happened");
      if (sentUpdates.length !== 1) throw new Error(`the directive must only ever be sent once, got ${sentUpdates.length}`);
      if (sentTimeChecks.length !== 1) throw new Error(`the time-check must only ever be sent once, got ${sentTimeChecks.length}`);
    }

    // --- Part 2: fresh instance -- the time-check/directive fire
    // immediately with NO speech at all (the common case), and the
    // fallback still defers while the user is speaking but DOES
    // eventually fire once they stop, if nothing closed the conversation
    // naturally. ---
    let fallbackFireCount;
    {
      const sentUpdates2 = [];
      const sentForceMessages2 = [];
      const wd2 = createWrapupController({
        wrapAtMs: WRAP_AT_MS,
        fallbackDelayMs: FALLBACK_DELAY_MS,
        sendTimeCheck: () => {},
        sendDirective: () => sentUpdates2.push(true),
        sendFallbackMessage: () => sentForceMessages2.push(true),
      });
      wd2.poll(WRAP_AT_MS); // sends the time-check + directive (not speaking by default)
      if (sentUpdates2.length !== 1) throw new Error("directive was not sent at the threshold with no speech in progress");

      wd2.noteUserSpeechStarted();
      wd2.poll(WRAP_AT_MS + FALLBACK_DELAY_MS + 500); // well past the fallback delay, but user IS speaking
      if (sentForceMessages2.length !== 0) throw new Error("fallback fired WHILE THE USER WAS SPEAKING -- must never happen, this is the exact class of bug every round of this fix has been about");

      wd2.noteUserSpeechStopped();
      wd2.poll(WRAP_AT_MS + FALLBACK_DELAY_MS + 600); // now not speaking, well past the delay -- should fire now
      if (sentForceMessages2.length !== 1) throw new Error(`fallback did not fire after the delay once the user stopped speaking, got ${sentForceMessages2.length} fallback(s)`);
      fallbackFireCount = sentForceMessages2.length;
    }

    // --- Part 3: sustained silence, with resets. Fresh instance, short
    // silenceSustainMs so this stays fast. ---
    let silenceFireCount;
    {
      let sustainedSilenceCalls = 0;
      const wd3 = createWrapupController({
        wrapAtMs: WRAP_AT_MS,
        fallbackDelayMs: FALLBACK_DELAY_MS,
        silenceSustainMs: 1000,
        sendTimeCheck: () => {},
        sendDirective: () => {},
        onSustainedSilence: () => {
          sustainedSilenceCalls += 1;
        },
      });

      wd3.poll(WRAP_AT_MS, true); // sends the time-check/directive; the threshold poll itself never reaches the silence check (returns early)
      if (sustainedSilenceCalls !== 0) throw new Error("sustained silence fired on the threshold poll itself");

      wd3.poll(WRAP_AT_MS + 50, true); // quiet -- window starts here (elapsed 1050)
      wd3.poll(WRAP_AT_MS + 400, true); // still quiet, ~350ms in -- not yet
      if (sustainedSilenceCalls !== 0) throw new Error("sustained silence fired before the full window elapsed");

      // A response starts and finishes -- this MUST reset the quiet clock.
      wd3.noteResponseCreated();
      wd3.poll(WRAP_AT_MS + 500, true);
      if (sustainedSilenceCalls !== 0) throw new Error("silence was detected while a response was in flight");
      wd3.noteResponseDone();

      // Playback hasn't drained yet either -- must not count as quiet.
      wd3.poll(WRAP_AT_MS + 600, false);
      if (sustainedSilenceCalls !== 0) throw new Error("silence fired before playback finished draining");

      // Now genuinely quiet again -- the window must restart from HERE,
      // not from the original threshold or the earlier partial window.
      wd3.poll(WRAP_AT_MS + 700, true); // window restarts at elapsed 1700
      wd3.poll(WRAP_AT_MS + 1600, true); // ~900ms of continuous quiet since the restart -- still short
      if (sustainedSilenceCalls !== 0) throw new Error("sustained silence fired before a FULL window of CONTINUOUS quiet following the reset -- the clock must restart on each interruption, not accumulate");

      wd3.poll(WRAP_AT_MS + 1700, true); // now a full 1000ms of continuous quiet since the restart at elapsed 1700
      if (sustainedSilenceCalls !== 1) throw new Error(`sustained silence did not fire after the full continuous window, got ${sustainedSilenceCalls} call(s)`);

      // Must fire exactly once -- further polls must not re-fire it.
      wd3.poll(WRAP_AT_MS + 5000, true);
      if (sustainedSilenceCalls !== 1) throw new Error(`sustained silence fired more than once: ${sustainedSilenceCalls}`);
      silenceFireCount = sustainedSilenceCalls;
    }

    // --- Part 4: continuous speech, forever -- neither the fallback nor
    // stop-on-silence may ever fire; only the host's own hard backstop
    // (entirely separate from this module) can end a session where the
    // user simply never stops talking. ---
    {
      let sentUpdates4 = 0;
      let fallbackCalls4 = 0;
      let silenceCalls4 = 0;
      const wd4 = createWrapupController({
        wrapAtMs: WRAP_AT_MS,
        fallbackDelayMs: FALLBACK_DELAY_MS,
        silenceSustainMs: 1000,
        sendTimeCheck: () => {},
        sendDirective: () => {
          sentUpdates4 += 1;
        },
        sendFallbackMessage: () => {
          fallbackCalls4 += 1;
        },
        onSustainedSilence: () => {
          silenceCalls4 += 1;
        },
      });
      wd4.noteUserSpeechStarted();
      // Simulate a full 10 minutes of CONTINUOUS speech, well beyond both
      // the fallback delay and the silence window.
      for (let elapsed = 0; elapsed <= 600000; elapsed += 5000) {
        wd4.poll(elapsed, true);
      }
      if (sentUpdates4 !== 1) throw new Error(`the (silent) directive must still fire exactly once despite continuous speech, got ${sentUpdates4}`);
      if (fallbackCalls4 !== 0) throw new Error("the fallback fired despite continuous speech -- must defer forever if the user never stops talking");
      if (silenceCalls4 !== 0) throw new Error("sustained silence fired despite continuous speech -- impossible, userSpeaking was never false");
    }

    // The actual session-ending backstop for exactly the Part 4 scenario
    // lives entirely OUTSIDE this module, in startCountdown()'s own
    // tick() -- `elapsed >= sessionLengthMs + HARD_BACKSTOP_GRACE_MS`.
    // Not reachable from here without a live session; assert the real
    // constant directly instead, so a future edit that shrinks it to
    // something negligible (or removes it) fails this check.
    if (typeof HARD_BACKSTOP_GRACE_MS !== "number" || HARD_BACKSTOP_GRACE_MS < 30000) {
      throw new Error(`HARD_BACKSTOP_GRACE_MS (${HARD_BACKSTOP_GRACE_MS}) is not a real, meaningful margin past the nominal session length`);
    }
    const backstopFor1MinSession = 60000 + HARD_BACKSTOP_GRACE_MS;
    if (backstopFor1MinSession <= 60000) throw new Error("the hard backstop must be strictly beyond the nominal session length");

    return { fallbackFireCount, silenceFireCount, hardBackstopGraceMs: HARD_BACKSTOP_GRACE_MS };
  });

  await check("transcript-markdown-tool-call-ordering", () => {
    // Real evidence (a recorded session): a
    // "collections_search" tool entry timestamped to the EXACT millisecond
    // the preceding assistant entry's t_end_ms landed on -- faithful
    // arrival order in transcript.json, but reads backwards as Markdown:
    // "assistant answered... THEN searched", when the search is what
    // informed that very answer. Exercises the REAL toMarkdown() (and
    // confirms toJSON()'s real arrival order is left untouched) with a
    // fresh, isolated TranscriptStore -- never touches state.transcript.
    const t = new TranscriptStore(0);
    const at = (elapsedMs) => {
      t.t0 = Date.now() - elapsedMs;
    };

    at(1000);
    t.markAssistantFinal("item-a1", "That's a great question about your anti-stack.");
    at(1000); // the tool call lands at the EXACT same elapsed instant as that assistant entry's own t_end_ms, matching real evidence
    t.logTool("collections_search", "");
    at(1200);
    t.setUserTranscript("item-u1", "Thanks, tell me more.");
    t.markUserFinal("item-u1");

    const md = t.toMarkdown();
    const toolLineIdx = md.indexOf("TOOL collections_search");
    const assistantLineIdx = md.indexOf("AGENT: That's a great question");
    if (toolLineIdx === -1 || assistantLineIdx === -1) throw new Error(`expected lines not found in markdown: ${JSON.stringify(md)}`);
    if (!(toolLineIdx < assistantLineIdx)) {
      throw new Error(`TOOL line must precede the assistant line it informed in Markdown, got:\n${md}`);
    }

    // transcript.json (the real entries array) must stay in the FAITHFUL
    // arrival order -- untouched by the Markdown-only reordering.
    const jsonOrder = t.toJSON().map((e) => e.role);
    if (jsonOrder.join(",") !== "assistant,tool,user") {
      throw new Error(`transcript.json's real event order was disturbed by the Markdown-only reordering fix: ${jsonOrder.join(",")}`);
    }

    return { markdown: md, jsonOrder };
  });

  await check("diagnostics-warning-scoping-excludes-pre-session-and-simulated", () => {
    // Real bug this fixes: a genuinely clean interview
    // (a recorded session) reported warningCount:3 with
    // ZERO real faults -- all three were self-test leftovers from ~45
    // minutes earlier in the same page load, still sitting in
    // window.__IM_DIAG__ (never reset per session, only per page load).
    // Exercises the REAL buildDiagnosticsDocument() directly with a
    // synthetic entries array shaped exactly like that real evidence.
    const SESSION_START = 1000000;
    const SESSION_END = 1010000;
    const entries = [
      // Pre-session leftovers -- BEFORE sessionStartMs, exactly like the
      // real ~45-minutes-earlier evidence. Would match the default
      // warning regex (contains "fail") if window scoping did not
      // exclude them.
      { t: SESSION_START - 2713600, stage: "slicc-screenshot-probe-failed", detail: {} },
      { t: SESSION_START - 2701100, stage: "camera-preview-attach-failed:selftest-hang-sim", detail: { simulated: true } },
      { t: SESSION_START - 1987700, stage: "camera-preview-attach-failed:selftest-hang-sim", detail: { simulated: true } },
      // An explicitly-marked simulation that happens to land INSIDE the
      // session window -- must still be excluded, because the MARKER
      // (not the window) is what makes it not-a-warning.
      { t: SESSION_START + 500, stage: "camera-preview-attach-failed:selftest-hang-sim", detail: { simulated: true } },
      // A genuine in-session warning -- MUST still count.
      { t: SESSION_START + 1000, stage: "mic-watchdog:stall", detail: { sinceLastFrameMs: 5000 } },
      // A post-session entry (after endedAt) -- also excluded.
      { t: SESSION_END + 5000, stage: "stream-watchdog:fatal", detail: {} },
    ];

    const doc = buildDiagnosticsDocument(entries, { sessionStartMs: SESSION_START, sessionEndMs: SESSION_END });

    if (doc.summary.warningCount !== 1) {
      throw new Error(`expected exactly 1 in-window, non-simulated warning, got ${doc.summary.warningCount}: ${JSON.stringify(doc.summary.warningStages)}`);
    }
    if (!doc.summary.warningStages.includes("mic-watchdog:stall")) {
      throw new Error("the genuine in-session warning was not counted");
    }
    if (doc.summary.warningStages.includes("slicc-screenshot-probe-failed")) {
      throw new Error("slicc-screenshot-probe-failed must never count as a warning");
    }
    if (doc.summary.warningStages.some((s) => s.includes("selftest-hang-sim"))) {
      throw new Error("a simulated entry was counted as a warning");
    }

    // entries[] itself must still contain everything (for context) --
    // this is additive filtering of the COUNT, never a drop of the raw
    // log -- with out-of-window entries clearly tagged.
    if (doc.entries.length !== entries.length) throw new Error("entries were dropped, not just excluded from the warning count");
    const preSessionCount = doc.entries.filter((e) => e.phase === "pre-session").length;
    if (preSessionCount !== 3) throw new Error(`expected 3 entries tagged phase:"pre-session", got ${preSessionCount}`);
    const postSessionCount = doc.entries.filter((e) => e.phase === "post-session").length;
    if (postSessionCount !== 1) throw new Error(`expected 1 entry tagged phase:"post-session", got ${postSessionCount}`);

    // Confirm slicc-screenshot-probe-failed is excluded unconditionally
    // (KNOWN_BENIGN_STAGES), independent of window scoping -- never
    // assume the two protections overlap the way you'd expect; check it
    // directly. Even placed INSIDE the session window, it must not count.
    const inWindowDoc = buildDiagnosticsDocument([{ t: SESSION_START + 100, stage: "slicc-screenshot-probe-failed", detail: {} }], {
      sessionStartMs: SESSION_START,
      sessionEndMs: SESSION_END,
    });
    if (inWindowDoc.summary.warningCount !== 0) {
      throw new Error("slicc-screenshot-probe-failed counted as a warning even when placed INSIDE the session window -- it must be excluded unconditionally, not just by window scoping");
    }
    if (inWindowDoc.entries[0].phase) {
      throw new Error("the in-window placement test's entry was unexpectedly tagged with a phase -- test construction bug");
    }

    return {
      warningCount: doc.summary.warningCount,
      warningStages: doc.summary.warningStages,
      preSessionCount,
      postSessionCount,
      screenshotProbeExcludedEvenInWindow: inWindowDoc.summary.warningCount === 0,
    };
  });

  report.finishedAt = new Date().toISOString();
  report.allOk = report.checks.every((c) => c.ok);
  try {
    await slicc.writeFile(`${BASE_DIR}/selftest-report.json`, JSON.stringify(report, null, 2));
  } catch (err) {
    /* best effort */
  }
  window.__imDiag && window.__imDiag("selftest-complete", { allOk: report.allOk });
  return report;
}

export async function captureVerificationScreenshot(path) {
  try {
    const dataUrl = await slicc.screenshot();
    const base64 = dataUrl.split(",")[1] || dataUrl;
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    await slicc.writeFileBinary(path, bytes);
    window.__imDiag && window.__imDiag("screenshot-written", { path, bytes: bytes.length });
  } catch (err) {
    window.__imDiag && window.__imDiag("screenshot-error", { message: err.message });
  }
}
