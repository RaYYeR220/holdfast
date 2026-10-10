import { describe, expect, it } from 'vitest';
import { advise } from '../src/advise';
import { decide } from '../src/decide';
import { MAX_FUTURE_SKEW_MS, isFresh } from '../src/freshness';
import type { Policy } from '../src/policy';
import type { Snapshot } from '../src/snapshot';
import { LEAN_POLICY as DEFAULT_POLICY } from './fixtures';

const NOW = 1_800_000_000_000;
const PX = 1223.3;

const base = (): Snapshot => ({
  now: NOW,
  treasury: { zat: 1_450_000n, asOf: NOW - 30_000 },
  hl: { asOf: NOW - 5_000, markPx: PX, oraclePx: PX, shortLots: 0, accountValueUsd: 6, fundingAprBps: 1_190 },
  ref: { px: PX, asOf: NOW - 10_000 },
});

const codes = (s: Snapshot, p: Policy = DEFAULT_POLICY) => decide(s, p).refusals.map((r) => r.code);

describe('isFresh', () => {
  it('accepts readings inside the window', () => {
    expect(isFresh(NOW - 1, NOW, 1_000)).toBe(true);
    expect(isFresh(NOW - 1_000, NOW, 1_000)).toBe(true);
    expect(isFresh(NOW + MAX_FUTURE_SKEW_MS, NOW, 1_000)).toBe(true);
  });

  it('rejects old readings', () => {
    expect(isFresh(NOW - 1_001, NOW, 1_000)).toBe(false);
  });

  it('rejects readings stamped in the future', () => {
    expect(isFresh(NOW + MAX_FUTURE_SKEW_MS + 1, NOW, 1_000)).toBe(false);
    expect(isFresh(NOW + 86_400_000, NOW, 1_000)).toBe(false);
  });

  it('rejects anything that is not a finite number', () => {
    expect(isFresh(Number.NaN, NOW, 1_000)).toBe(false);
    expect(isFresh(NOW, Number.NaN, 1_000)).toBe(false);
    expect(isFresh(NOW, NOW, Number.POSITIVE_INFINITY)).toBe(false);
    expect(isFresh(Number.POSITIVE_INFINITY, NOW, 1_000)).toBe(false);
  });
});

describe('decide fails closed on bad input', () => {
  it('opens the short on a clean snapshot (control)', () => {
    expect(decide(base(), DEFAULT_POLICY).actions).toHaveLength(1);
  });

  it('refuses venue data stamped in the future', () => {
    const s = base();
    s.hl = { ...s.hl!, asOf: NOW + 60_000 };
    expect(decide(s, DEFAULT_POLICY).actions).toEqual([]);
    expect(codes(s)).toEqual(['STALE_HL']);
  });

  it('refuses a treasury reading stamped in the future', () => {
    const s = base();
    s.treasury = { zat: 1_450_000n, asOf: NOW + 60_000 };
    expect(decide(s, DEFAULT_POLICY).actions).toEqual([]);
    expect(codes(s)).toEqual(['STALE_TREASURY']);
  });

  it('refuses a reference price stamped in the future', () => {
    const s = base();
    s.ref = { px: PX, asOf: NOW + 60_000 };
    expect(decide(s, DEFAULT_POLICY).actions).toEqual([]);
    expect(codes(s)).toEqual(['STALE_REF']);
  });

  it('refuses when the clock itself is broken', () => {
    const s = { ...base(), now: Number.NaN };
    expect(decide(s, DEFAULT_POLICY).actions).toEqual([]);
    expect(codes(s)).toEqual(['STALE_HL']);
  });

  it('refuses a funding figure that is not a number', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, undefined as unknown as number]) {
      const s = base();
      s.hl = { ...s.hl!, fundingAprBps: bad };
      expect(decide(s, DEFAULT_POLICY).actions).toEqual([]);
      expect(codes(s)).toEqual(['STALE_HL']);
    }
  });

  it('refuses equity or size that is not a number', () => {
    const equity = base();
    equity.hl = { ...equity.hl!, accountValueUsd: Number.NaN };
    expect(codes(equity)).toEqual(['STALE_HL']);

    const size = base();
    size.hl = { ...size.hl!, shortLots: 1.5 };
    expect(codes(size)).toEqual(['STALE_HL']);
  });

  it('refuses a reference price that is not usable', () => {
    for (const bad of [0, -3, Number.NaN]) {
      const s = base();
      s.ref = { px: bad, asOf: NOW - 1_000 };
      expect(decide(s, DEFAULT_POLICY).actions).toEqual([]);
      expect(codes(s)).toEqual(['STALE_REF']);
    }
  });

  it('refuses a treasury balance of the wrong type', () => {
    const s = base();
    s.treasury = { zat: 1_450_000 as unknown as bigint, asOf: NOW - 1_000 };
    expect(decide(s, DEFAULT_POLICY).actions).toEqual([]);
    expect(codes(s)).toEqual(['STALE_TREASURY']);
  });

  it('refuses to act on a policy that does not validate', () => {
    const broken: Policy[] = [
      { ...DEFAULT_POLICY, maxLeverage: Number.NaN },
      { ...DEFAULT_POLICY, maxSlippageBps: -5 },
      { ...DEFAULT_POLICY, deRiskRestoreBps: 1_000 },
      { ...DEFAULT_POLICY, maxDataAgeMs: Number.POSITIVE_INFINITY },
      {} as Policy,
    ];
    for (const p of broken) {
      const d = decide(base(), p);
      expect(d.mode).toBe('HOLD');
      expect(d.actions).toEqual([]);
      expect(d.refusals.map((r) => r.code)).toEqual(['INVALID_POLICY']);
    }
  });

  it('gives no advice on bad venue data or a bad policy', () => {
    const future = base();
    future.hl = { ...future.hl!, asOf: NOW + 60_000 };
    expect(advise(future, DEFAULT_POLICY)).toEqual([]);
    expect(advise(base(), { ...DEFAULT_POLICY, maxLeverage: Number.NaN })).toEqual([]);
  });
});
