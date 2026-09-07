// recorder.js
// Thin MediaRecorder wrappers for the two recorded tracks BRIEF.md requires:
// human video+audio (getUserMedia stream) and agent audio (a
// MediaStreamDestination fed by the playback graph). Dependency-free.

const VIDEO_MIME_CANDIDATES = [
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
];

const AUDIO_MIME_CANDIDATES = ["audio/webm;codecs=opus", "audio/webm"];

// The first real interview's human.webm was 108MB for a 5-minute session
// (~2.9 Mbps combined, unset bitrate -> browser default for a 1920x1080
// @50fps track) -- heavy for what is a single mostly-static talking-head
// webcam feed, and slow to write/read as a result. These are HINTS passed
// to MediaRecorder (never a container/codec change -- VIDEO_MIME_CANDIDATES
// above is untouched, same vp9 -> vp8 -> mp4 preference order):
//   - videoBitsPerSecond: 1.5 Mbps. Low-motion, single-speaker webcam
//     content compresses well under VP9/VP8's temporal prediction; 1.5
//     Mbps at 1080p is a standard "good enough" figure for exactly this
//     kind of footage (comparable to typical single-speaker webinar/video
//     call recording defaults), a long way below what pixel count alone
//     would suggest is needed.
//   - audioBitsPerSecond: 64 kbps opus. This is a spoken-voice interview,
//     not music -- opus at 64kbps is well past the point of diminishing
//     perceptual returns for a single speaker's voice.
// Combined ~1.564 Mbps -> a 5-minute session becomes roughly 300s *
// 1.564Mb / 8 ~= 58.7MB, versus the real 108MB observed -- a bit under
// half, with no perceptible quality loss for this content.
const HUMAN_RECORDER_OPTIONS = { videoBitsPerSecond: 1_500_000, audioBitsPerSecond: 64_000 };

export function pickSupportedMime(candidates) {
  if (typeof MediaRecorder === "undefined" || !MediaRecorder.isTypeSupported) {
    return candidates[0];
  }
  for (const mime of candidates) {
    if (MediaRecorder.isTypeSupported(mime)) return mime;
  }
  return candidates[candidates.length - 1];
}

export class TrackRecorder {
  constructor(stream, mimeCandidates, chunkMs = 1000, recorderOptions = {}) {
    this.mimeType = pickSupportedMime(mimeCandidates);
    this.chunks = [];
    // Optional incremental flusher (lib/chunk-flusher.js). When attached via
    // attachFlusher(), every timeslice chunk is ALSO streamed to a part file
    // on the VFS as it arrives, so a recording's bytes reach disk during the
    // session instead of only at stopInterview(). Purely additive: with no
    // flusher attached this class behaves exactly as before, byte for byte,
    // which is what keeps the single-camera path unchanged.
    this.flusher = null;
    this.recorder = new MediaRecorder(stream, { mimeType: this.mimeType, ...recorderOptions });
    this.recorder.ondataavailable = (e) => {
      if (!e.data || e.data.size <= 0) return;
      const index = this.chunks.length;
      this.chunks.push(e.data);
      if (this.flusher) {
        // The release callback lets a flusher configured with
        // releaseAfterFlush drop the retained Blob once its bytes are safely
        // on disk, making retained memory bounded rather than proportional to
        // session length. Default is to keep it: MEASURED at +0 JS heap for
        // 260 MB of Blobs, and the review <video> preview needs it.
        this.flusher.append(e.data, () => {
          this.chunks[index] = null;
        });
      }
    };
    this._chunkMs = chunkMs;
    this._stopped = null;
  }

  start() {
    this.recorder.start(this._chunkMs);
  }

  stop() {
    if (this._stopped) return this._stopped;
    this._stopped = new Promise((resolve) => {
      if (this.recorder.state === "inactive") {
        resolve(this.blob());
        return;
      }
      this.recorder.onstop = () => resolve(this.blob());
      try {
        this.recorder.stop();
      } catch (err) {
        resolve(this.blob());
      }
    });
    return this._stopped;
  }

  /**
   * Attach an incremental flusher. Must be called BEFORE start() so no chunk
   * is missed. Returns the flusher for convenience.
   */
  attachFlusher(flusher) {
    this.flusher = flusher;
    return flusher;
  }

  blob() {
    // Skips chunks a releaseAfterFlush flusher has already dropped; with the
    // default (retain) flusher or no flusher at all this is every chunk, so
    // the bytes are identical to the pre-flusher behaviour.
    return new Blob(this.chunks.filter(Boolean), { type: this.mimeType });
  }

  /** Bytes seen by ondataavailable, whether or not the Blobs were retained. */
  retainedChunkCount() {
    return this.chunks.filter(Boolean).length;
  }

  extension() {
    if (this.mimeType.startsWith("video/mp4")) return "mp4";
    if (this.mimeType.startsWith("audio/")) return "webm";
    return "webm";
  }
}

export function createHumanRecorder(stream) {
  // See HUMAN_RECORDER_OPTIONS above for the bitrate reasoning -- this is
  // the only recorder that needed it (agent audio was never the size
  // problem the real 108MB human.webm was).
  return new TrackRecorder(stream, VIDEO_MIME_CANDIDATES, 1000, HUMAN_RECORDER_OPTIONS);
}

export function createAgentRecorder(stream) {
  return new TrackRecorder(stream, AUDIO_MIME_CANDIDATES, 1000);
}

export async function blobToUint8Array(blob) {
  const buf = await blob.arrayBuffer();
  return new Uint8Array(buf);
}

/**
 * A recorder for one ADDITIONAL camera angle.
 *
 * Additive: `createHumanRecorder` is untouched, so the single-camera path keeps
 * its exact bitrates and its `human.webm` output. Per DESIGN.md section 5:
 *  - the shared mic track is added to EVERY camera's MediaStream, because
 *    measured decoded PCM is byte-identical (same MD5) across all five files,
 *    which makes cross-angle alignment exact for free;
 *  - audio is 128 kbps here rather than the hero's 64 kbps, because in a
 *    multi-angle recording this track IS the synchronisation signal;
 *  - 900 kbps video at 720p is the validated figure (measured actual
 *    1048-1195 kbps -- VP9 overshoots the hint, do not treat it as a cap).
 */
export function createCameraRecorder(videoTrack, sharedAudioTrack, { videoBitsPerSecond = 900_000 } = {}) {
  const ms = new MediaStream([videoTrack]);
  if (sharedAudioTrack) ms.addTrack(sharedAudioTrack);
  return new TrackRecorder(ms, VIDEO_MIME_CANDIDATES, 1000, { videoBitsPerSecond, audioBitsPerSecond: 128_000 });
}
