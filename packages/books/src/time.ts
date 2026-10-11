/** The furthest a JavaScript date reaches either side of 1970, ms. */
const DATE_LIMIT_MS = 8.64e15;

/**
 * A timestamp as ISO 8601, or null when it is not a moment a date can hold.
 * Timestamps read from a file can be anything; formatting one must not throw.
 */
export function isoTime(ms: number | null): string | null {
  if (ms === null || !Number.isFinite(ms) || Math.abs(ms) > DATE_LIMIT_MS) return null;
  return new Date(ms).toISOString();
}
