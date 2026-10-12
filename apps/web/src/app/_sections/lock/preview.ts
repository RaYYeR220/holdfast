/**
 * The figures of a lock preview that the server's plan implies and does not
 * state: what stays in the treasury, the share that is sold, and what the
 * swap costs in dollars at the planner's allowance.
 */

const ZAT_PER_ZEC = 100_000_000n;

/** Zatoshi as ZEC with no more decimals than the amount needs. */
export function zecText(zat: bigint): string {
  const sign = zat < 0n ? '-' : '';
  const abs = zat < 0n ? -zat : zat;
  const fraction = (abs % ZAT_PER_ZEC).toString().padStart(8, '0').replace(/0+$/, '');
  return `${sign}${abs / ZAT_PER_ZEC}${fraction === '' ? '' : `.${fraction}`}`;
}

export interface PreviewInput {
  treasuryZat: bigint;
  sellZat: bigint;
  /** The price the plan was made at, dollars per ZEC. */
  px: number;
  /** The planner's allowance for the swap, in basis points of what is sold. */
  swapCostBps: number;
}

export interface PreviewFigures {
  /** What stays in the treasury and is hedged, zatoshi. */
  keptZat: bigint;
  /** The part sold for margin as a share of the treasury, in basis points, rounded down. */
  soldShareBps: number;
  /** What the swap takes at the planner's allowance, dollars. */
  swapCostUsd: number;
}

export function previewFigures(input: PreviewInput): PreviewFigures {
  const { treasuryZat, sellZat, px, swapCostBps } = input;
  return {
    keptZat: treasuryZat - sellZat,
    soldShareBps: treasuryZat <= 0n ? 0 : Number((sellZat * 10_000n) / treasuryZat),
    swapCostUsd: (Number(sellZat) / Number(ZAT_PER_ZEC)) * px * (swapCostBps / 10_000),
  };
}
