import { DEFAULT_POLICY, type Policy, type ScenarioOutcome, SCENARIOS } from '@holdfast/core';
import { describe, expect, it } from 'vitest';
import { failedScenarios } from '../src/backtest';
import { holdfast } from './harness';

/** The thin-margin, three-times-leverage policy the core package pins its unit tests to. */
const LEAN_POLICY: Policy = {
  hedgeRatioBps: 10_000,
  bandLots: 1,
  maxLeverage: 3,
  marginTargetBps: 4_500,
  deRiskTriggerBps: 2_000,
  deRiskRestoreBps: 2_800,
  topUpWarnBps: 3_000,
  sweepAboveBps: 9_000,
  maxSlippageBps: 30,
  fundingFloorAprBps: -500,
  maxMarkOracleDivBps: 100,
  maxOracleRefDivBps: 150,
  maxDataAgeMs: 180_000,
  minOrderUsd: 10,
};

const GRADED = SCENARIOS.filter((s) => !s.control);
const lean = { 'lean.json': JSON.stringify(LEAN_POLICY) };

interface Report {
  ok: boolean;
  policy: Policy;
  scenarios: { id: string; control: boolean; pass: boolean; checks: { label: string; pass: boolean }[]; result: Record<string, unknown> }[];
}

describe('holdfast backtest', () => {
  it('passes the default policy on the bundled data', async () => {
    const outcome = await holdfast(['backtest']);
    expect(outcome.code).toBe(0);
    expect(outcome.err).toBe('');
    const lines = outcome.out.split('\n');
    expect(lines[0]).toBe('Policy: the default');
    expect(lines.at(-1)).toBe(`All ${GRADED.length} graded scenarios pass.`);
    expect(lines.filter((line) => /^(PASS|FAIL) {2}/.test(line))).toHaveLength(SCENARIOS.length);
  });

  it('prints one block per scenario, with each criterion and the figures behind it', async () => {
    const { out } = await holdfast(['backtest']);
    const block = out.split('\n\n').find((b) => b.startsWith('PASS  june-crash'))?.split('\n');
    expect(block?.slice(0, 6)).toEqual([
      'PASS  june-crash',
      '      June 2026 crash. ZEC falls from about $570 to $247 in days after the Orchard bug.',
      '      [x] never liquidated',
      '      [x] the unhedged treasury loses at least 30%',
      '      [x] locked treasury never more than 3% below its starting value',
      '      [x] ends fully hedged',
    ]);
    expect(block?.slice(6).map((line) => line.trim().split(/\s+/)[0])).toEqual(['locked', 'unhedged', 'cover', 'margin', 'buy-backs', 'funding']);
    expect(block?.[6]).toMatch(/^ {6}locked {5}worst -\d+\.\d%, end [+-]?\d+\.\d%$/);
    expect(block?.[7]).toMatch(/^ {6}unhedged {3}worst -\d+\.\d%, end -\d+\.\d%$/);
    expect(block?.[11]).toMatch(/^ {6}funding {4}-?\$[\d,]+; fees \$[\d,]+ venue, \$[\d,]+ swaps, \$[\d,]+ slippage$/);
  });

  it('marks the control scenario and leaves it out of the count', async () => {
    const { out } = await holdfast(['backtest']);
    expect(out).toContain('squeeze-then-crash-unanswered  (control: the lock is expected not to hold)');
    expect(GRADED).toHaveLength(SCENARIOS.length - 1);
  });

  it('fails a thin-margin policy', async () => {
    const outcome = await holdfast(['backtest', '--policy', 'lean.json'], lean);
    expect(outcome.code).toBe(1);
    const lines = outcome.out.split('\n');
    expect(lines[0]).toBe('Policy: lean.json');
    expect(lines.at(-1)).toBe(
      `4 of ${GRADED.length} graded scenarios fail: may-squeeze-answered-6h, squeeze-then-crash-answered-24h, april-wick, full-tape-answered-24h.`,
    );
    expect(outcome.out).toContain('FAIL  april-wick');
    expect(outcome.out).toContain('      [ ] no buy-back needed');
  });

  it('gives the same verdict to a program', async () => {
    const passed = await holdfast(['backtest', '--json']);
    const good = JSON.parse(passed.out) as Report;
    expect(passed.code).toBe(0);
    expect(good.ok).toBe(true);
    expect(good.policy).toEqual(DEFAULT_POLICY);
    expect(good.scenarios.map((s) => s.id)).toEqual(SCENARIOS.map((s) => s.id));
    expect(good.scenarios.every((s) => s.pass)).toBe(true);
    expect(good.scenarios[0]?.result).toMatchObject({ liquidated: false, coverageEndBps: 10_000 });
    expect(good.scenarios[0]?.result).not.toHaveProperty('series');

    const failed = await holdfast(['backtest', '--json', '--policy=lean.json'], lean);
    const bad = JSON.parse(failed.out) as Report;
    expect(failed.code).toBe(1);
    expect(bad.ok).toBe(false);
    expect(bad.policy).toEqual(LEAN_POLICY);
    expect(bad.scenarios.filter((s) => !s.pass && !s.control).map((s) => s.id)).toHaveLength(4);
  });

  it('refuses an invalid policy and runs nothing', async () => {
    let loaded = false;
    const invalid = { ...LEAN_POLICY, deRiskRestoreBps: 1_500, surprise: 1 };
    const withUnknown = await holdfast(['backtest', '--policy', 'bad.json'], { 'bad.json': JSON.stringify(invalid) }, undefined, {
      loadBars: async () => ((loaded = true), []),
    });
    expect(withUnknown).toMatchObject({ code: 1, out: '' });
    expect(withUnknown.err).toBe('Refusing policy bad.json:\n  unknown field surprise');
    expect(loaded).toBe(false);

    const { surprise: _dropped, ...inconsistent } = invalid;
    const outcome = await holdfast(['backtest', '--policy', 'bad.json'], { 'bad.json': JSON.stringify(inconsistent) });
    expect(outcome.code).toBe(1);
    expect(outcome.err).toBe('Refusing policy bad.json:\n  deRiskRestoreBps must be above deRiskTriggerBps');
  });

  it('refuses a policy file it cannot read or parse', async () => {
    const missing = await holdfast(['backtest', '--policy', 'nowhere.json']);
    expect(missing.code).toBe(1);
    expect(missing.err).toBe("Refusing policy nowhere.json:\n  cannot be read: ENOENT: no such file or directory, open 'nowhere.json'");

    const garbled = await holdfast(['backtest', '--policy', 'bad.json'], { 'bad.json': '{ hedgeRatioBps: ' });
    expect(garbled.err).toBe('Refusing policy bad.json:\n  is not valid JSON');

    const notAnObject = await holdfast(['backtest', '--policy', 'bad.json'], { 'bad.json': '[1, 2]' });
    expect(notAnObject.err).toBe('Refusing policy bad.json:\n  policy must be an object');
  });

  it('does not let a control scenario decide the verdict', () => {
    const outcome = (id: string, control: boolean, pass: boolean) => ({ scenario: { id, control }, pass }) as unknown as ScenarioOutcome;
    const ids = (outcomes: ScenarioOutcome[]) => failedScenarios(outcomes).map((o) => o.scenario.id);
    expect(ids([outcome('graded', false, true), outcome('control', true, false)])).toEqual([]);
    expect(ids([outcome('graded', false, false), outcome('control', true, true)])).toEqual(['graded']);
    expect(ids([outcome('a', false, false), outcome('control', true, false), outcome('b', false, false)])).toEqual(['a', 'b']);
  });

  it('grades whatever history it is given', async () => {
    // On a tape that never moves there is no crash for the unhedged treasury to lose 30% in.
    const HOUR = 3_600_000;
    const from = Date.parse('2026-03-16T00:00:00Z');
    const hours = (Date.parse('2026-10-11T00:00:00Z') - from) / HOUR;
    const flat = Array.from({ length: hours }, (_, i) => ({ t: from + i * HOUR, o: 500, h: 500, l: 500, c: 500, fundingRate: 0.0000125 }));
    const outcome = await holdfast(['backtest'], {}, undefined, { loadBars: async () => flat });
    expect(outcome.code).toBe(1);
    expect(outcome.out).toContain('FAIL  june-crash');
    expect(outcome.out).toContain('      [ ] the unhedged treasury loses at least 30%');
    expect(outcome.out).toContain('      unhedged   worst 0.0%, end 0.0%');
  });

  it('takes no arguments and one policy', async () => {
    expect((await holdfast(['backtest', 'now'])).err).toMatch(/^holdfast: backtest takes no argument, got "now"/);
    expect((await holdfast(['backtest', '--policy'])).err).toMatch(/^holdfast: --policy needs a value/);
    expect((await holdfast(['backtest', '--policy', 'a.json', '--policy', 'b.json'], lean)).err).toMatch(/^holdfast: --policy was given more than once/);
  });
});
