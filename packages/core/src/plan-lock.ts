import { ZAT_PER_ZEC, type Zat, notionalUsd, zatToLots, zatToZec } from './units';

export interface LockPlanInput {
  treasuryZat: Zat;
  hedgeRatioBps: number;
  /** Margin ratio the lock should start with. */
  marginRatioBps: number;
  px: number;
  /** All-in cost of turning ZEC into margin dollars. */
  swapCostBps: number;
  /** Venue maintenance margin, as a share of notional. */
  maintenanceBps: number;
  /** Margin ratio at which the first buy-back fires. */
  firstRungBps: number;
}

export interface LockPlan {
  /** ZEC to convert into margin. */
  sellZat: Zat;
  /** Short to open against what remains. */
  hedgeLots: number;
  marginUsd: number;
  /** Starting margin ratio after rounding to whole lots. */
  marginRatioBps: number;
  /** Price rise the lock absorbs before the first buy-back. */
  firstDeRiskUpMoveBps: number;
  /** Price rise at which an untouched short would be liquidated. */
  liquidationUpMoveBps: number;
}

const EMPTY: LockPlan = {
  sellZat: 0n,
  hedgeLots: 0,
  marginUsd: 0,
  marginRatioBps: 0,
  firstDeRiskUpMoveBps: 0,
  liquidationUpMoveBps: 0,
};

/** Price rise that takes a short from `startRatio` down to `floorRatio`. */
function upMoveBps(startRatio: number, floorRatio: number): number {
  const move = (startRatio - floorRatio) / (1 + floorRatio);
  return Math.max(0, Math.floor(move * 10_000));
}

/**
 * Split a ZEC treasury into the part sold for margin and the part kept and
 * hedged, so that the short starts at the requested margin ratio.
 *
 * With Z the treasury, h the hedge ratio, m the margin ratio and c the swap
 * cost, selling s gives s(1 - c) of margin against a short of h(Z - s):
 * s = m h Z / (1 - c + m h).
 */
export function planLock(i: LockPlanInput): LockPlan {
  const h = i.hedgeRatioBps / 10_000;
  const m = i.marginRatioBps / 10_000;
  const c = i.swapCostBps / 10_000;
  if (i.treasuryZat <= 0n || h <= 0 || m <= 0 || c >= 1 || !(i.px > 0)) return EMPTY;

  const sellZec = (m * h * zatToZec(i.treasuryZat)) / (1 - c + m * h);
  const sellZat = BigInt(Math.ceil(sellZec * Number(ZAT_PER_ZEC)));
  if (sellZat >= i.treasuryZat) return EMPTY;

  const hedgeLots = Math.floor((zatToLots(i.treasuryZat - sellZat) * i.hedgeRatioBps) / 10_000);
  if (hedgeLots === 0) return EMPTY;

  const marginUsd = zatToZec(sellZat) * i.px * (1 - c);
  const ratio = marginUsd / notionalUsd(hedgeLots, i.px);

  return {
    sellZat,
    hedgeLots,
    marginUsd,
    marginRatioBps: Math.floor(ratio * 10_000),
    firstDeRiskUpMoveBps: upMoveBps(ratio, i.firstRungBps / 10_000),
    liquidationUpMoveBps: upMoveBps(ratio, i.maintenanceBps / 10_000),
  };
}
