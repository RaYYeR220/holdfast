import { describe, expect, it } from 'vitest';
import { type Bar, type BacktestInput, backtest } from '../src/backtest';
import { DEFAULT_POLICY } from '../src/policy';

const HOUR = 3_600_000;
const T0 = 1_780_000_000_000;

/** Hourly bars moving in a straight line from `from` to `to`. */
function line(from: number, to: number, hours: number, fundingRate = 0.0000125): Bar[] {
  const bars: Bar[] = [];
  for (let k = 0; k < hours; k++) {
    const o = from + ((to - from) * k) / hours;
    const c = from + ((to - from) * (k + 1)) / hours;
    bars.push({ t: T0 + k * HOUR, o, h: Math.max(o, c), l: Math.min(o, c), c, fundingRate });
  }
  return bars;
}

const run = (bars: Bar[], over: Partial<BacktestInput> = {}) =>
  backtest({
    bars,
    policy: DEFAULT_POLICY,
    treasuryZat: 1_000_000_000n, // 10 ZEC
    swapCostBps: 50,
    takerFeeBps: 4.5,
    maintenanceBps: 500,
    topUpDelayHours: null,
    ...over,
  });

describe('backtest', () => {
  it('earns funding minus costs in a flat market', () => {
    const r = run(line(1_000, 1_000, 240));
    expect(r.liquidated).toBe(false);
    expect(r.deRiskEvents).toBe(0);
    expect(r.coverageEndBps).toBe(10_000);
    expect(r.fundingUsd).toBeGreaterThan(0);
    // 240 hours at 0.00125% on ~$6,870 of short is about $20.6.
    expect(r.fundingUsd).toBeCloseTo(20.6, 0);
    expect(r.navEnd).toBeCloseTo(r.navStart + r.fundingUsd - r.feesUsd - r.swapCostUsd - r.slippageUsd, 6);
    expect(r.slippageUsd).toBeCloseTo(20.5, 0);
  });

  it('holds its dollar value through a 35% fall', () => {
    const r = run(line(1_000, 650, 200));
    expect(r.liquidated).toBe(false);
    expect(r.unhedgedMaxDrawdownBps).toBeGreaterThan(3_400);
    expect(r.maxDrawdownBps).toBeLessThan(60);
    expect(r.coverageEndBps).toBe(10_000);
  });

  it('is never liquidated in a 60% rise nobody answers, but loses cover', () => {
    const r = run(line(1_000, 1_600, 200));
    expect(r.liquidated).toBe(false);
    expect(r.deRiskEvents).toBeGreaterThan(0);
    expect(r.coverageEndBps).toBeLessThan(10_000);
    expect(r.minMarginRatioBps).toBeGreaterThan(500);
    expect(r.topUps).toBe(0);
  });

  it('keeps full cover in the same rise when top-ups arrive within six hours', () => {
    const r = run(line(1_000, 1_600, 200), { topUpDelayHours: 6 });
    expect(r.liquidated).toBe(false);
    expect(r.deRiskEvents).toBe(0);
    expect(r.topUps).toBeGreaterThan(0);
    expect(r.minCoverageBps).toBeGreaterThanOrEqual(9_900);
    expect(Math.abs(r.endDriftBps)).toBeLessThan(150);
  });

  it('places nothing during a venue outage and resumes after it', () => {
    const bars = line(1_000, 1_000, 48);
    const r = run(bars, { lockAt: T0 + 10 * HOUR, outages: [{ from: T0 + 8 * HOUR, to: T0 + 20 * HOUR }] });
    const during = r.series.filter((pt) => pt.t >= T0 + 10 * HOUR && pt.t < T0 + 20 * HOUR);
    expect(during.every((pt) => pt.shortLots === 0)).toBe(true);
    expect(r.refusals.STALE_HL).toBeGreaterThan(0);
    expect(r.coverageEndBps).toBe(10_000);
  });

  it('waits for funding to recover before opening a lock', () => {
    const bars = [...line(1_000, 1_000, 80, -0.0001), ...line(1_000, 1_000, 120, 0.0000125)];
    const r = run(bars, { lockAt: T0 + 72 * HOUR });
    expect(r.refusals.FUNDING_BELOW_FLOOR).toBeGreaterThan(0);
    expect(r.series[75]?.shortLots).toBe(0);
    expect(r.coverageEndBps).toBe(10_000);
  });

  it('survives a 15% wick inside one hour', () => {
    const bars = line(1_000, 1_000, 24);
    bars[12] = { ...(bars[12] as Bar), h: 1_155 };
    const r = run(bars);
    expect(r.liquidated).toBe(false);
    expect(r.deRiskEvents).toBe(0);
    expect(r.coverageEndBps).toBe(10_000);
  });

  it('reports a liquidation when the price gaps past every rung at once', () => {
    const bars = line(1_000, 1_000, 24);
    bars[12] = { ...(bars[12] as Bar), o: 1_000, h: 1_500, l: 1_000, c: 1_500 };
    const r = run(bars);
    expect(r.liquidated).toBe(true);
  });

  it('rejects an empty series', () => {
    expect(() => run([])).toThrow();
  });
});
