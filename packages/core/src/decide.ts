import { isFresh, isUsablePrice } from './freshness';
import { type Policy, validatePolicy } from './policy';
import type { Action, Decision, Refusal, Snapshot } from './snapshot';
import { notionalUsd, roundPx, zatToLots } from './units';

type Hl = NonNullable<Snapshot['hl']>;

function divergenceBps(a: number, b: number): number {
  return (Math.abs(a - b) / b) * 10_000;
}

/** Equity over short notional, or null when there is no short. */
export function marginRatio(hl: Pick<Hl, 'shortLots' | 'markPx' | 'accountValueUsd'>): number | null {
  if (hl.shortLots <= 0) return null;
  return hl.accountValueUsd / notionalUsd(hl.shortLots, hl.markPx);
}

function buyBack(lots: number, hl: Hl, p: Policy): Action {
  return { kind: 'reduceShort', lots, limitPx: roundPx(hl.markPx * (1 + p.maxSlippageBps / 10_000), 'buy') };
}

function sellShort(lots: number, hl: Hl, p: Policy): Action {
  return { kind: 'increaseShort', lots, limitPx: roundPx(hl.markPx * (1 - p.maxSlippageBps / 10_000), 'sell') };
}

/**
 * One decision from one snapshot. Pure: no clock, no network, no randomness.
 *
 * Order matters. Protecting the short from liquidation needs only fresh venue
 * data, so it runs first. Anything that adds exposure needs every input fresh
 * and every guard quiet. Buying back never waits on the price guards.
 */
