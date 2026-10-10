import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY, validatePolicy } from '../src/policy';

const errorsOf = (p: unknown): string[] => {
  const r = validatePolicy(p);
  return r.ok ? [] : r.errors;
};

describe('validatePolicy', () => {
  it('accepts the default policy', () => {
    const r = validatePolicy(structuredClone(DEFAULT_POLICY));
    expect(r.ok).toBe(true);
  });

  it('rejects non-objects', () => {
    expect(errorsOf(null)).toEqual(['policy must be an object']);
    expect(errorsOf([])).toEqual(['policy must be an object']);
    expect(errorsOf('x')).toEqual(['policy must be an object']);
  });

  it('rejects unknown and missing fields', () => {
    expect(errorsOf({ ...DEFAULT_POLICY, turbo: true })).toContain('unknown field turbo');
    const { bandLots: _omitted, ...rest } = DEFAULT_POLICY;
    expect(errorsOf(rest)).toContain('missing field bandLots');
  });

  it('rejects a hedge ratio outside 0..100%', () => {
    expect(errorsOf({ ...DEFAULT_POLICY, hedgeRatioBps: 10_001 }).join()).toMatch(/hedgeRatioBps/);
    expect(errorsOf({ ...DEFAULT_POLICY, hedgeRatioBps: -1 }).join()).toMatch(/hedgeRatioBps/);
    expect(errorsOf({ ...DEFAULT_POLICY, hedgeRatioBps: 50.5 }).join()).toMatch(/hedgeRatioBps/);
  });

  it('rejects a band smaller than one lot', () => {
    expect(errorsOf({ ...DEFAULT_POLICY, bandLots: 0 }).join()).toMatch(/bandLots/);
  });

  it('rejects a de-risk rung at or above the leverage floor', () => {
    const p = { ...DEFAULT_POLICY, deRisk: [{ marginRatioBps: 3_400, reduceBps: 2_500 }] };
    expect(errorsOf(p).join()).toMatch(/leverage floor/);
  });

  it('rejects rungs that are not ordered from high to low', () => {
    const p = {
      ...DEFAULT_POLICY,
      deRisk: [
        { marginRatioBps: 1_000, reduceBps: 2_500 },
        { marginRatioBps: 2_000, reduceBps: 5_000 },
      ],
    };
    expect(errorsOf(p).join()).toMatch(/highest margin ratio to the lowest/);
  });

  it('rejects malformed rungs and an empty ladder', () => {
    expect(errorsOf({ ...DEFAULT_POLICY, deRisk: [] }).join()).toMatch(/non-empty/);
    expect(errorsOf({ ...DEFAULT_POLICY, deRisk: [{ marginRatioBps: 1_000 }] }).join()).toMatch(/deRisk\[0\]/);
    expect(errorsOf({ ...DEFAULT_POLICY, deRisk: [{ marginRatioBps: 1_000, reduceBps: 0 }] }).join()).toMatch(
      /reduceBps/,
    );
  });

  it('keeps the margin target between the warning level and the sweep level', () => {
    expect(errorsOf({ ...DEFAULT_POLICY, marginTargetBps: 3_000 }).join()).toMatch(/marginTargetBps/);
    expect(errorsOf({ ...DEFAULT_POLICY, sweepAboveBps: 4_500 }).join()).toMatch(/sweepAboveBps/);
    expect(errorsOf({ ...DEFAULT_POLICY, topUpWarnBps: 4_500 }).join()).toMatch(/topUpWarnBps/);
  });
});
