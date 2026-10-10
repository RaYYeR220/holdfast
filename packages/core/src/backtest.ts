import { fundingAprBps } from './accounting';
import { advise } from './advise';
import { decide } from './decide';
import { planLock } from './plan-lock';
import type { Policy } from './policy';
import type { RefusalCode, Snapshot } from './snapshot';
import { ZAT_PER_ZEC, type Zat, lotsToZec, notionalUsd, zatToLots, zatToZec } from './units';

export interface Bar {
  /** Open time, ms. */
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  /** Funding paid at the end of this hour; positive pays shorts. */
  fundingRate: number;
}

export interface BacktestInput {
  bars: Bar[];
  policy: Policy;
  /** ZEC held before the lock. */
  treasuryZat: Zat;
  /** Cost of turning ZEC into margin dollars, at lock and at every top-up. */
  swapCostBps: number;
  takerFeeBps: number;
  maintenanceBps: number;
  /** Hours the treasurer takes to answer a top-up request; null = never answers. */
  topUpDelayHours: number | null;
  /** Periods during which the venue cannot be reached. */
  outages?: { from: number; to: number }[];
  /** Hour at which the lock is first attempted; defaults to the first bar. */
  lockAt?: number;
}

export interface BacktestPoint {
  t: number;
  px: number;
  nav: number;
  unhedgedNav: number;
  shortLots: number;
  marginRatioBps: number | null;
  coverageBps: number;
  /** Trailing funding APR to shorts, including this hour. */
  fundingAprBps: number;
}

export interface BacktestResult {
  liquidated: boolean;
  minMarginRatioBps: number | null;
  deRiskEvents: number;
  topUps: number;
  topUpUsd: number;
  navStart: number;
  navEnd: number;
  unhedgedNavEnd: number;
  /** Worst fall of the locked treasury below its starting value. */
  maxDrawdownBps: number;
  /** Worst fall of the same treasury had it done nothing. */
  unhedgedMaxDrawdownBps: number;
  endDriftBps: number;
  fundingUsd: number;
  feesUsd: number;
  swapCostUsd: number;
  /** Cost of assuming every order fills at its limit instead of the mark. */
  slippageUsd: number;
  coverageEndBps: number;
  /** Lowest share of the treasury that was hedged once the lock was on. */
  minCoverageBps: number;
  refusals: Partial<Record<RefusalCode, number>>;
  series: BacktestPoint[];
}

const HOUR = 3_600_000;
const FUNDING_WINDOW_HOURS = 72;

/**
 * Replays the controller over hourly bars.
 *
 * Deliberately pessimistic: inside each bar the price visits open, the far
 * extreme, the near extreme and close; liquidation is checked at each point
 * before the controller is allowed to react; and every order fills at its
 * limit, the worst price the controller would accept.
 */
