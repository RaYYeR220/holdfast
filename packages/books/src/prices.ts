import { isUsablePrice } from '@holdfast/core';

/** A ZEC/USD price and the moment it was observed. */
export interface PricePoint {
  ts: number;
  px: number;
}

/** A price older than this is not applied to an entry; the entry stays unpriced instead. */
export const DEFAULT_PRICE_MAX_AGE_MS = 3_600_000;

export interface PriceBook {
  /** The latest price observed at or before `ts`, or null when none is recent enough. */
  at(ts: number): PricePoint | null;
}

/**
 * Works the same for a regular series and for prices recorded per event: a
 * per-event price is a point stamped with the event's own time. A price is
 * never taken from the future of the entry it values.
 */
export function priceBook(points: readonly PricePoint[], maxAgeMs: number = DEFAULT_PRICE_MAX_AGE_MS): PriceBook {
  const sorted = points.filter((p) => Number.isFinite(p.ts) && isUsablePrice(p.px)).sort((a, b) => a.ts - b.ts);

  return {
    at(ts) {
      let lo = 0;
      let hi = sorted.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if ((sorted[mid] as PricePoint).ts <= ts) lo = mid + 1;
        else hi = mid;
      }
      const point = sorted[lo - 1];
      if (point === undefined || ts - point.ts > maxAgeMs) return null;
      return { ts: point.ts, px: point.px };
    },
  };
}
