export type Zat = bigint;

export const ZAT_PER_ZEC = 100_000_000n;
/** Hyperliquid trades ZEC in steps of 0.01, so one lot is 0.01 ZEC. */
export const ZAT_PER_LOT = 1_000_000n;

const MAX_PX_DECIMALS = 4;
const PX_SIGNIFICANT_FIGURES = 5;

export function zatToLots(z: Zat): number {
  if (z <= 0n) return 0;
  return Number(z / ZAT_PER_LOT);
}

export function lotsToZat(lots: number): Zat {
  return BigInt(lots) * ZAT_PER_LOT;
}

export function lotsToZec(lots: number): number {
  return lots / 100;
}

export function zatToZec(z: Zat): number {
  return Number(z) / Number(ZAT_PER_ZEC);
}

export function notionalUsd(lots: number, px: number): number {
  return (lots * px) / 100;
}

/**
 * Snap a limit price to the venue grid: at most five significant figures and
 * four decimals. Buys round up and sells round down, so the snapped limit is
 * never tighter than the one that was asked for.
 */
export function roundPx(px: number, side: 'buy' | 'sell'): number {
  if (!Number.isFinite(px) || px <= 0) throw new RangeError(`invalid price ${px}`);
  const integerDigits = Math.floor(Math.log10(px)) + 1;
  const decimals = Math.max(0, Math.min(MAX_PX_DECIMALS, PX_SIGNIFICANT_FIGURES - integerDigits));
  const factor = 10 ** decimals;
  const scaled = px * factor;
  const snapped = side === 'buy' ? Math.ceil(scaled - 1e-9) : Math.floor(scaled + 1e-9);
  return snapped / factor;
}
