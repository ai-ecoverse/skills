// pcm-codec.js
// Float32 <-> PCM16 (little-endian) <-> base64 conversions. Dependency-free,
// browser-only (uses atob/btoa). Used on both the input side (mic capture,
// after the worklet has already produced Int16 frames) and the output side
// (decoding response.audio.delta payloads for playback).

/** Clamp a Float32 sample array down to signed 16-bit PCM. */
export function floatTo16BitPCM(float32Array) {
  const out = new Int16Array(float32Array.length);
  for (let i = 0; i < float32Array.length; i++) {
    const s = Math.max(-1, Math.min(1, float32Array[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

/** Expand signed 16-bit PCM back to Float32 in [-1, 1]. */
export function pcm16ToFloat32(int16Array) {
  const out = new Float32Array(int16Array.length);
  for (let i = 0; i < int16Array.length; i++) {
    out[i] = int16Array[i] / 0x8000;
  }
  return out;
}

/** Int16Array -> base64 string (no JSON/text in between; raw bytes). */
export function int16ToBase64(int16Array) {
  const bytes = new Uint8Array(int16Array.buffer, int16Array.byteOffset, int16Array.byteLength);
  let binary = "";
  const chunkSize = 0x8000; // avoid call-stack limits on String.fromCharCode
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

/** base64 string -> Int16Array. */
export function base64ToInt16(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  // Ensure even byte length for Int16Array view.
  const evenLength = bytes.length - (bytes.length % 2);
  return new Int16Array(bytes.buffer.slice(0, evenLength));
}

/** Float32Array -> base64 PCM16 (composition helper for the mic path). */
export function float32ToBase64PCM16(float32Array) {
  return int16ToBase64(floatTo16BitPCM(float32Array));
}

/** base64 PCM16 -> Float32Array (composition helper for the playback path). */
export function base64PCM16ToFloat32(base64) {
  return pcm16ToFloat32(base64ToInt16(base64));
}
