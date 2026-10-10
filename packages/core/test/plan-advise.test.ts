import { describe, expect, it } from 'vitest';
import { advise } from '../src/advise';
import { planLock } from '../src/plan-lock';
import { DEFAULT_POLICY } from '../src/policy';
import type { Snapshot } from '../src/snapshot';

const NOW = 1_800_000_000_000;
const PX = 1223.3;

const lockInput = (over: Partial<Parameters<typeof planLock>[0]> = {}) => ({
  treasuryZat: 1_470_000n,
  hedgeRatioBps: 10_000,
  marginRatioBps: 4_500,
  px: PX,
  swapCostBps: 300,
  maintenanceBps: 500,
  firstRungBps: 2_000,
  ...over,
});

describe('planLock', () => {
  it('splits a small treasury into margin and one hedged lot', () => {
    const plan = planLock(lockInput());
    expect(plan.hedgeLots).toBe(1);
    expect(plan.sellZat).toBe(465_846n);
    expect(plan.marginUsd).toBeCloseTo(5.5277, 3);
    expect(plan.marginRatioBps).toBeGreaterThanOrEqual(4_500);
    // Start ratio 45.19%: (0.4519 - 0.20) / 1.20 = 20.98% to the first rung,
    // (0.4519 - 0.05) / 1.05 = 38.27% to liquidation.
    expect(plan.firstDeRiskUpMoveBps).toBe(2_098);
    expect(plan.liquidationUpMoveBps).toBe(3_827);
  });

  it('never plans to sell more than it leaves hedged plus margin', () => {
    const plan = planLock(lockInput({ treasuryZat: 500_000_000n }));
    expect(plan.sellZat).toBeLessThan(500_000_000n);
    expect(plan.hedgeLots).toBeGreaterThan(0);
    expect(BigInt(plan.hedgeLots) * 1_000_000n + plan.sellZat).toBeLessThanOrEqual(500_000_000n);
  });

  it('absorbs a bigger rise with more margin', () => {
    const lean = planLock(lockInput({ treasuryZat: 100_000_000n, marginRatioBps: 4_500 }));
    const fat = planLock(lockInput({ treasuryZat: 100_000_000n, marginRatioBps: 6_000 }));
    expect(fat.firstDeRiskUpMoveBps).toBeGreaterThan(lean.firstDeRiskUpMoveBps);
    expect(fat.liquidationUpMoveBps).toBeGreaterThan(lean.liquidationUpMoveBps);
    expect(lean.firstDeRiskUpMoveBps).toBeLessThan(lean.liquidationUpMoveBps);
  });

  it('sells less when only part of the treasury is hedged', () => {
    const full = planLock(lockInput({ treasuryZat: 100_000_000n }));
    const half = planLock(lockInput({ treasuryZat: 100_000_000n, hedgeRatioBps: 5_000 }));
    expect(half.sellZat).toBeLessThan(full.sellZat);
    expect(half.hedgeLots).toBeLessThan(full.hedgeLots);
  });

  it('returns an empty plan when nothing can be hedged', () => {
    const empty = { sellZat: 0n, hedgeLots: 0, marginUsd: 0, marginRatioBps: 0, firstDeRiskUpMoveBps: 0, liquidationUpMoveBps: 0 };
    expect(planLock(lockInput({ treasuryZat: 500_000n }))).toEqual(empty);
    expect(planLock(lockInput({ treasuryZat: 0n }))).toEqual(empty);
    expect(planLock(lockInput({ hedgeRatioBps: 0 }))).toEqual(empty);
    expect(planLock(lockInput({ px: 0 }))).toEqual(empty);
    expect(planLock(lockInput({ swapCostBps: 10_000 }))).toEqual(empty);
  });
});

describe('advise', () => {
  const snap = (shortLots: number, equity: number, treasuryZat: bigint | null = 10_000_000n): Snapshot => ({
    now: NOW,
    treasury: treasuryZat === null ? null : { zat: treasuryZat, asOf: NOW - 1_000 },
    hl: { asOf: NOW - 1_000, markPx: PX, oraclePx: PX, shortLots, accountValueUsd: equity, fundingAprBps: 1_190 },
    ref: { px: PX, asOf: NOW - 1_000 },
  });

  it('is quiet when the lock is healthy', () => {
    expect(advise(snap(10, 61.165), DEFAULT_POLICY)).toEqual([]);
  });

  it('asks for margin under the warning level', () => {
    // 10 lots = $122.33; 28% ratio; target 45% needs $55.05.
    const a = advise(snap(10, 34.25), DEFAULT_POLICY);
    expect(a).toEqual([{ kind: 'TOP_UP_MARGIN', usd: 20.8, severity: 'warn' }]);
  });

  it('turns critical under the first buy-back rung', () => {
    const a = advise(snap(10, 23), DEFAULT_POLICY);
    expect(a[0]).toEqual({ kind: 'TOP_UP_MARGIN', usd: 32.05, severity: 'critical' });
  });

  it('offers excess margin back above the sweep level', () => {
    // 95% ratio on $122.33 notional; anything above 45% is excess.
    const a = advise(snap(10, 116.21), DEFAULT_POLICY);
    expect(a).toEqual([{ kind: 'SWEEP_EXCESS_MARGIN', usd: 61.16 }]);
  });

  it('asks to re-lock when the treasury outgrows the margin', () => {
    // Treasury calls for 10 lots; $20 at 3x carries 4.
    const a = advise(snap(4, 20), DEFAULT_POLICY);
    expect(a).toContainEqual({ kind: 'RELOCK', lots: 6 });
    expect(a[0]).toEqual({ kind: 'TOP_UP_MARGIN', usd: 35.05, severity: 'warn' });
  });

  it('asks for the first margin before any lock exists', () => {
    const a = advise(snap(0, 0), DEFAULT_POLICY);
    expect(a).toEqual([
      { kind: 'TOP_UP_MARGIN', usd: 55.05, severity: 'warn' },
      { kind: 'RELOCK', lots: 10 },
    ]);
  });

  it('says nothing about re-locking when the treasury is unreadable', () => {
    expect(advise(snap(10, 61.165, null), DEFAULT_POLICY)).toEqual([]);
  });
});
