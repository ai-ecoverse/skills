// interview-me / camera-open.js
//
// Production camera-open helpers, extracted verbatim from capture-verify.js so
// they no longer live in a file named for verification -- the REAL interview
// capture path calls openCameraWithWatchdog. This is a pure move + re-export:
// the function bodies are byte-identical to their previous home.

/** Frame-read watchdog timeout. DESIGN.md: recoveries land at 2680-2762 ms. */
export const FIRST_FRAME_TIMEOUT_MS = 1500;
export const OPEN_RETRY_DELAY_MS = 600;
export const MAX_OPEN_ATTEMPTS = 4;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The zero-frame detection seam, exported so it can be tested against a stream
 * that is PROVABLY frameless without needing a real misbehaving camera.
 *
 * Returns the reader (so the caller can keep draining it as an fps meter) and a
 * `firstFrame(timeoutMs)` that resolves to the first frame's timestamp, or the
 * string "TIMEOUT" if none arrived. Reading a frame is the ONLY way to detect
 * the ~4% zero-frame open: no track property distinguishes it (readyState is
 * "live", muted false, active true, getSettings() plausible).
 */
export function openFrameReader(track) {
  const proc = new MediaStreamTrackProcessor({ track });
  const reader = proc.readable.getReader();
  return {
    reader,
    async firstFrame(timeoutMs) {
      return Promise.race([
        reader.read().then((r) => {
          if (r.value) {
            const ts = r.value.timestamp;
            r.value.close();
            return ts;
          }
          return null;
        }),
        sleep(timeoutMs).then(() => "TIMEOUT"),
      ]);
    },
  };
}

/**
 * Open one camera and PROVE a frame arrives.
 *
 * DESIGN.md section 2: ~4% of opens (8/160 on the Studio Display cameras,
 * 0/40 on Cam Link) yield a stream that resolves in 33-54 ms with
 * readyState "live", muted false, active true and a plausible
 * 1920x1080@30 from getSettings() -- and never delivers a frame. NO PROPERTY
 * DETECTS THIS. Reading an actual frame through MediaStreamTrackProcessor is
 * the only detection, and 9/9 measured occurrences recovered on the first
 * retry. Skipping this watchdog means roughly one interview in five silently
 * records a 0-byte angle.
 */
export async function openCameraWithWatchdog(deviceId, width, height, onDiagnostic, attempt = 0) {
  const diag = (stage, detail) => {
    try {
      if (onDiagnostic) onDiagnostic(stage, detail);
    } catch (e) {
      /* never let a diagnostic sink break an open */
    }
  };
  const constraints = {
    video: {
      deviceId: deviceId ? { exact: deviceId } : undefined,
      width: { ideal: width },
      height: { ideal: height },
      frameRate: { ideal: 30 },
    },
  };
  const t0 = performance.now();
  const stream = await navigator.mediaDevices.getUserMedia(constraints);
  const openMs = performance.now() - t0;
  const track = stream.getVideoTracks()[0];

  let reader = null;
  let firstTsUs = null;
  let frameCount = 0;
  try {
    const probe = openFrameReader(track);
    reader = probe.reader;
    const first = await probe.firstFrame(FIRST_FRAME_TIMEOUT_MS);
    if (first === "TIMEOUT" || first == null) {
      diag("camera-open:zero-frame", { deviceId, attempt, openMs: Math.round(openMs), settings: track.getSettings(), readyState: track.readyState, muted: track.muted });
      try {
        await reader.cancel();
      } catch (e) {
        /* ignore */
      }
      for (const t of stream.getTracks()) t.stop();
      if (attempt + 1 < MAX_OPEN_ATTEMPTS) {
        await sleep(OPEN_RETRY_DELAY_MS);
        return openCameraWithWatchdog(deviceId, width, height, onDiagnostic, attempt + 1);
      }
      throw new Error(`camera ${deviceId || "(default)"} delivered no frames after ${MAX_OPEN_ATTEMPTS} attempts`);
    }
    firstTsUs = first;
    frameCount = 1;
  } catch (err) {
    if (/delivered no frames/.test(err.message)) throw err;
    // MediaStreamTrackProcessor unavailable: cannot prove a frame. Report it
    // rather than pretending the watchdog ran.
    diag("camera-open:watchdog-unavailable", { deviceId, message: err.message });
  }

  // Keep the reader draining as the per-angle fps meter. getSettings() lies:
  // DESIGN.md measured Studio Display cameras delivering 24.2 fps while
  // reporting 30, and the webcam running at 50 in some modes. Record what was
  // measured, per angle.
  // `firstTsUs` is the frame observed during the OPEN, which is only useful as
  // proof the camera is alive. Cameras are opened sequentially, so those
  // timestamps are staggered by however long the opens took (measured 2393 ms
  // across five) and are NOT the recording offset. `recordingFirstTsUs` is the
  // first frame after the recorders start, which is what sync.json's offsetMs
  // must derive from -- otherwise a tool would delay each angle by up to 2.4 s
  // of pure open latency.
  const meter = { frames: frameCount, firstTsUs, lastTsUs: firstTsUs, recordingFirstTsUs: null, armed: false, framesSinceArmed: 0, stopped: false };
  if (reader) {
    (async () => {
      try {
        while (!meter.stopped) {
          const r = await reader.read();
          if (r.done) break;
          if (r.value) {
            meter.frames++;
            meter.lastTsUs = r.value.timestamp;
            if (meter.armed) {
              if (meter.recordingFirstTsUs == null) meter.recordingFirstTsUs = r.value.timestamp;
              meter.framesSinceArmed++;
            }
            r.value.close();
          }
        }
      } catch (e) {
        /* the track ending is a normal end to this loop */
      }
    })();
  }

  diag("camera-open:ok", { deviceId, attempt, openMs: Math.round(openMs), firstTsUs, settings: track.getSettings() });
  return { stream, track, reader, meter, firstTsUs, openMs, attempts: attempt + 1, settings: track.getSettings() };
}