export function backtest(i: BacktestInput): BacktestResult {
  const { policy: p, bars } = i;
  const first = bars[0];
  if (first === undefined) throw new RangeError('backtest needs at least one bar');

  const swapCost = i.swapCostBps / 10_000;
  const takerFee = i.takerFeeBps / 10_000;
  const startZec = zatToZec(i.treasuryZat);
  const navStart = startZec * first.o;
  const lockAt = i.lockAt ?? first.t;

  let zat = i.treasuryZat;
  let cash = 0;
  let shortLots = 0;
  let avgEntry = 0;
  let locked = false;

  let liquidated = false;
  let minRatioBps: number | null = null;
  let deRiskEvents = 0;
  let topUps = 0;
  let topUpUsd = 0;
  let fundingUsd = 0;
  let feesUsd = 0;
  let swapCostUsd = 0;
  let slippageUsd = 0;
  let pendingTopUpAt: number | null = null;
  let minCoverageBps = 10_000;
  const refusals: Partial<Record<RefusalCode, number>> = {};
  const series: BacktestPoint[] = [];
  const recentFunding: number[] = [];

  const equityAt = (px: number) => cash + lotsToZec(shortLots) * (avgEntry - px);
  const ratioAt = (px: number) => (shortLots > 0 ? equityAt(px) / notionalUsd(shortLots, px) : null);
  const inOutage = (t: number) => (i.outages ?? []).some((o) => t >= o.from && t < o.to);
  const targetLots = () => Math.floor((zatToLots(zat) * p.hedgeRatioBps) / 10_000);

  const sellZecForMargin = (usdWanted: number, px: number) => {
    const zecNeeded = usdWanted / (px * (1 - swapCost));
    const sell = BigInt(Math.ceil(zecNeeded * Number(ZAT_PER_ZEC)));
    const sold = sell > zat ? zat : sell;
    const gross = zatToZec(sold) * px;
    zat -= sold;
    cash += gross * (1 - swapCost);
    swapCostUsd += gross * swapCost;
    return gross * (1 - swapCost);
  };

  const snapshotAt = (now: number, px: number): Snapshot => ({
    now,
    treasury: { zat, asOf: now },
    hl: inOutage(now)
      ? null
      : {
          asOf: now,
          markPx: px,
          oraclePx: px,
          shortLots,
          accountValueUsd: equityAt(px),
          fundingAprBps: fundingAprBps(recentFunding),
        },
    ref: { px, asOf: now },
  });

  const step = (now: number, px: number) => {
    // 1. The venue liquidates before anyone gets to react.
    const ratio = ratioAt(px);
    if (ratio !== null) {
      const bps = ratio * 10_000;
      if (minRatioBps === null || bps < minRatioBps) minRatioBps = bps;
      if (bps < i.maintenanceBps) {
        cash = Math.max(0, equityAt(px));
        shortLots = 0;
        avgEntry = 0;
        liquidated = true;
      }
    }

    // 2. A top-up the treasurer approved earlier arrives.
    if (pendingTopUpAt !== null && now >= pendingTopUpAt) {
      pendingTopUpAt = null;
      const ask = advise(snapshotAt(now, px), p).find((a) => a.kind === 'TOP_UP_MARGIN');
      if (ask !== undefined && ask.kind === 'TOP_UP_MARGIN' && zat > 0n) {
        topUpUsd += sellZecForMargin(ask.usd, px);
        topUps++;
      }
    }

    // 3. The first lock: sell part of the treasury for margin.
    if (!locked && now >= lockAt) {
      const plan = planLock({
        treasuryZat: zat,
        hedgeRatioBps: p.hedgeRatioBps,
        marginRatioBps: p.marginTargetBps,
        px,
        swapCostBps: i.swapCostBps,
        maintenanceBps: i.maintenanceBps,
        firstRungBps: p.deRisk[0]?.marginRatioBps ?? 0,
      });
      if (plan.sellZat > 0n) {
        const gross = zatToZec(plan.sellZat) * px;
        zat -= plan.sellZat;
        cash += gross * (1 - swapCost);
        swapCostUsd += gross * swapCost;
      }
      locked = true;
    }
    if (!locked) return;

    // 4. The controller.
    const snap = snapshotAt(now, px);
    const d = decide(snap, p);
    for (const r of d.refusals) refusals[r.code] = (refusals[r.code] ?? 0) + 1;
    if (d.mode === 'DERISK') deRiskEvents++;
    for (const a of d.actions) {
      const zec = lotsToZec(a.lots);
      const fee = zec * a.limitPx * takerFee;
      slippageUsd += zec * Math.abs(a.limitPx - px);
      if (a.kind === 'increaseShort') {
        avgEntry = (lotsToZec(shortLots) * avgEntry + zec * a.limitPx) / lotsToZec(shortLots + a.lots);
        shortLots += a.lots;
      } else {
        cash += zec * (avgEntry - a.limitPx);
        shortLots -= a.lots;
        if (shortLots === 0) avgEntry = 0;
      }
      cash -= fee;
      feesUsd += fee;
    }

    // 5. Ask the treasurer for margin when the lock is thin.
    if (i.topUpDelayHours !== null && pendingTopUpAt === null) {
      const wantsMargin = advise(snapshotAt(now, px), p).some((a) => a.kind === 'TOP_UP_MARGIN');
      if (wantsMargin) pendingTopUpAt = now + i.topUpDelayHours * HOUR;
    }
  };

  for (const bar of bars) {
    const path = bar.c >= bar.o ? [bar.o, bar.l, bar.h, bar.c] : [bar.o, bar.h, bar.l, bar.c];
    path.forEach((px, k) => step(bar.t + (k * HOUR) / 4, px));

    const paid = bar.fundingRate * lotsToZec(shortLots) * bar.c;
    cash += paid;
    fundingUsd += paid;
    recentFunding.push(bar.fundingRate);
    if (recentFunding.length > FUNDING_WINDOW_HOURS) recentFunding.shift();

    const target = targetLots();
    const coverageBps = target > 0 ? Math.round((shortLots / target) * 10_000) : locked ? 10_000 : 0;
    if (locked && bar.t >= lockAt + HOUR) minCoverageBps = Math.min(minCoverageBps, coverageBps);
    const ratio = ratioAt(bar.c);
    series.push({
      t: bar.t,
      px: bar.c,
      nav: zatToZec(zat) * bar.c + equityAt(bar.c),
      unhedgedNav: startZec * bar.c,
      shortLots,
      marginRatioBps: ratio === null ? null : Math.round(ratio * 10_000),
      coverageBps,
      fundingAprBps: fundingAprBps(recentFunding),
    });
  }

  const last = series[series.length - 1] as BacktestPoint;
  const worst = (pick: (pt: BacktestPoint) => number) =>
    Math.max(0, ...series.map((pt) => Math.round(((navStart - pick(pt)) / navStart) * 10_000)));

  return {
    liquidated,
    minMarginRatioBps: minRatioBps === null ? null : Math.round(minRatioBps),
    deRiskEvents,
    topUps,
    topUpUsd,
    navStart,
    navEnd: last.nav,
    unhedgedNavEnd: last.unhedgedNav,
    maxDrawdownBps: worst((pt) => pt.nav),
    unhedgedMaxDrawdownBps: worst((pt) => pt.unhedgedNav),
    endDriftBps: Math.round(((last.nav - navStart) / navStart) * 10_000),
    fundingUsd,
    feesUsd,
    swapCostUsd,
    slippageUsd,
    coverageEndBps: last.coverageBps,
    minCoverageBps,
    refusals,
    series,
  };
}
