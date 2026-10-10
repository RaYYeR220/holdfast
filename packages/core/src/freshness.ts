/** Clock disagreement between us and a data source that is still acceptable. */
export const MAX_FUTURE_SKEW_MS = 5_000;

/**
 * A reading is fresh only if its age is known and within bounds. A timestamp
 * from the future is not "very fresh" — it is wrong, and wrong data is stale.
 */
export function isFresh(asOf: number, now: number, maxAgeMs: number): boolean {
  if (!Number.isFinite(asOf) || !Number.isFinite(now) || !Number.isFinite(maxAgeMs)) return false;
  const age = now - asOf;
  return age >= -MAX_FUTURE_SKEW_MS && age <= maxAgeMs;
}

export function isUsablePrice(px: number): boolean {
  return typeof px === 'number' && Number.isFinite(px) && px > 0;
}
