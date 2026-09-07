// interview-me / chunk-flusher.js
//
// Streams a MediaRecorder's timeslice chunks to the VFS DURING a session and
// assembles them into the final file at the end, so the save path can carry
// five concurrent recordings (~238 MB / 5 min, ~475 MB / 10 min measured)
// without ever holding a whole recording as one ArrayBuffer.
//
// ---------------------------------------------------------------------------
// WHY IT WORKS AT ALL: byte-wise concatenation
// ---------------------------------------------------------------------------
// `MediaRecorder.start(timeslice)` emits ordered Blobs where the FIRST carries
// the EBML header + Segment start and every later one is a continuation of the
// cluster stream. Concatenating them byte-wise, in order, yields exactly the
// same bytes as `new Blob(chunks)` -- which is precisely what the old save path
// did. So this is not a re-mux and not a format change: the assembled file is
// byte-identical to what the previous code would have written. `selftest.js`
// asserts that equivalence rather than assuming it.
//
// ---------------------------------------------------------------------------
// WHY PART FILES AND NOT AN APPEND CALL
// ---------------------------------------------------------------------------
// MEASURED at runtime (see `probeBridgePrimitives`, and the report this module
// was designed from): the sprinkle bridge exposes
//   readFile, readFileBinary, writeFile, writeFileBinary, mkdir, readDir,
//   stat, exists, rm, exec
// and NOTHING else file-shaped. There is no `appendFile`, no `openFile`, no
// `createWriteStream`, no `writeAt`/`pwrite`, no `truncate`, and
// `writeFileBinary` has arity 2 (path, bytes) -- no offset or options
// argument to hide an append mode in. So: ordered, zero-padded part files
// plus a manifest, assembled at the end.
//
// ---------------------------------------------------------------------------
// WHY ASSEMBLY GOES THROUGH `exec`
// ---------------------------------------------------------------------------
// MEASURED: accumulating 260 MB as 260 x 1 MB Blobs cost +0 MB of JS heap
// (551.5 -> 551.5 MB) -- Blob payloads are browser-managed, not heap. What
// actually spikes is `await blob.arrayBuffer()`: +260 MB of heap in one step
// (551.5 -> 811.5 MB), which the bridge then structured-clones again to reach
// the shell. THAT is the memory risk in the old path, not the chunk array.
// Assembling with `exec` (`cat` of the part files) keeps every byte out of the
// page entirely: measured 16.6 MB/s and byte-exact on a 20 MB assembly.
// A page-side fallback exists for when `exec` is unavailable, and reports
// itself as degraded because it reintroduces that spike.
//
// ---------------------------------------------------------------------------
// TRANSIENT VFS FAILURES ARE EXPECTED, NOT EXCEPTIONAL
// ---------------------------------------------------------------------------
// Incremental flushing generates far more, far more concurrent, VFS traffic
// than this app has ever produced. SLICC 6.135.0 shipped
// "fix(webapp): retry invalidated ZenFS File snapshots" (PR #2924) for exactly
// this class of fault: a concurrent OPFS overwrite can invalidate the File
// snapshot ZenFS is about to read, surfacing as a native `NotReadableError` on
// the byte read. That PR notes limiting concurrency to one does NOT prevent the
// interleaving, and its retry covers only native `NotReadableError` byte-READ
// failures, up to three attempts. Everything else -- writes, and any other
// transient rejection -- is this module's problem. So every VFS call here is
// retried with a bounded attempt count and a small backoff, every retry is
// COUNTED and surfaced in diagnostics (never silently swallowed), and a
// recorder whose flush ultimately fails degrades to a reported per-angle loss
// instead of taking the session down.
//
// Dependency-free apart from an injected `slicc`-like object and a
// `withTimeout`, so it is unit-testable from the self-test with fakes.

/** Per-part write timeout. A 1 MB part measured 17.6 ms; 15 s is ~850x that. */
export const PART_WRITE_TIMEOUT_MS = 15_000;
/** Assembly timeout. 475 MB at the measured 16.6 MB/s is ~29 s; 180 s is ample. */
export const ASSEMBLE_TIMEOUT_MS = 180_000;
/** Attempts per VFS call, INCLUDING the first. Matches PR #2924's own bound. */
export const MAX_ATTEMPTS = 3;
/** Backoff between attempts. Short: the fault is an interleaving, not a queue. */
export const RETRY_BACKOFF_MS = 120;
/**
 * Cap on bytes sitting in this module's pending queue. Chunks arrive at
 * ~0.14-0.23 MB/s per camera (measured bitrates) and drain at 30-56 MB/s, so
 * the queue is normally empty; this only matters if the VFS stalls. At the cap
 * we stop queueing and fall back to retaining the Blob, which costs ~0 heap.
 */
