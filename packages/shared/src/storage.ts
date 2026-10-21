const KILOBYTE = 1024;
const MEGABYTE = 1024 * 1024;
const GIGABYTE = 1024 * 1024 * 1024;

/**
 * File size from a byte count on disk. Uses 1024-based steps and only
 * KB, MB, and GB. A non-empty file smaller than 0.1 KB is shown as 0.1 KB
 * so it is not displayed as empty.
 */
export function formatFileSize(bytes: number): string {
  const safe = normalizeBytes(bytes);
  if (safe >= GIGABYTE) {
    return `${formatUnit(safe / GIGABYTE)} GB`;
  }
  if (safe >= MEGABYTE) {
    return `${formatUnit(safe / MEGABYTE)} MB`;
  }
  return `${formatUnit(safe / KILOBYTE)} KB`;
}

/** Sum of on-disk sizes. Invalid or negative entries are ignored. */
export function totalRecordingBytes(sizes: readonly number[]): number {
  let total = 0;
  for (const size of sizes) {
    total += normalizeBytes(size);
  }
  return total;
}

function normalizeBytes(bytes: number): number {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return 0;
  }
  return Math.floor(bytes);
}

function formatUnit(value: number): string {
  if (value > 0 && value < 0.1) {
    return "0.1";
  }
  if (value >= 100) {
    return Math.round(value).toString();
  }
  const rounded = Math.round(value * 10) / 10;
  return rounded.toFixed(1).replace(/\.0$/, "");
}
