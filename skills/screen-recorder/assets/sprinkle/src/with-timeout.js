// Injected dependencies for chunk-flusher.js.
//
// createChunkFlusher takes `withTimeout` as a parameter rather than importing
// one, so every VFS call it makes is bounded by a caller-chosen policy. This is
// the implementation this sprinkle supplies.

/** Race a promise against a rejecting timer, labelled for diagnostics. */
export function withTimeout(promise, ms, label) {
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
      },
    );
  });
}
