import { marginRatio } from './decide';
import { isFresh, isUsablePrice } from './freshness';
import { type Policy, validatePolicy } from './policy';
import type { Snapshot } from './snapshot';
import { notionalUsd, zatToLots } from './units';

/** Things only the treasurer can do, because they need a root key. */
export type Advisory =
  | { kind: 'TOP_UP_MARGIN'; usd: number; severity: 'warn' | 'critical' }
  | { kind: 'SWEEP_EXCESS_MARGIN'; usd: number }
  | { kind: 'RELOCK'; lots: number };

const ceilCents = (usd: number) => Math.ceil(usd * 100) / 100;
const floorCents = (usd: number) => Math.floor(usd * 100) / 100;

export function advise(s: Snapshot, p: Policy): Advisory[] {
  if (!validatePolicy(p).ok) return [];

  const hl = s.hl;
  if (
    hl === null ||
    !isFresh(hl.asOf, s.now, p.maxDataAgeMs) ||
    !isUsablePrice(hl.markPx) ||
    !Number.isFinite(hl.accountValueUsd) ||
    !Number.isInteger(hl.shortLots) ||
    hl.shortLots < 0
  ) {
    return [];
  }

  const out: Advisory[] = [];
  const target = p.marginTargetBps / 10_000;
  const ratio = marginRatio(hl);
  let topUpUsd = 0;
  let severity: 'warn' | 'critical' = 'warn';

  if (ratio !== null) {
    const ratioBps = ratio * 10_000;
    const notional = notionalUsd(hl.shortLots, hl.markPx);
    const firstRungBps = p.deRisk[0]?.marginRatioBps ?? 0;
    if (ratioBps < p.topUpWarnBps) {
      topUpUsd = notional * target - hl.accountValueUsd;
      if (ratioBps < firstRungBps) severity = 'critical';
    } else if (ratioBps > p.sweepAboveBps) {
      const excess = floorCents(hl.accountValueUsd - notional * target);
      if (excess > 0) out.push({ kind: 'SWEEP_EXCESS_MARGIN', usd: excess });
    }
  }

  const treasury = s.treasury;
  if (treasury !== null && typeof treasury.zat === 'bigint' && isFresh(treasury.asOf, s.now, p.maxDataAgeMs)) {
    const targetLots = Math.floor((zatToLots(treasury.zat) * p.hedgeRatioBps) / 10_000);
    const gap = targetLots - hl.shortLots;
    if (gap >= p.bandLots) {
      const maxLots = Math.floor((Math.max(0, hl.accountValueUsd) * p.maxLeverage * 100) / hl.markPx);
      const reachable = Math.max(hl.shortLots, Math.min(targetLots, maxLots));
      const missing = targetLots - reachable;
      if (missing > 0) {
        out.push({ kind: 'RELOCK', lots: missing });
        topUpUsd = Math.max(topUpUsd, notionalUsd(targetLots, hl.markPx) * target - hl.accountValueUsd);
      }
    }
  }

  if (topUpUsd > 0) out.unshift({ kind: 'TOP_UP_MARGIN', usd: ceilCents(topUpUsd), severity });
  return out;
}
