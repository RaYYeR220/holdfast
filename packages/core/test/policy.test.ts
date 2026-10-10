import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY, validatePolicy } from '../src/policy';
import { LEAN_POLICY } from './fixtures';

const errorsOf = (p: unknown): string[] => {
  const r = validatePolicy(p);
  return r.ok ? [] : r.errors;
};

describe('validatePolicy', () => {
  it('accepts the default policy and the test fixture', () => {
    expect(validatePolicy(structuredClone(DEFAULT_POLICY)).ok).toBe(true);
    expect(validatePolicy(structuredClone(LEAN_POLICY)).ok).toBe(true);
  });

  it('rejects non-objects', () => {
    expect(errorsOf(null)).toEqual(['policy must be an object']);
    expect(errorsOf([])).toEqual(['policy must be an object']);
    expect(errorsOf('x')).toEqual(['policy must be an object']);
  });

  it('rejects unknown and missing fields', () => {
    expect(errorsOf({ ...LEAN_POLICY, turbo: true })).toContain('unknown field turbo');
    const { bandLots: _omitted, ...rest } = LEAN_POLICY;
    expect(errorsOf(rest)).toContain('missing field bandLots');
  });

  it('rejects a hedge ratio outside 0..100%', () => {
    expect(errorsOf({ ...LEAN_POLICY, hedgeRatioBps: 10_001 }).join()).toMatch(/hedgeRatioBps/);
    expect(errorsOf({ ...LEAN_POLICY, hedgeRatioBps: -1 }).join()).toMatch(/hedgeRatioBps/);
    expect(errorsOf({ ...LEAN_POLICY, hedgeRatioBps: 50.5 }).join()).toMatch(/hedgeRatioBps/);
  });

  it('rejects a band smaller than one lot', () => {
    expect(errorsOf({ ...LEAN_POLICY, bandLots: 0 }).join()).toMatch(/bandLots/);
  });

  it('rejects a restore ratio at or above the leverage floor', () => {
    expect(errorsOf({ ...LEAN_POLICY, deRiskRestoreBps: 3_400 }).join()).toMatch(/leverage floor/);
  });

  it('rejects a restore ratio that is not above the trigger', () => {
    expect(errorsOf({ ...LEAN_POLICY, deRiskRestoreBps: 2_000 }).join()).toMatch(/above deRiskTriggerBps/);
    expect(errorsOf({ ...LEAN_POLICY, deRiskTriggerBps: 2_900 }).join()).toMatch(/above deRiskTriggerBps/);
  });

  it('rejects de-risk ratios that are not positive integers', () => {
    expect(errorsOf({ ...LEAN_POLICY, deRiskTriggerBps: 0 }).join()).toMatch(/deRiskTriggerBps/);
    expect(errorsOf({ ...LEAN_POLICY, deRiskRestoreBps: 28.5 }).join()).toMatch(/deRiskRestoreBps/);
  });

  it('keeps the margin target between the warning level and the sweep level', () => {
    expect(errorsOf({ ...LEAN_POLICY, marginTargetBps: 3_000 }).join()).toMatch(/marginTargetBps/);
    expect(errorsOf({ ...LEAN_POLICY, sweepAboveBps: 4_500 }).join()).toMatch(/sweepAboveBps/);
    expect(errorsOf({ ...LEAN_POLICY, topUpWarnBps: 4_500 }).join()).toMatch(/topUpWarnBps/);
  });
});
