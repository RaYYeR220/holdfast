import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Bar } from '../src/backtest';
import { DEFAULT_POLICY } from '../src/policy';
import { SCENARIOS, runScenario, scorecard } from '../src/scenarios';
import { LEAN_POLICY } from './fixtures';

const { bars } = JSON.parse(readFileSync(new URL('../data/zec-1h.json', import.meta.url), 'utf8')) as { bars: Bar[] };

describe('graded scenarios on real ZEC data', () => {
  it('has continuous hourly data for every window', () => {
    for (const s of SCENARIOS) {
      const window = bars.filter((b) => b.t >= Date.parse(s.from) && b.t < Date.parse(s.to));
      const hours = (Date.parse(s.to) - Date.parse(s.from)) / 3_600_000;
      expect(window.length, s.id).toBeGreaterThanOrEqual(hours - 2);
    }
  });

  for (const s of SCENARIOS) {
    it(`${s.id}: ${s.title}`, () => {
      const outcome = runScenario(s, bars, DEFAULT_POLICY);
      expect(outcome.checks.filter((c) => !c.pass).map((c) => c.label)).toEqual([]);
    });
  }

  it('the control shows the lock failing when top-ups are ignored', () => {
    const control = SCENARIOS.find((s) => s.control);
    expect(control).toBeDefined();
    const r = runScenario(control!, bars, DEFAULT_POLICY).result;
    expect(r.liquidated).toBe(false);
    expect(r.maxDrawdownBps).toBeGreaterThan(r.unhedgedMaxDrawdownBps);
  });

  it('a thin-margin policy does not pass the same scorecard', () => {
    const failed = scorecard(bars, LEAN_POLICY).filter((o) => !o.pass);
    expect(failed.length).toBeGreaterThan(0);
  });
});
