// Human-readable file sizes for the file list: 512 B, 1 KB, 1.5 KB, 3.2 MB.

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) {
    throw new RangeError('bytes must be a finite, non-negative number');
  }
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), UNITS.length - 1);
  const value = bytes / 1024 ** i;
  return `${Number.isInteger(value) ? value : value.toFixed(1)} ${UNITS[i]}`;
}
