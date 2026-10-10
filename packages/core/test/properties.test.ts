import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { decide } from '../src/decide';
import { MAX_FUTURE_SKEW_MS } from '../src/freshness';
import { type Policy, validatePolicy } from '../src/policy';
import type { Decision, Snapshot } from '../src/snapshot';
import { notionalUsd, zatToLots } from '../src/units';

const NOW = 1_800_000_000_000;

const policyArb: fc.Arbitrary<Policy> = fc
  .record({
    hedgeRatioBps: fc.oneof(fc.constant(10_000), fc.integer({ min: 0, max: 10_000 })),
    bandLots: fc.integer({ min: 1, max: 5 }),
    maxLeverage: fc.constantFrom(1, 1.5, 2, 3, 5),
    marginExtraBps: fc.integer({ min: 0, max: 6_000 }),
    restoreShare: fc.integer({ min: 30, max: 95 }),
    triggerShare: fc.integer({ min: 30, max: 90 }),
    maxSlippageBps: fc.integer({ min: 1, max: 200 }),
    fundingFloorAprBps: fc.integer({ min: -5_000, max: 500 }),
    maxDataAgeMs: fc.integer({ min: 10_000, max: 600_000 }),
  })
  .map((r) => {
    const floor = Math.ceil(10_000 / r.maxLeverage);
    const marginTargetBps = floor + r.marginExtraBps;
    const deRiskRestoreBps = Math.floor((floor * r.restoreShare) / 100);
    const deRiskTriggerBps = Math.floor((deRiskRestoreBps * r.triggerShare) / 100);
    return {
      hedgeRatioBps: r.hedgeRatioBps,
      bandLots: r.bandLots,
      maxLeverage: r.maxLeverage,
      marginTargetBps,
      deRiskTriggerBps,
      deRiskRestoreBps,
      topUpWarnBps: marginTargetBps - 1,
      sweepAboveBps: marginTargetBps * 2,
      maxSlippageBps: r.maxSlippageBps,
      fundingFloorAprBps: r.fundingFloorAprBps,
      maxMarkOracleDivBps: 100,
      maxOracleRefDivBps: 150,
      maxDataAgeMs: r.maxDataAgeMs,
      minOrderUsd: 10,
    };
  });

/** Mostly fresh readings, with stale and future-dated ones mixed in. */
const ageArb = fc.oneof(
  { weight: 24, arbitrary: fc.integer({ min: 0, max: 10_000 }) },
  { weight: 1, arbitrary: fc.integer({ min: 10_001, max: 5_000_000 }) },
  { weight: 1, arbitrary: fc.integer({ min: -5_000_000, max: -1 }) },
);

const JUNK = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0, -1];
const sometimesJunk = (good: fc.Arbitrary<number>) =>
  fc.oneof({ weight: 40, arbitrary: good }, { weight: 1, arbitrary: fc.constantFrom(...JUNK) });

// fc.double draws evenly over representable floats, which crowds any range
// touching zero into values near zero. Ratios are drawn as scaled integers.
const ratio = (min: number, max: number) =>
  fc.integer({ min: Math.round(min * 10_000), max: Math.round(max * 10_000) }).map((x) => x / 10_000);

/** A factor close to one, occasionally far from it. */
const nearOne = fc.oneof(
  { weight: 8, arbitrary: ratio(0.997, 1.003) },
  { weight: 1, arbitrary: ratio(0.8, 1.25) },
);

/**
 * Snapshots that mostly hang together — one price seen three ways, margin in
 * proportion to the short — so that the interesting branches are reached,
 * with broken fields mixed in to probe the guards.
 */
