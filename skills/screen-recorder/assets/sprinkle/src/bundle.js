(() => {
  // workspace/skills/interview-me/assets/sprinkle/lib/chunk-flusher.js
  var PART_WRITE_TIMEOUT_MS = 15e3;
  var ASSEMBLE_TIMEOUT_MS = 18e4;
  var MAX_ATTEMPTS = 3;
  var RETRY_BACKOFF_MS = 120;
  var MAX_PENDING_BYTES = 32 * 1024 * 1024;
  var TARGET_PART_BYTES = 1024 * 1024;
  var isTransient = (err) => {
    const name = err && err.name ? String(err.name) : "";
    const msg = err && err.message ? String(err.message) : "";
    return name === "NotReadableError" || name === "InvalidStateError" || name === "AbortError" || /NotReadableError|InvalidStateError|invalidated|snapshot|timed out|timeout/i.test(msg);
  };
  var sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  function createChunkFlusher({
    slicc: slicc2,
    withTimeout: withTimeout2,
    partsDir,
    name,
    onDiagnostic,
    releaseAfterFlush = false,
    partWriteTimeoutMs = PART_WRITE_TIMEOUT_MS,
    assembleTimeoutMs = ASSEMBLE_TIMEOUT_MS,
    maxAttempts = MAX_ATTEMPTS,
    retryBackoffMs = RETRY_BACKOFF_MS,
    maxPendingBytes = MAX_PENDING_BYTES,
    targetPartBytes = TARGET_PART_BYTES
  }) {
    const diag = (stage, detail) => {
      try {
        if (onDiagnostic) onDiagnostic(stage, detail);
      } catch (err) {
      }
    };
    const stats = {
      name,
      chunksQueued: 0,
      chunksFlushed: 0,
      partsWritten: 0,
      bytesWritten: 0,
      retries: 0,
      retriedCalls: 0,
      failedParts: 0,
      droppedForBackpressure: 0,
      peakPendingBytes: 0,
      maxAttemptsSeen: 0,
      assembly: null,
      lastError: null
    };
    const queue = [];
    let pendingBytes = 0;
    let draining = false;
    let dirReady = null;
    let nextPartIndex = 0;
    let closed = false;
    let poisoned = false;
    async function attempt(label, fn, timeoutMs) {
      let lastErr;
      for (let n = 1; n <= maxAttempts; n++) {
        try {
          const result = await withTimeout2(Promise.resolve().then(fn), timeoutMs, `${name}:${label}`);
          if (n > 1) {
            stats.retriedCalls++;
            stats.maxAttemptsSeen = Math.max(stats.maxAttemptsSeen, n);
            diag("chunk-flush:retry-succeeded", { name, label, attempts: n, error: lastErr && lastErr.message });
          }
          return result;
        } catch (err) {
          lastErr = err;
          const transient = isTransient(err);
          if (n < maxAttempts && transient) {
            stats.retries++;
            stats.maxAttemptsSeen = Math.max(stats.maxAttemptsSeen, n);
            diag("chunk-flush:retry", { name, label, attempt: n, of: maxAttempts, errorName: err && err.name, message: err && err.message });
            await sleep(retryBackoffMs * n);
            continue;
          }
          diag("chunk-flush:call-failed", {
            name,
            label,
            attempts: n,
            transient,
            errorName: err && err.name,
            message: err && err.message
          });
          throw err;
        }
      }
      throw lastErr;
    }
    async function ensureDir() {
      if (!dirReady) {
        dirReady = attempt("mkdir", () => slicc2.mkdir(partsDir), partWriteTimeoutMs).catch((err) => {
          dirReady = null;
          throw err;
        });
      }
      return dirReady;
    }
    const partName = (i) => `${partsDir}/${String(i).padStart(6, "0")}.part`;
    async function drain() {
      if (draining) return;
      draining = true;
      try {
        while (queue.length) {
          const batch = [];
          let batchBytes = 0;
          while (queue.length && (batch.length === 0 || batchBytes + queue[0].size <= targetPartBytes)) {
            const item = queue.shift();
            pendingBytes -= item.size;
            batch.push(item);
            batchBytes += item.size;
            if (batchBytes >= targetPartBytes) break;
          }
          const partIndex = nextPartIndex++;
          try {
            await ensureDir();
            const bytes = new Uint8Array(
              await new Blob(batch.map((b) => b.blob)).arrayBuffer()
            );
            await attempt(`write-part-${partIndex}`, () => slicc2.writeFileBinary(partName(partIndex), bytes), partWriteTimeoutMs);
            stats.partsWritten++;
            stats.bytesWritten += bytes.length;
            stats.chunksFlushed += batch.length;
            if (releaseAfterFlush) {
              for (const b of batch) if (b.release) b.release();
            }
          } catch (err) {
            stats.failedParts++;
            stats.lastError = err && err.message;
            poisoned = true;
            diag("chunk-flush:part-lost", { name, partIndex, chunks: batch.length, message: err && err.message });
          }
        }
      } finally {
        draining = false;
      }
    }
    return {
      /** Called from MediaRecorder.ondataavailable. Never throws, never awaits. */
      append(blob, release) {
        if (closed || !blob || !blob.size) return;
        if (pendingBytes + blob.size > maxPendingBytes) {
          stats.droppedForBackpressure++;
          poisoned = true;
          diag("chunk-flush:backpressure", { name, pendingBytes, size: blob.size, maxPendingBytes });
          return;
        }
        queue.push({ blob, size: blob.size, release });
        pendingBytes += blob.size;
        stats.chunksQueued++;
        stats.peakPendingBytes = Math.max(stats.peakPendingBytes, pendingBytes);
        drain();
      },
      /** Wait for the queue to empty. Resolves even if some parts were lost. */
      async settle() {
        await drain();
        let guard = 0;
        while ((queue.length || draining) && guard++ < 600) await sleep(50);
        return { ...stats, pendingBytes, queueLength: queue.length };
      },
      /** True when the on-disk part sequence is complete and safe to assemble. */
      isUsable() {
        return !poisoned && stats.partsWritten > 0 && stats.failedParts === 0 && stats.droppedForBackpressure === 0;
      },
      getStats() {
        return { ...stats, pendingBytes, queueLength: queue.length, usable: !poisoned && stats.failedParts === 0 };
      },
      /**
       * Concatenate the parts into `destPath`.
       * Prefers `exec` (`cat`) so no byte enters the JS heap; falls back to a
       * page-side read+write that is explicitly reported as degraded.
       * Verifies the result's size against the sum of the parts.
       */
      async assemble(destPath) {
        closed = true;
        await this.settle();
        if (!this.isUsable()) {
          const why = poisoned ? "part sequence incomplete" : "no parts written";
          stats.assembly = { ok: false, method: "none", reason: why };
          diag("chunk-flush:assemble-skipped", { name, reason: why, stats: this.getStats() });
          return stats.assembly;
        }
        const expectedBytes = stats.bytesWritten;
        let method = null;
        let err0 = null;
        if (typeof slicc2.exec === "function") {
          try {
            const cmd = `cd ${partsDir} && cat *.part > ${destPath}`;
            const r = await attempt("assemble-exec", () => slicc2.exec(cmd), assembleTimeoutMs);
            if (r && r.exitCode === 0) method = "exec-cat";
            else err0 = new Error(`exec exit ${r && r.exitCode}: ${String(r && r.stderr || "").slice(0, 200)}`);
          } catch (err) {
            err0 = err;
          }
        } else {
          err0 = new Error("slicc.exec unavailable");
        }
        if (!method) {
          diag("chunk-flush:assemble-fallback", { name, reason: err0 && err0.message });
          try {
            const entries = await attempt("readDir-parts", () => slicc2.readDir(partsDir), assembleTimeoutMs);
            const names = (entries || []).map((e) => typeof e === "string" ? e : e && e.name).filter((n) => n && n.endsWith(".part")).sort();
            const buf = new Uint8Array(expectedBytes);
            let off = 0;
            for (const n of names) {
              const part = await attempt(`read-part-${n}`, () => slicc2.readFileBinary(`${partsDir}/${n}`), partWriteTimeoutMs);
              const u8 = part instanceof Uint8Array ? part : new Uint8Array(part);
              buf.set(u8, off);
              off += u8.length;
            }
            await attempt("write-assembled", () => slicc2.writeFileBinary(destPath, buf.subarray(0, off)), assembleTimeoutMs);
            method = "page-fallback";
          } catch (err) {
            stats.assembly = { ok: false, method: "failed", reason: err && err.message, expectedBytes };
            diag("chunk-flush:assemble-failed", { name, message: err && err.message });
            return stats.assembly;
          }
        }
        let actualBytes = null;
        try {
          const st = await attempt("stat-assembled", () => slicc2.stat(destPath), partWriteTimeoutMs);
          actualBytes = st && (st.size != null ? st.size : st.length);
        } catch (err) {
          actualBytes = null;
        }
        const ok = actualBytes === expectedBytes;
        stats.assembly = { ok, method, expectedBytes, actualBytes, parts: stats.partsWritten, degraded: method === "page-fallback" };
        diag(ok ? "chunk-flush:assembled" : "chunk-flush:assemble-size-mismatch", { name, ...stats.assembly });
        return stats.assembly;
      },
      /**
       * Remove the scratch parts. Best-effort: never fail a save over cleanup.
       *
       * MEASURED: the sprinkle bridge's `rm` does NOT honour a
       * `{ recursive: true }` option -- `slicc.rm(dir, { recursive: true })` on a
       * populated directory rejects with
       * "ENOTEMPTY: directory not empty, rmdir '<dir>'". Found because this very
       * method reported `chunk-flush:cleanup-failed` in diagnostics, which is
       * exactly why cleanup failures are reported rather than swallowed: left
       * unfixed, every save would leak its part files under PARTS_ROOT forever.
       * So: `exec` `rm -rf` first, then an explicit file-by-file fallback.
       */
      async cleanup() {
        if (typeof slicc2.exec === "function") {
          try {
            const r = await attempt("cleanup-exec", () => slicc2.exec(`rm -rf ${partsDir}`), assembleTimeoutMs);
            if (r && r.exitCode === 0) return true;
          } catch (err) {
          }
        }
        try {
          const entries = await attempt("cleanup-readdir", () => slicc2.readDir(partsDir), assembleTimeoutMs);
          for (const e of entries || []) {
            const n = typeof e === "string" ? e : e && e.name;
            if (n) await slicc2.rm(`${partsDir}/${n}`).catch(() => {
            });
          }
          await slicc2.rm(partsDir).catch(() => {
          });
          return true;
        } catch (err) {
          diag("chunk-flush:cleanup-failed", { name, message: err && err.message });
          return false;
        }
      }
    };
  }

  // shared/sprinkles/recording-setup/src/with-timeout.js
  function withTimeout(promise, ms, label) {
    return new Promise((resolve, reject) => {
      let done = false;
      const t = setTimeout(() => {
        if (done) return;
        done = true;
        reject(new Error(`timeout after ${ms}ms: ${label}`));
      }, ms);
      Promise.resolve(promise).then(
        (v) => {
          if (done) return;
          done = true;
          clearTimeout(t);
          resolve(v);
        },
        (e) => {
          if (done) return;
          done = true;
          clearTimeout(t);
          reject(e);
        }
      );
    });
  }

  // shared/sprinkles/recording-setup/src/duration-ladder.js
  var DURATION_LADDER = (() => {
    const v = [0];
    for (let s = 5; s <= 120; s += 5) v.push(s);
    for (let s = 150; s <= 600; s += 30) v.push(s);
    for (let s = 720; s <= 3600; s += 120) v.push(s);
    return v;
  })();
  var INFINITY_INDEX = DURATION_LADDER.length;
  function durationForIndex(i) {
    const idx = Math.max(0, Math.min(INFINITY_INDEX, i | 0));
    return idx === INFINITY_INDEX ? null : DURATION_LADDER[idx];
  }
  function formatDuration(sec) {
    if (sec === null) return "\u221E";
    if (sec === 0) return "0s";
    const h = Math.floor(sec / 3600);
    const m = Math.floor(sec % 3600 / 60);
    const s = sec % 60;
    const out = [];
    if (h) out.push(h + "h");
    if (m) out.push(m + "m");
    if (s) out.push(s + "s");
    return out.join(" ");
  }

  // shared/sprinkles/recording-setup/src/mimes.js
  var VIDEO_AV_MIMES = [
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm"
  ];
  var VIDEO_ONLY_MIMES = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"];
  var AUDIO_MIMES = ["audio/webm;codecs=opus", "audio/webm"];
  function mimesForStream(stream) {
    const v = stream.getVideoTracks().length;
    const a = stream.getAudioTracks().length;
    if (v && a) return VIDEO_AV_MIMES;
    if (v) return VIDEO_ONLY_MIMES;
    return AUDIO_MIMES;
  }
  function pickMime(cands) {
    if (typeof MediaRecorder === "undefined" || !MediaRecorder.isTypeSupported) return cands[0];
    for (const m of cands) if (MediaRecorder.isTypeSupported(m)) return m;
    return cands[cands.length - 1];
  }

  // shared/sprinkles/recording-setup/src/beeps.js
  function createBeeper() {
    let ctx = null;
    let unavailable = false;
    const counters = { ticksScheduled: 0, ticksPlayed: 0, gosScheduled: 0, gosPlayed: 0, lastError: null };
    async function arm() {
      if (unavailable) return null;
      try {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) {
          unavailable = true;
          return null;
        }
        if (!ctx) ctx = new AC();
        if (ctx.state === "suspended") {
          try {
            await ctx.resume();
          } catch (e) {
          }
        }
        return ctx.state;
      } catch (err) {
        unavailable = true;
        return null;
      }
    }
    function beep(freq, durationSec, when, peak) {
      if (!ctx || unavailable) {
        counters.lastError = unavailable ? "audio unavailable" : "context not armed";
        return false;
      }
      try {
        const t = when == null ? ctx.currentTime : when;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sine";
        osc.frequency.setValueAtTime(freq, t);
        const p = peak == null ? 0.22 : peak;
        gain.gain.setValueAtTime(1e-4, t);
        gain.gain.exponentialRampToValueAtTime(p, t + 3e-3);
        gain.gain.exponentialRampToValueAtTime(1e-4, t + durationSec);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(t);
        osc.stop(t + durationSec + 0.02);
        return true;
      } catch (err) {
        counters.lastError = err && err.message || String(err);
        return false;
      }
    }
    function tick() {
      counters.ticksScheduled++;
      if (beep(660, 0.09)) counters.ticksPlayed++;
    }
    function go() {
      counters.gosScheduled += 3;
      if (!ctx || unavailable) {
        counters.lastError = unavailable ? "audio unavailable" : "context not armed";
        return;
      }
      const t0 = ctx.currentTime;
      for (let i = 0; i < 3; i++) if (beep(1040, 0.07, t0 + i * 0.12, 0.26)) counters.gosPlayed++;
    }
    function state() {
      return unavailable ? "unavailable" : ctx ? ctx.state : "not-armed";
    }
    function close() {
      if (ctx && ctx.close) {
        try {
          ctx.close();
        } catch (e) {
        }
      }
      ctx = null;
    }
    function report() {
      return {
        state: state(),
        contextState: ctx ? ctx.state : null,
        sampleRate: ctx ? ctx.sampleRate : null,
        outputLatency: ctx && ctx.outputLatency != null ? ctx.outputLatency : null,
        ticksScheduled: counters.ticksScheduled,
        ticksPlayed: counters.ticksPlayed,
        finalBeepsScheduled: counters.gosScheduled,
        finalBeepsPlayed: counters.gosPlayed,
        lastError: counters.lastError
      };
    }
    return { arm, tick, go, state, report, close };
  }

  // shared/sprinkles/recording-setup/src/tabs.js
  function parseTabList(stdout) {
    const out = [];
    for (let line of (stdout || "").split("\n")) {
      line = line.trim();
      if (!line) continue;
      const m = /^\[([^\]]+)\]\s*(.*)$/.exec(line);
      if (!m) continue;
      const id = m[1];
      const rest = m[2];
      let url = rest;
      let title = "";
      const tm = /^(.*?)\s+"([\s\S]*)"\s*$/.exec(rest);
      if (tm) {
        url = tm[1].trim();
        title = tm[2];
      }
      out.push({ id, url, title });
    }
    return out;
  }
  function foregroundTabCmd(targetId) {
    const id = String(targetId).replace(/[^A-Za-z0-9]/g, "");
    return "IDX=$(playwright-cli tab-list | grep -n " + id + ' | cut -d: -f1); if [ -n "$IDX" ]; then playwright-cli tab-select "$IDX"; else echo "target ' + id + ' not in tab-list" >&2; exit 3; fi';
  }
  function confirmForegrounded(stdout, targetId) {
    const s = String(stdout || "");
    return s.toUpperCase().indexOf(String(targetId).toUpperCase()) !== -1;
  }
  function readViewportCmd(targetId) {
    const id = String(targetId).replace(/[^A-Za-z0-9]/g, "");
    return 'playwright-cli eval "JSON.stringify({iw:innerWidth,ih:innerHeight,ow:outerWidth,oh:outerHeight,dpr:devicePixelRatio,sw:screen.width,sh:screen.height})" --tab=' + id;
  }
  function parseViewport(stdout) {
    const s = String(stdout || "");
    const m = s.match(/\{[^{}]*"iw"[\s\S]*?\}/);
    if (!m) return null;
    try {
      return JSON.parse(m[0]);
    } catch (e) {
      try {
        return JSON.parse(m[0].replace(/\\"/g, '"'));
      } catch (e2) {
        return null;
      }
    }
  }
  function describeResize(requested, before, after, displaySurface) {
    const r = {
      requested: requested || null,
      viewportAfter: after ? after.iw + "x" + after.ih : null,
      outerAfter: after ? after.ow + "x" + after.oh : null,
      dprBefore: before ? before.dpr : null,
      dprAfter: after ? after.dpr : null,
      effectiveForCapture: displaySurface === "browser"
    };
    const viewportChanged = !!(before && after && (before.iw !== after.iw || before.ih !== after.ih));
    const outerChanged = !!(before && after && (before.ow !== after.ow || before.oh !== after.oh));
    r.viewportChanged = viewportChanged;
    r.osWindowChanged = outerChanged;
    if (!after) {
      r.note = "could not read the viewport back \u2014 effect unverified";
    } else if (viewportChanged && !outerChanged && displaySurface !== "browser") {
      r.note = "viewport now " + after.iw + "x" + after.ih + ", OS window unchanged at " + after.ow + "x" + after.oh + " \u2014 a " + (displaySurface || "window/monitor") + " capture frames the OS window, so this does NOT change the recording size" + (before && after.dpr < before.dpr ? "; devicePixelRatio dropped " + before.dpr + "\u2192" + after.dpr + ", which LOWERS captured quality" : "");
    } else if (displaySurface === "browser") {
      r.note = "tab surface captured, so the viewport IS the frame \u2014 resize applies";
    } else {
      r.note = "viewport unchanged \u2014 resize had no measurable effect";
    }
    return r;
  }

  // shared/sprinkles/recording-setup/src/capture-geometry.js
  async function probeCaptureGeometry(stream, track, withTimeout2, timeoutMs) {
    const settings = track && track.getSettings && track.getSettings() || {};
    const out = {
      width: settings.width || null,
      height: settings.height || null,
      frameRate: settings.frameRate || null,
      settingsWidth: settings.width || null,
      settingsHeight: settings.height || null,
      geometrySource: "track-settings"
    };
    let video = null;
    try {
      video = document.createElement("video");
      video.muted = true;
      video.playsInline = true;
      video.preload = "metadata";
      const meta = new Promise((resolve, reject) => {
        video.onloadedmetadata = () => resolve();
        video.onerror = () => reject(new Error("video element error"));
      });
      video.srcObject = stream;
      await withTimeout2(meta, timeoutMs == null ? 2e3 : timeoutMs, "capture-geometry:loadedmetadata");
      if (video.videoWidth > 0 && video.videoHeight > 0) {
        out.width = video.videoWidth;
        out.height = video.videoHeight;
        out.geometrySource = "video-metadata";
      }
    } catch (err) {
      out.geometryError = err && err.message || String(err);
    } finally {
      if (video) {
        try {
          video.srcObject = null;
        } catch (e) {
        }
      }
    }
    return out;
  }
  function watchCaptureResize(track, originMs, capture) {
    const changes = [];
    if (!track || !track.addEventListener) return () => changes;
    try {
      track.addEventListener("resize", () => {
        try {
          const s = track.getSettings && track.getSettings() || {};
          changes.push({
            atMs: Math.round((typeof performance !== "undefined" ? performance.now() : Date.now()) - originMs),
            // Settings are the only thing available on the event; they are
            // unreliable for absolute geometry (see above) but a CHANGE in them
            // still signals that the surface was resized.
            settingsWidth: s.width || null,
            settingsHeight: s.height || null
          });
        } catch (e) {
        }
      });
    } catch (e) {
    }
    return () => changes;
  }

  // shared/sprinkles/recording-setup/src/track-spread.js
  function trackDurationSpreadMs(tracks) {
    const ds = (tracks || []).map((t) => t && typeof t.containerDurationSec === "number" ? t.containerDurationSec : null).filter((d) => d != null && isFinite(d) && d > 0);
    if (ds.length < 2) return null;
    return Math.round((Math.max.apply(null, ds) - Math.min.apply(null, ds)) * 1e3);
  }
  function shortestTrack(tracks) {
    let best = null;
    for (const t of tracks || []) {
      const d = t && typeof t.containerDurationSec === "number" ? t.containerDurationSec : null;
      if (d == null || !isFinite(d) || d <= 0) continue;
      if (!best || d < best.containerDurationSec) best = t;
    }
    return best ? { name: best.name, file: best.file, containerDurationSec: best.containerDurationSec } : null;
  }
  var TRACK_SPREAD_NOTE = "Tracks do NOT end together. trackDurationSpreadMs is the max-minus-min of the per-track container durations and is INHERENT to capture, not a trim artefact: MediaRecorder stops each recorder independently and the video encoder drops its final partial GOP, so the video track ends first (measured 19.116s video vs 19.919s audio = 803ms, with startOffsetMs ~0 for both, and the gap survives trimming unchanged). Anything muxing these tracks must pad or trim to the SHORTER stream (ffmpeg: -shortest) rather than assume equal length. This is separate from the -c copy keyframe-snap desync noted above.";

  // shared/sprinkles/recording-setup/src/target-window.js
  function normalizeUrlInput(raw) {
    const t = String(raw == null ? "" : raw).trim();
    if (!t) return "";
    const schemeM = /^([a-zA-Z][a-zA-Z0-9+.-]*):(.*)$/.exec(t);
    if (schemeM) {
      const rest = schemeM[2];
      const looksLikePort = /^\d+(?:[/?#]|$)/.test(rest);
      if (!looksLikePort) return t;
    }
    if (t.slice(0, 2) === "//") return "https:" + t;
    return "https://" + t;
  }
  function urlSuggestions(tabs) {
    const skip = /^(about:|chrome:|chrome-extension:|devtools:|blob:|data:)/i;
    const seen = /* @__PURE__ */ new Set();
    const out = [];
    for (const t of tabs || []) {
      const u = t && t.url ? String(t.url) : "";
      if (!u || skip.test(u)) continue;
      if (!/^https?:\/\//i.test(u)) continue;
      if (seen.has(u)) continue;
      seen.add(u);
      out.push({ url: u, title: (t.title || "").trim() });
    }
    return out;
  }
  function validateUrl(raw) {
    const s = String(raw == null ? "" : raw).trim();
    if (!s) return { ok: false, reason: "empty" };
    let u;
    try {
      u = new URL(s);
    } catch (e) {
      try {
        u = new URL("https://" + s);
      } catch (e2) {
        return { ok: false, reason: "not a URL" };
      }
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      return { ok: false, reason: "only http/https (got " + u.protocol + ")" };
    }
    if (!u.hostname) return { ok: false, reason: "no host" };
    return { ok: true, url: u.href };
  }
  function shellQuoteUrl(url) {
    return "'" + String(url).replace(/'/g, "'\\''") + "'";
  }
  function popupFeatures(w, h) {
    return "popup=yes,width=" + (w | 0) + ",height=" + (h | 0) + ",left=40,top=60";
  }
  function windowGeometryCmd(targetId) {
    const id = String(targetId).replace(/[^A-Za-z0-9]/g, "");
    return 'playwright-cli eval "JSON.stringify({ow:outerWidth,oh:outerHeight,iw:innerWidth,ih:innerHeight,dpr:devicePixelRatio})" --tab=' + id;
  }
  function parseGeometry(stdout) {
    const s = String(stdout || "");
    const m = s.match(/\{[^{}]*"ow"[\s\S]*?\}/);
    if (!m) return null;
    try {
      return JSON.parse(m[0]);
    } catch (e) {
      try {
        return JSON.parse(m[0].replace(/\\"/g, '"'));
      } catch (e2) {
        return null;
      }
    }
  }
  function checkDisplayFit(w, h, scr) {
    const s = scr || (typeof screen !== "undefined" ? screen : null);
    const availWidth = s && s.availWidth ? s.availWidth : null;
    const availHeight = s && s.availHeight ? s.availHeight : null;
    const out = { availWidth, availHeight, fitsDisplay: true, clampedAxes: [] };
    if (!w || !h || availWidth == null || availHeight == null) return out;
    if (w > availWidth) out.clampedAxes.push("width");
    if (h > availHeight) out.clampedAxes.push("height");
    out.fitsDisplay = out.clampedAxes.length === 0;
    return out;
  }
  function presetFitness(values, scr) {
    const out = [];
    for (const v of values || []) {
      if (!v) {
        out.push({ value: v, fits: true, reason: null, suffix: "" });
        continue;
      }
      const m = /^(\d+)x(\d+)$/.exec(v);
      if (!m) {
        out.push({ value: v, fits: true, reason: null, suffix: "" });
        continue;
      }
      const w = +m[1], h = +m[2];
      const fit = checkDisplayFit(w, h, scr);
      if (fit.fitsDisplay) {
        out.push({ value: v, fits: true, reason: null, suffix: "" });
        continue;
      }
      const axes = fit.clampedAxes;
      const reason = axes.length === 2 ? "too large for this display" : axes[0] === "height" ? "too tall for this display" : "too wide for this display";
      out.push({ value: v, fits: false, reason, suffix: " (" + reason + ")" });
    }
    return out;
  }
  function displayFitWarning(w, h, fit) {
    if (!fit || fit.fitsDisplay || !fit.clampedAxes.length) return null;
    const axes = fit.clampedAxes.join(" and ");
    const capped = Math.min(w, fit.availWidth) + "x" + Math.min(h, fit.availHeight);
    return "Requested " + w + "x" + h + " does not fit the usable display (" + fit.availWidth + "x" + fit.availHeight + " CSS px). Chrome will clamp the " + axes + " silently, so the window will be about " + capped + " and the recording will be captured at that size, not the size you asked for.";
  }
  function describeTargetWindow(opts) {
    const o = opts || {};
    const g = o.geometry || null;
    const out = {
      url: o.url || null,
      requested: o.requestedW && o.requestedH ? o.requestedW + "x" + o.requestedH : null,
      openedVia: o.openedVia || null,
      sized: !!o.sized,
      targetId: o.targetId || null,
      outerAfter: g ? g.ow + "x" + g.oh : null,
      innerAfter: g ? g.iw + "x" + g.ih : null,
      dpr: g ? g.dpr : null,
      predictedFrame: g && g.dpr ? Math.round(g.ow * g.dpr) + "x" + Math.round(g.oh * g.dpr) : null
    };
    const fit = o.fit || null;
    out.availWidth = fit ? fit.availWidth : null;
    out.availHeight = fit ? fit.availHeight : null;
    out.fitsDisplay = fit ? fit.fitsDisplay : null;
    if (!o.openedVia) {
      out.note = "no target window was opened";
    } else if (!out.sized) {
      out.note = "window opened UNSIZED via " + out.openedVia + " (no handle, so size features could not apply) \u2014 it inherits the opener\u2019s dimensions; size it manually before recording";
    } else if (!g) {
      out.note = "opened, but the achieved geometry could not be measured (no target id)" + (fit && !fit.fitsDisplay ? " \u2014 and the requested " + out.requested + " does NOT fit the usable display " + fit.availWidth + "x" + fit.availHeight + ", so Chrome clamped the " + fit.clampedAxes.join(" and ") + "; `sized: true` means the size features were accepted, not achieved" : "");
    } else {
      const exact = out.requested === out.outerAfter;
      out.note = "opened via " + out.openedVia + "; achieved outer " + out.outerAfter + " at dpr " + g.dpr + " \u2192 frame \u2248 " + out.predictedFrame + (exact ? "" : " (requested " + out.requested + "; " + (fit && !fit.fitsDisplay ? "CLAMPED on " + fit.clampedAxes.join(" and ") + " \u2014 it exceeds the usable display " + fit.availWidth + "x" + fit.availHeight : "Chrome adjusts height for window chrome") + ")");
    }
    return out;
  }
  async function openTargetWindowApi(url, w, h, api) {
    const B = api || typeof slicc !== "undefined" && slicc && slicc.browser || null;
    if (!B || typeof B.openWindow !== "function") {
      return { handle: null, openedVia: null, sized: false, unavailable: true };
    }
    const opts = { decorated: true };
    if (w && h) {
      opts.width = w | 0;
      opts.height = h | 0;
    }
    try {
      const tab = await B.openWindow(url, opts);
      const targetId = tab && (tab.targetId || tab) || null;
      if (!targetId) return { handle: null, openedVia: null, sized: false };
      return {
        handle: null,
        targetId,
        openedVia: "slicc.browser.openWindow",
        sized: !!(w && h),
        decorated: true
      };
    } catch (e) {
      return {
        handle: null,
        openedVia: null,
        sized: false,
        error: e && e.message || String(e)
      };
    }
  }
  function openTargetWindow(url, w, h, win) {
    const W = win || window;
    let handle = null;
    if (w && h) {
      try {
        handle = W.open(url, "sliccTarget", popupFeatures(w, h));
      } catch (e) {
        handle = null;
      }
      if (handle) return { handle, openedVia: "window.open", sized: true };
    } else {
      try {
        handle = W.open(url, "sliccTarget");
      } catch (e) {
        handle = null;
      }
      if (handle) return { handle, openedVia: "window.open", sized: false };
    }
    try {
      const a = W.document.createElement("a");
      a.href = url;
      a.target = "_blank";
      a.rel = "noopener";
      W.document.body.appendChild(a);
      a.click();
      W.document.body.removeChild(a);
      return { handle: null, openedVia: "anchor", sized: false };
    } catch (e) {
      return { handle: null, openedVia: null, sized: false, error: e && e.message || String(e) };
    }
  }
  function newTargetId(before, after) {
    const prev = new Set(before || []);
    const added = (after || []).filter((id) => !prev.has(id));
    if (added.length === 1) return added[0];
    return null;
  }
  function tabIds(tabs) {
    return (tabs || []).map((t) => t.id).filter(Boolean);
  }
  function isNavigated(tabs, id) {
    const t = (tabs || []).find((x) => x.id === id);
    if (!t) return false;
    const u = String(t.url || "");
    return !!u && u !== "about:blank" && u !== "about:newtab" && u !== "chrome://newtab/";
  }
  function landedElsewhere(tabs, id, requestedUrl) {
    const t = (tabs || []).find((x) => x.id === id);
    if (!t || !t.url) return null;
    let a, b;
    try {
      a = new URL(t.url);
    } catch (e) {
      return null;
    }
    try {
      b = new URL(requestedUrl);
    } catch (e) {
      return null;
    }
    if (a.hostname === b.hostname) return null;
    return { landed: t.url, requested: requestedUrl, landedHost: a.hostname, requestedHost: b.hostname };
  }
  function findTargetId(tabs, url) {
    if (!tabs || !tabs.length) return null;
    let target;
    try {
      target = new URL(url);
    } catch (e) {
      target = null;
    }
    const exact = tabs.filter((t) => t.url === url);
    if (exact.length) return exact[exact.length - 1].id;
    if (target) {
      const host = tabs.filter((t) => {
        try {
          const u = new URL(t.url);
          return u.hostname === target.hostname && u.pathname === target.pathname;
        } catch (e) {
          return false;
        }
      });
      if (host.length) return host[host.length - 1].id;
      const byHost = tabs.filter((t) => {
        try {
          return new URL(t.url).hostname === target.hostname;
        } catch (e) {
          return false;
        }
      });
      if (byHost.length) return byHost[byHost.length - 1].id;
    }
    return null;
  }

  // shared/sprinkles/recording-setup/src/entry.js
  window.__rec = {
    createChunkFlusher,
    withTimeout,
    DURATION_LADDER,
    INFINITY_INDEX,
    durationForIndex,
    formatDuration,
    VIDEO_AV_MIMES,
    VIDEO_ONLY_MIMES,
    AUDIO_MIMES,
    mimesForStream,
    pickMime,
    createBeeper,
    parseTabList,
    foregroundTabCmd,
    confirmForegrounded,
    readViewportCmd,
    parseViewport,
    describeResize,
    probeCaptureGeometry,
    watchCaptureResize,
    validateUrl,
    shellQuoteUrl,
    popupFeatures,
    windowGeometryCmd,
    parseGeometry,
    describeTargetWindow,
    openTargetWindow,
    openTargetWindowApi,
    findTargetId,
    checkDisplayFit,
    displayFitWarning,
    newTargetId,
    tabIds,
    isNavigated,
    landedElsewhere,
    normalizeUrlInput,
    urlSuggestions,
    presetFitness,
    trackDurationSpreadMs,
    shortestTrack,
    TRACK_SPREAD_NOTE
  };
})();