export function decide(s: Snapshot, p: Policy): Decision {
  const refusals: Refusal[] = [];
  const reasons: string[] = [];
  const done = (
    mode: Decision['mode'],
    actions: Action[],
    targetLots: number | null,
    ratio: number | null,
  ): Decision => ({
    mode,
    targetLots,
    marginRatioBps: ratio === null ? null : Math.round(ratio * 10_000),
    actions,
    refusals,
    reasons,
  });

  if (!validatePolicy(p).ok) {
    refusals.push({ code: 'INVALID_POLICY', detail: 'policy failed validation' });
    return done('HOLD', [], null, null);
  }

  const hl = s.hl;
  if (
    hl === null ||
    !isFresh(hl.asOf, s.now, p.maxDataAgeMs) ||
    !isUsablePrice(hl.markPx) ||
    !isUsablePrice(hl.oraclePx) ||
    !Number.isFinite(hl.accountValueUsd) ||
    !Number.isFinite(hl.fundingAprBps) ||
    !Number.isInteger(hl.shortLots)
  ) {
    refusals.push({ code: 'STALE_HL', detail: 'venue state is missing, old or malformed' });
    return done('HOLD', [], null, null);
  }

  if (hl.shortLots < 0) {
    refusals.push({ code: 'UNEXPECTED_LONG', detail: `account is long ${-hl.shortLots} lots` });
    return done('HOLD', [], null, null);
  }

  const ratio = marginRatio(hl);

  if (ratio !== null && ratio * 10_000 < p.deRiskTriggerBps) {
    // Keep only the short the remaining margin carries at the restore ratio.
    // The restore ratio sits under the leverage floor, so the lots bought back
    // here cannot be sold again until fresh margin arrives.
    const carried = Math.floor((hl.accountValueUsd * 100) / ((p.deRiskRestoreBps / 10_000) * hl.markPx));
    const keep = Math.min(hl.shortLots - 1, Math.max(0, carried));
    const lots = hl.shortLots - keep;
    reasons.push(
      `margin ratio ${(ratio * 10_000).toFixed(0)} bps is under the ${p.deRiskTriggerBps} bps trigger: buying back ${lots} of ${hl.shortLots} lots`,
    );
    return done('DERISK', [buyBack(lots, hl, p)], null, ratio);
  }

  const treasury = s.treasury;
  if (treasury === null || typeof treasury.zat !== 'bigint' || !isFresh(treasury.asOf, s.now, p.maxDataAgeMs)) {
    refusals.push({ code: 'STALE_TREASURY', detail: 'treasury balance is missing or old' });
    return done('HOLD', [], null, ratio);
  }

  const targetLots = Math.floor((zatToLots(treasury.zat) * p.hedgeRatioBps) / 10_000);
  const diff = targetLots - hl.shortLots;

  if (diff === 0) {
    reasons.push('short matches the treasury');
    return done('HOLD', [], targetLots, ratio);
  }
  if (Math.abs(diff) < p.bandLots) {
    reasons.push(`gap of ${Math.abs(diff)} lots is inside the ${p.bandLots}-lot band`);
    return done('HOLD', [], targetLots, ratio);
  }

  if (diff < 0) {
    const lots = -diff;
    const closesPosition = lots === hl.shortLots;
    if (!closesPosition && notionalUsd(lots, hl.markPx) < p.minOrderUsd) {
      refusals.push({ code: 'BELOW_MIN_ORDER', detail: `buy-back of ${lots} lots is under $${p.minOrderUsd}` });
      return done('HOLD', [], targetLots, ratio);
    }
    reasons.push(`treasury covers ${targetLots} lots, short is ${hl.shortLots}: buying back ${lots}`);
    return done('REBALANCE', [buyBack(lots, hl, p)], targetLots, ratio);
  }

  // From here on the decision would add exposure.
  const ref = s.ref;
  const refFresh = ref !== null && isFresh(ref.asOf, s.now, p.maxDataAgeMs) && isUsablePrice(ref.px);
  if (!refFresh) {
    refusals.push({ code: 'STALE_REF', detail: 'reference price is missing or old' });
  } else if (divergenceBps(hl.oraclePx, ref.px) > p.maxOracleRefDivBps) {
    refusals.push({
      code: 'ORACLE_REF_DIVERGENCE',
      detail: `venue oracle ${hl.oraclePx} vs reference ${ref.px}`,
    });
  }
  if (divergenceBps(hl.markPx, hl.oraclePx) > p.maxMarkOracleDivBps) {
    refusals.push({ code: 'MARK_ORACLE_DIVERGENCE', detail: `mark ${hl.markPx} vs oracle ${hl.oraclePx}` });
  }
  if (hl.fundingAprBps < p.fundingFloorAprBps) {
    refusals.push({
      code: 'FUNDING_BELOW_FLOOR',
      detail: `funding ${hl.fundingAprBps} bps APR is under the ${p.fundingFloorAprBps} bps floor`,
    });
  }
  if (refusals.length > 0) return done('HOLD', [], targetLots, ratio);

  if (hl.accountValueUsd <= 0) {
    refusals.push({ code: 'NO_MARGIN', detail: 'no margin on the venue' });
    return done('HOLD', [], targetLots, ratio);
  }

  const maxLots = Math.floor((hl.accountValueUsd * p.maxLeverage * 100) / hl.markPx);
  const lots = Math.min(targetLots, maxLots) - hl.shortLots;
  if (lots <= 0) {
    refusals.push({
      code: 'LEVERAGE_CAP',
      detail: `margin supports ${maxLots} lots at ${p.maxLeverage}x, short is already ${hl.shortLots}`,
    });
    return done('HOLD', [], targetLots, ratio);
  }
  if (notionalUsd(lots, hl.markPx) < p.minOrderUsd) {
    refusals.push({ code: 'BELOW_MIN_ORDER', detail: `order of ${lots} lots is under $${p.minOrderUsd}` });
    return done('HOLD', [], targetLots, ratio);
  }
  if (lots < diff) {
    refusals.push({
      code: 'LEVERAGE_CAP',
      detail: `margin supports ${maxLots} of the ${targetLots} lots the treasury calls for`,
    });
  }
  reasons.push(`treasury calls for ${targetLots} lots, short is ${hl.shortLots}: selling ${lots}`);
  return done('REBALANCE', [sellShort(lots, hl, p)], targetLots, ratio);
}