const snapshotArb: fc.Arbitrary<Snapshot> = fc
  .record({
    px: fc.integer({ min: 2_000, max: 500_000 }).map((c) => c / 100),
    markF: nearOne,
    refF: nearOne,
    treasuryLots: fc.integer({ min: 0, max: 5_000 }),
    dustZat: fc.integer({ min: 0, max: 999_999 }),
    shortShare: fc.oneof(
      { weight: 2, arbitrary: fc.constant(0) },
      { weight: 3, arbitrary: ratio(0, 0.95) },
      { weight: 2, arbitrary: ratio(0.95, 1.3) },
    ),
    marginRatio: ratio(-0.1, 2),
    idleShare: ratio(0, 2),
    funding: fc.integer({ min: -3_000, max: 8_000 }),
    ages: fc.tuple(ageArb, ageArb, ageArb),
    missing: fc.oneof(
      { weight: 12, arbitrary: fc.constant('none' as const) },
      { weight: 1, arbitrary: fc.constantFrom('treasury' as const, 'hl' as const, 'ref' as const) },
    ),
    long: fc.boolean(),
  })
  .chain((r) =>
    fc
      .record({
        markPx: sometimesJunk(fc.constant(r.px * r.markF)),
        oraclePx: sometimesJunk(fc.constant(r.px)),
        refPx: sometimesJunk(fc.constant(r.px * r.refF)),
        accountValueUsd: sometimesJunk(fc.constant(0)),
        fundingAprBps: sometimesJunk(fc.constant(r.funding)),
      })
      .map((j): Snapshot => {
        let shortLots = Math.floor(r.treasuryLots * r.shortShare);
        if (r.long && shortLots > 0 && r.shortShare > 1.25) shortLots = -shortLots;
        const notional = (Math.max(0, shortLots) * r.px) / 100;
        const equity = shortLots > 0 ? notional * r.marginRatio : ((r.treasuryLots * r.px) / 100) * r.idleShare;
        return {
          now: NOW,
          treasury:
            r.missing === 'treasury'
              ? null
              : { zat: BigInt(r.treasuryLots) * 1_000_000n + BigInt(r.dustZat), asOf: NOW - r.ages[0] },
          hl:
            r.missing === 'hl'
              ? null
              : {
                  asOf: NOW - r.ages[1],
                  markPx: j.markPx,
                  oraclePx: j.oraclePx,
                  shortLots,
                  accountValueUsd: j.accountValueUsd === 0 ? equity : j.accountValueUsd,
                  fundingAprBps: j.fundingAprBps,
                },
          ref: r.missing === 'ref' ? null : { px: j.refPx, asOf: NOW - r.ages[2] },
        };
      }),
  );

const fresh = (asOf: number, maxAgeMs: number) => NOW - asOf <= maxAgeMs && NOW - asOf >= -MAX_FUTURE_SKEW_MS;
const increases = (d: Decision) => d.actions.filter((a) => a.kind === 'increaseShort');
const reductions = (d: Decision) => d.actions.filter((a) => a.kind === 'reduceShort');

