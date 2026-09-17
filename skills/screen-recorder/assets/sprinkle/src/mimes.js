// MediaRecorder mime selection.
//
// MEASURED DEFECT (first real take): the screen recorder was built with
// 'video/webm;codecs=vp9,opus' even though getDisplayMedia ran with audio:false,
// so the container held ONE vp9 stream while the manifest advertised opus.
// isTypeSupported() answers true for that mime whatever the stream contains, so
// nothing caught it; ffprobe and remotion both report audioCodec:null. A
// consumer trusting the string looks for an audio track, finds none, and
// silently mixes silence -- a success-shaped wrong answer.
//
// So the mime is chosen from the STREAM's real track composition, never from a
// caller-supplied list or a flag. If screen audio is ever captured, the
// audio-track count becomes non-zero and the ,opus variant is selected
// automatically -- no flag to remember to flip.

export const VIDEO_AV_MIMES = [
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
];
export const VIDEO_ONLY_MIMES = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
export const AUDIO_MIMES = ['audio/webm;codecs=opus', 'audio/webm'];

export function mimesForStream(stream) {
  const v = stream.getVideoTracks().length;
  const a = stream.getAudioTracks().length;
  if (v && a) return VIDEO_AV_MIMES;
  if (v) return VIDEO_ONLY_MIMES;
  return AUDIO_MIMES;
}

export function pickMime(cands) {
  if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported) return cands[0];
  for (const m of cands) if (MediaRecorder.isTypeSupported(m)) return m;
  return cands[cands.length - 1];
}