export const MAX_PENDING_BYTES = 32 * 1024 * 1024;
/**
 * Target size for one part file. MEASURED: writing 20 MB as 1 MB parts ran at
 * 56.7 MB/s (17.6 ms/part) versus 31.5 MB/s as 0.25 MB parts (7.9 ms/part) and
 * 39.0 MB/s as 4 MB parts -- 1 MB is the measured optimum, so consecutive
 * timeslice chunks (~0.14-0.23 MB each at the design bitrates) are coalesced
 * up to this size before a part is written. Also keeps the part count sane: a
 * 10-minute camera at ~28 MB/angle-minute is ~280 parts rather than ~600.
 */
export const TARGET_PART_BYTES = 1024 * 1024;

const isTransient = (err) => {
  const name = err && err.name ? String(err.name) : "";
  const msg = err && err.message ? String(err.message) : "";
  // `NotReadableError` is the PR #2924 fault. The rest are the shapes a
  // bridge/OPFS call has actually been seen to reject or time out with.
  return (
    name === "NotReadableError" ||
    name === "InvalidStateError" ||
    name === "AbortError" ||
    /NotReadableError|InvalidStateError|invalidated|snapshot|timed out|timeout/i.test(msg)
  );
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {object} opts
 * @param {object} opts.slicc            bridge (writeFileBinary, mkdir, rm, stat, readDir, readFileBinary, exec)
 * @param {function} opts.withTimeout    (promise, ms, label) -> promise
 * @param {string} opts.partsDir         directory for this recorder's parts
 * @param {string} opts.name             recorder label, used in diagnostics
 * @param {function} [opts.onDiagnostic] (stage, detail) -> void
 * @param {boolean} [opts.releaseAfterFlush=false]
 *        Drop the Blob reference once its bytes are on disk. Default false so
 *        the single-camera path keeps its in-memory Blob for the review
 *        <video> preview and its bytes stay byte-identical; MEASURED to cost
 *        ~0 JS heap. Multi-camera should pass true for non-hero angles, where
 *        no preview is needed and 5 chunk sets are retained at once.
 */
export function createChunkFlusher({
  slicc,
  withTimeout,
  partsDir,
  name,
  onDiagnostic,
  releaseAfterFlush = false,
  partWriteTimeoutMs = PART_WRITE_TIMEOUT_MS,
  assembleTimeoutMs = ASSEMBLE_TIMEOUT_MS,
  maxAttempts = MAX_ATTEMPTS,
  retryBackoffMs = RETRY_BACKOFF_MS,
  maxPendingBytes = MAX_PENDING_BYTES,
  targetPartBytes = TARGET_PART_BYTES,
}) {
  const diag = (stage, detail) => {
    try {
      if (onDiagnostic) onDiagnostic(stage, detail);
    } catch (err) {
      /* a diagnostic sink must never break the flush path */
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
    lastError: null,
  };

  const queue = [];
  let pendingBytes = 0;
  let draining = false;
  let dirReady = null;
  let nextPartIndex = 0;
  let closed = false;
  /** Set once anything makes the on-disk part sequence untrustworthy. */
  let poisoned = false;

  /** Bounded-retry wrapper. Counts every retry; never swallows a final failure. */
  async function attempt(label, fn, timeoutMs) {
    let lastErr;
    for (let n = 1; n <= maxAttempts; n++) {
      try {
        const result = await withTimeout(Promise.resolve().then(fn), timeoutMs, `${name}:${label}`);
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
        // Non-transient, or attempts exhausted: report loudly and give up.
        diag("chunk-flush:call-failed", {
          name,
          label,
          attempts: n,
          transient,
          errorName: err && err.name,
          message: err && err.message,
        });
        throw err;
      }
    }
    throw lastErr;
  }

  async function ensureDir() {
    if (!dirReady) {
      dirReady = attempt("mkdir", () => slicc.mkdir(partsDir), partWriteTimeoutMs).catch((err) => {
        dirReady = null; // let a later chunk try again
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
        // Coalesce consecutive chunks up to targetPartBytes (the measured
        // optimum, see TARGET_PART_BYTES). Order is preserved because items
        // are taken strictly from the front of the queue.
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
          // Blob -> bytes ONE BATCH AT A TIME. This is the whole point: the
          // heap only ever holds ~1 MB, never the whole recording.
          const bytes = new Uint8Array(
            await new Blob(batch.map((b) => b.blob)).arrayBuffer()
          );
          await attempt(`write-part-${partIndex}`, () => slicc.writeFileBinary(partName(partIndex), bytes), partWriteTimeoutMs);
          stats.partsWritten++;
          stats.bytesWritten += bytes.length;
          stats.chunksFlushed += batch.length;
          if (releaseAfterFlush) for (const b of batch) if (b.release) b.release();
        } catch (err) {
          // A part we cannot write means the on-disk sequence now has a hole,
          // so assembly from parts is no longer valid for this recorder.
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
        // Backpressure: the VFS is not keeping up. Do NOT grow without bound;
        // the retained Blob (~0 heap, measured) is the safe fallback and the
        // whole-blob save path still has it.
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
      // drain() is re-entrant-guarded; if another drain was in flight, poll.
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

      if (typeof slicc.exec === "function") {
        try {
          // Plain glob, deliberately. Part names are zero-padded to a FIXED
          // six digits, so lexicographic (glob) order IS numeric order, and
          // the shell expands `*.part` already sorted.
          //
          // An earlier version tried to be clever and sort explicitly with
          // `ls -1 *.part | sort | tr '\\n' '\\0' | xargs -0 cat`. MEASURED:
          // this shell's `xargs -0` does NOT honour the NUL delimiter -- it
          // passed the whole NUL-joined string as a single filename
          // ("cat: 000000.part000001.part000002.part0: No such file or
          // directory"), the exec path failed, and every assembly silently
          // took the degraded page-side fallback. Do not reintroduce it.
          // Ordering is verified end-to-end by selftest.js's byte-identity
          // check against the same recording's Blob.
          const cmd = `cd ${partsDir} && cat *.part > ${destPath}`;
          const r = await attempt("assemble-exec", () => slicc.exec(cmd), assembleTimeoutMs);
          if (r && r.exitCode === 0) method = "exec-cat";
          else err0 = new Error(`exec exit ${r && r.exitCode}: ${String((r && r.stderr) || "").slice(0, 200)}`);
        } catch (err) {
          err0 = err;
        }
      } else {
        err0 = new Error("slicc.exec unavailable");
      }

      if (!method) {
        // DEGRADED fallback: reintroduces the whole-file heap spike this
        // module exists to avoid, so it is reported as such.
        diag("chunk-flush:assemble-fallback", { name, reason: err0 && err0.message });
        try {
          const entries = await attempt("readDir-parts", () => slicc.readDir(partsDir), assembleTimeoutMs);
          const names = (entries || [])
            .map((e) => (typeof e === "string" ? e : e && e.name))
            .filter((n) => n && n.endsWith(".part"))
            .sort();
          const buf = new Uint8Array(expectedBytes);
          let off = 0;
          for (const n of names) {
            const part = await attempt(`read-part-${n}`, () => slicc.readFileBinary(`${partsDir}/${n}`), partWriteTimeoutMs);
            const u8 = part instanceof Uint8Array ? part : new Uint8Array(part);
            buf.set(u8, off);
            off += u8.length;
          }
          await attempt("write-assembled", () => slicc.writeFileBinary(destPath, buf.subarray(0, off)), assembleTimeoutMs);
          method = "page-fallback";
        } catch (err) {
          stats.assembly = { ok: false, method: "failed", reason: err && err.message, expectedBytes };
          diag("chunk-flush:assemble-failed", { name, message: err && err.message });
          return stats.assembly;
        }
      }

      // Verify: a file that exists at the wrong size is worse than no file.
      let actualBytes = null;
      try {
        const st = await attempt("stat-assembled", () => slicc.stat(destPath), partWriteTimeoutMs);
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
      if (typeof slicc.exec === "function") {
        try {
          const r = await attempt("cleanup-exec", () => slicc.exec(`rm -rf ${partsDir}`), assembleTimeoutMs);
          if (r && r.exitCode === 0) return true;
        } catch (err) {
          /* fall through to the explicit walk */
        }
      }
      try {
        const entries = await attempt("cleanup-readdir", () => slicc.readDir(partsDir), assembleTimeoutMs);
        for (const e of entries || []) {
          const n = typeof e === "string" ? e : e && e.name;
          if (n) await slicc.rm(`${partsDir}/${n}`).catch(() => {});
        }
        await slicc.rm(partsDir).catch(() => {});
        return true;
      } catch (err) {
        diag("chunk-flush:cleanup-failed", { name, message: err && err.message });
        return false;
      }
    },
  };
}

/** Size-aware timeout for a whole-file write, used by the non-flushed path. */
export function writeTimeoutForBytes(bytes) {
  // Floor of 15 s plus a pessimistic 2 MB/s allowance. Measured throughput is
  // 25-39 MB/s, so this is ~12-19x the expected time for a 70 MB file and
  // still bounds a genuinely stuck bridge call.
  return Math.max(15_000, Math.ceil(bytes / (2 * 1024 * 1024)) * 1000);
}