describe('controller invariants', () => {
  it('generates valid policies', () => {
    fc.assert(fc.property(policyArb, (p) => validatePolicy(p).ok));
  });

  it('never throws and always returns a well-formed decision', () => {
    fc.assert(
      fc.property(snapshotArb, policyArb, (s, p) => {
        const d = decide(s, p);
        expect(['HOLD', 'REBALANCE', 'DERISK']).toContain(d.mode);
        expect(d.actions.length).toBeLessThanOrEqual(1);
        for (const a of d.actions) {
          expect(Number.isInteger(a.lots) && a.lots > 0).toBe(true);
          expect(Number.isFinite(a.limitPx) && a.limitPx > 0).toBe(true);
        }
        if (d.mode === 'HOLD') expect(d.actions).toEqual([]);
      }),
      { numRuns: 2_000 },
    );
  });

  it('adds exposure only when every input is fresh and sane', () => {
    fc.assert(
      fc.property(snapshotArb, policyArb, (s, p) => {
        const d = decide(s, p);
        if (increases(d).length === 0) return;
        expect(s.hl !== null && fresh(s.hl.asOf, p.maxDataAgeMs)).toBe(true);
        expect(s.treasury !== null && fresh(s.treasury.asOf, p.maxDataAgeMs)).toBe(true);
        expect(s.ref !== null && fresh(s.ref.asOf, p.maxDataAgeMs)).toBe(true);
        const hl = s.hl!;
        for (const v of [hl.markPx, hl.oraclePx, hl.accountValueUsd, hl.fundingAprBps, s.ref!.px]) {
          expect(Number.isFinite(v)).toBe(true);
        }
        expect(hl.fundingAprBps).toBeGreaterThanOrEqual(p.fundingFloorAprBps);
        expect(Math.abs(hl.markPx - hl.oraclePx) / hl.oraclePx).toBeLessThanOrEqual(p.maxMarkOracleDivBps / 10_000 + 1e-12);
      }),
      { numRuns: 4_000 },
    );
  });

  it('never opens more short than the treasury calls for or the margin carries', () => {
    fc.assert(
      fc.property(snapshotArb, policyArb, (s, p) => {
        const d = decide(s, p);
        const inc = increases(d)[0];
        if (inc === undefined) return;
        const hl = s.hl!;
        const after = hl.shortLots + inc.lots;
        const target = Math.floor((zatToLots(s.treasury!.zat) * p.hedgeRatioBps) / 10_000);
        expect(after).toBeLessThanOrEqual(target);
        expect(notionalUsd(after, hl.markPx)).toBeLessThanOrEqual(hl.accountValueUsd * p.maxLeverage * (1 + 1e-9));
      }),
      { numRuns: 4_000 },
    );
  });

  it('never buys back more than the short', () => {
    fc.assert(
      fc.property(snapshotArb, policyArb, (s, p) => {
        const red = reductions(decide(s, p))[0];
        if (red === undefined) return;
        expect(red.lots).toBeLessThanOrEqual(s.hl!.shortLots);
      }),
      { numRuns: 4_000 },
    );
  });

  it('prices sells below and buy-backs above the mark, within the slippage cap', () => {
    fc.assert(
      fc.property(snapshotArb, policyArb, (s, p) => {
        const d = decide(s, p);
        const cap = p.maxSlippageBps / 10_000;
        for (const a of d.actions) {
          const mark = s.hl!.markPx;
          if (a.kind === 'increaseShort') {
            expect(a.limitPx).toBeLessThanOrEqual(mark);
            expect(a.limitPx).toBeGreaterThanOrEqual(mark * (1 - cap) * (1 - 2e-4));
          } else {
            expect(a.limitPx).toBeGreaterThanOrEqual(mark);
            expect(a.limitPx).toBeLessThanOrEqual(mark * (1 + cap) * (1 + 2e-4));
          }
        }
      }),
      { numRuns: 2_000 },
    );
  });

  it('does not open again right after its own fill', () => {
    fc.assert(
      fc.property(snapshotArb, policyArb, (s, p) => {
        const d = decide(s, p);
        const inc = increases(d)[0];
        if (inc === undefined) return;
        const hl = s.hl!;
        const filled: Snapshot = { ...s, hl: { ...hl, shortLots: hl.shortLots + inc.lots } };
        expect(increases(decide(filled, p))).toEqual([]);
      }),
      { numRuns: 2_000 },
    );
  });

  it('does not reopen what a buy-back just closed', () => {
    fc.assert(
      fc.property(snapshotArb, policyArb, (s, p) => {
        const d = decide(s, p);
        if (d.mode !== 'DERISK') return;
        const hl = s.hl!;
        const red = d.actions[0]!;
        // The buy-back realises a loss at its limit; equity cannot be higher afterwards.
        const filled: Snapshot = { ...s, hl: { ...hl, shortLots: hl.shortLots - red.lots } };
        expect(increases(decide(filled, p))).toEqual([]);
      }),
      { numRuns: 2_000 },
    );
  });

  it('actually reaches every kind of decision', () => {
    const seen = { open: 0, buyBack: 0, deRisk: 0, hold: 0, refused: 0 };
    const codesSeen: Record<string, number> = {};
    fc.assert(
      fc.property(snapshotArb, policyArb, (s, p) => {
        const d = decide(s, p);
        if (increases(d).length > 0) seen.open++;
        if (d.mode === 'REBALANCE' && reductions(d).length > 0) seen.buyBack++;
        if (d.mode === 'DERISK') seen.deRisk++;
        if (d.mode === 'HOLD') seen.hold++;
        if (d.refusals.length > 0) seen.refused++;
        for (const r of d.refusals) (codesSeen[r.code] = (codesSeen[r.code] ?? 0) + 1);
      }),
      { numRuns: 4_000, seed: 20261010 },
    );
    for (const code of [
      'STALE_HL',
      'STALE_TREASURY',
      'STALE_REF',
      'MARK_ORACLE_DIVERGENCE',
      'ORACLE_REF_DIVERGENCE',
      'FUNDING_BELOW_FLOOR',
      'LEVERAGE_CAP',
      'UNEXPECTED_LONG',
    ]) {
      expect(codesSeen[code] ?? 0, code).toBeGreaterThan(20);
    }
    expect(seen.open).toBeGreaterThan(150);
    expect(seen.buyBack).toBeGreaterThan(100);
    expect(seen.deRisk).toBeGreaterThan(150);
    expect(seen.hold).toBeGreaterThan(500);
    expect(seen.refused).toBeGreaterThan(500);
  });
});
