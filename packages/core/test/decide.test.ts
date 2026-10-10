import { describe, expect, it } from 'vitest';
import { decide } from '../src/decide';
import { DEFAULT_POLICY, type Policy } from '../src/policy';
import type { RefusalCode, Snapshot } from '../src/snapshot';
import { roundPx } from '../src/units';

const NOW = 1_800_000_000_000;
const PX = 1223.3;

type Hl = NonNullable<Snapshot['hl']>;

function snap(over: {
  treasuryZat?: bigint | null;
  hl?: Partial<Hl> | null;
  ref?: { px: number; asOf: number } | null;
  treasuryAsOf?: number;
}): Snapshot {
  const treasury =
    over.treasuryZat === null
      ? null
      : { zat: over.treasuryZat ?? 1_450_000n, asOf: over.treasuryAsOf ?? NOW - 30_000 };
  const hl =
    over.hl === null
      ? null
      : {
          asOf: NOW - 5_000,
          markPx: PX,
          oraclePx: PX,
          shortLots: 0,
          accountValueUsd: 6,
          fundingAprBps: 1_190,
          ...over.hl,
        };
  const ref = over.ref === undefined ? { px: PX, asOf: NOW - 10_000 } : over.ref;
  return { now: NOW, treasury, hl, ref };
}

const codes = (d: { refusals: { code: RefusalCode }[] }) => d.refusals.map((r) => r.code);
const policy = (over: Partial<Policy> = {}): Policy => ({ ...DEFAULT_POLICY, ...over });

describe('decide: holding and guards', () => {
  it('holds without venue data', () => {
    const d = decide(snap({ hl: null }), policy());
    expect(d.mode).toBe('HOLD');
    expect(d.actions).toEqual([]);
    expect(codes(d)).toEqual(['STALE_HL']);
    expect(d.targetLots).toBeNull();
  });

  it('holds when venue data is older than the limit', () => {
    const d = decide(snap({ hl: { asOf: NOW - 180_001 } }), policy());
    expect(d.mode).toBe('HOLD');
    expect(d.actions).toEqual([]);
    expect(codes(d)).toEqual(['STALE_HL']);
  });

  it('treats a broken price as stale venue data', () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const d = decide(snap({ hl: { markPx: bad } }), policy());
      expect(d.actions).toEqual([]);
      expect(codes(d)).toEqual(['STALE_HL']);
    }
  });

  it('holds when the treasury cannot be read', () => {
    const d = decide(snap({ treasuryZat: null }), policy());
    expect(d.mode).toBe('HOLD');
    expect(d.actions).toEqual([]);
    expect(codes(d)).toEqual(['STALE_TREASURY']);
  });

  it('holds when the treasury reading is too old', () => {
    const d = decide(snap({ treasuryAsOf: NOW - 200_000 }), policy());
    expect(d.actions).toEqual([]);
    expect(codes(d)).toEqual(['STALE_TREASURY']);
  });

  it('refuses to open a short when mark and oracle disagree', () => {
    const d = decide(snap({ hl: { markPx: PX * 1.02 } }), policy());
    expect(d.actions).toEqual([]);
    expect(codes(d)).toContain('MARK_ORACLE_DIVERGENCE');
  });

  it('refuses to open a short when the oracle and the reference disagree', () => {
    const d = decide(snap({ ref: { px: PX * 0.97, asOf: NOW - 1_000 } }), policy());
    expect(d.actions).toEqual([]);
    expect(codes(d)).toContain('ORACLE_REF_DIVERGENCE');
  });

  it('refuses to open a short without a fresh reference price', () => {
    expect(codes(decide(snap({ ref: null }), policy()))).toContain('STALE_REF');
    expect(codes(decide(snap({ ref: { px: PX, asOf: NOW - 999_999 } }), policy()))).toContain('STALE_REF');
  });

  it('refuses to open a short when funding is below the floor', () => {
    const d = decide(snap({ hl: { fundingAprBps: -600 } }), policy());
    expect(d.actions).toEqual([]);
    expect(codes(d)).toContain('FUNDING_BELOW_FLOOR');
  });

  it('reports every failed guard, not only the first', () => {
    const d = decide(snap({ ref: null, hl: { fundingAprBps: -600, markPx: PX * 1.05 } }), policy());
    expect(codes(d).sort()).toEqual(['FUNDING_BELOW_FLOOR', 'MARK_ORACLE_DIVERGENCE', 'STALE_REF']);
  });

  it('holds and flags an account that is long', () => {
    const d = decide(snap({ hl: { shortLots: -2 } }), policy());
    expect(d.mode).toBe('HOLD');
    expect(d.actions).toEqual([]);
    expect(codes(d)).toEqual(['UNEXPECTED_LONG']);
  });
});

describe('decide: rebalancing', () => {
  it('opens the short the treasury calls for', () => {
    const d = decide(snap({}), policy());
    expect(d.mode).toBe('REBALANCE');
    expect(d.targetLots).toBe(1);
    expect(d.refusals).toEqual([]);
    expect(d.actions).toEqual([
      { kind: 'increaseShort', lots: 1, limitPx: roundPx(PX * (1 - 30 / 10_000), 'sell') },
    ]);
  });

  it('applies the hedge ratio', () => {
    const d = decide(snap({ treasuryZat: 20_000_000n, hl: { accountValueUsd: 500 } }), policy({ hedgeRatioBps: 5_000 }));
    expect(d.targetLots).toBe(10);
    expect(d.actions[0]).toMatchObject({ kind: 'increaseShort', lots: 10 });
  });

  it('opens only what the leverage cap allows and says so', () => {
    // 10 lots wanted = $122.33 notional; $10 equity at 3x allows $30 = 2 lots.
    const d = decide(snap({ treasuryZat: 10_000_000n, hl: { accountValueUsd: 10 } }), policy());
    expect(d.targetLots).toBe(10);
    expect(d.actions).toEqual([
      { kind: 'increaseShort', lots: 2, limitPx: roundPx(PX * (1 - 30 / 10_000), 'sell') },
    ]);
    expect(codes(d)).toEqual(['LEVERAGE_CAP']);
  });

  it('holds when the leverage cap leaves no room', () => {
    const d = decide(snap({ treasuryZat: 10_000_000n, hl: { accountValueUsd: 3 } }), policy());
    expect(d.mode).toBe('HOLD');
    expect(d.actions).toEqual([]);
    expect(codes(d)).toEqual(['LEVERAGE_CAP']);
  });

  it('holds without margin', () => {
    const d = decide(snap({ hl: { accountValueUsd: 0 } }), policy());
    expect(d.actions).toEqual([]);
    expect(codes(d)).toEqual(['NO_MARGIN']);
  });

  it('holds inside the band', () => {
    const d = decide(snap({ treasuryZat: 12_000_000n, hl: { shortLots: 10, accountValueUsd: 100 } }), policy({ bandLots: 3 }));
    expect(d.mode).toBe('HOLD');
    expect(d.targetLots).toBe(12);
    expect(d.actions).toEqual([]);
    expect(d.refusals).toEqual([]);
  });

  it('holds on target', () => {
    const d = decide(snap({ treasuryZat: 10_000_000n, hl: { shortLots: 10, accountValueUsd: 100 } }), policy());
    expect(d.mode).toBe('HOLD');
    expect(d.actions).toEqual([]);
    expect(d.refusals).toEqual([]);
  });

  it('buys back when the treasury shrinks below the short', () => {
    const d = decide(snap({ treasuryZat: 6_000_000n, hl: { shortLots: 10, accountValueUsd: 100 } }), policy());
    expect(d.mode).toBe('REBALANCE');
    expect(d.actions).toEqual([
      { kind: 'reduceShort', lots: 4, limitPx: roundPx(PX * (1 + 30 / 10_000), 'buy') },
    ]);
  });

  it('buys back even when the price guards would block a new short', () => {
    const d = decide(
      snap({
        treasuryZat: 6_000_000n,
        ref: null,
        hl: { shortLots: 10, accountValueUsd: 100, fundingAprBps: -9_000, markPx: PX * 1.03 },
      }),
      policy(),
    );
    expect(d.mode).toBe('REBALANCE');
    expect(d.actions[0]).toMatchObject({ kind: 'reduceShort', lots: 4 });
    expect(d.refusals).toEqual([]);
  });

  it('refuses an order below the venue minimum unless it closes the position', () => {
    // At $600 one lot is $6, below the $10 minimum.
    const cheap = { markPx: 600, oraclePx: 600 };
    const ref = { px: 600, asOf: NOW - 1_000 };
    const open = decide(snap({ ref, hl: { ...cheap } }), policy());
    expect(open.actions).toEqual([]);
    expect(codes(open)).toEqual(['BELOW_MIN_ORDER']);

    const partial = decide(snap({ ref, treasuryZat: 4_000_000n, hl: { ...cheap, shortLots: 5, accountValueUsd: 100 } }), policy());
    expect(partial.actions).toEqual([]);
    expect(codes(partial)).toEqual(['BELOW_MIN_ORDER']);

    const close = decide(snap({ ref, treasuryZat: 0n, hl: { ...cheap, shortLots: 1, accountValueUsd: 100 } }), policy());
    expect(close.actions).toEqual([{ kind: 'reduceShort', lots: 1, limitPx: roundPx(600 * 1.003, 'buy') }]);
  });
});

describe('decide: de-risk ladder', () => {
  // 10 lots short at $1223.3 is $122.33 notional.
  const short10 = (equity: number, extra: Partial<Hl> = {}) =>
    snap({ treasuryZat: 10_000_000n, hl: { shortLots: 10, accountValueUsd: equity, ...extra } });

  it('reports the margin ratio', () => {
    expect(decide(short10(61.165), policy()).marginRatioBps).toBe(5_000);
    expect(decide(snap({}), policy()).marginRatioBps).toBeNull();
  });

  it('buys back a quarter under the first rung', () => {
    const d = decide(short10(23), policy()); // 18.8%
    expect(d.mode).toBe('DERISK');
    expect(d.actions).toEqual([
      { kind: 'reduceShort', lots: 3, limitPx: roundPx(PX * (1 + 30 / 10_000), 'buy') },
    ]);
  });

  it('uses the deepest rung that applies', () => {
    expect(decide(short10(15), policy()).actions[0]).toMatchObject({ kind: 'reduceShort', lots: 5 }); // 12.3%
    expect(decide(short10(10), policy()).actions[0]).toMatchObject({ kind: 'reduceShort', lots: 10 }); // 8.2%
    expect(decide(short10(-4), policy()).actions[0]).toMatchObject({ kind: 'reduceShort', lots: 10 });
  });

  it('always buys back at least one lot and never more than the short', () => {
    const one = decide(snap({ treasuryZat: 1_000_000n, hl: { shortLots: 1, accountValueUsd: 2 } }), policy());
    expect(one.actions).toEqual([{ kind: 'reduceShort', lots: 1, limitPx: roundPx(PX * 1.003, 'buy') }]);
  });

  it('does not rebalance in the same decision', () => {
    const d = decide(snap({ treasuryZat: 50_000_000n, hl: { shortLots: 10, accountValueUsd: 23 } }), policy());
    expect(d.mode).toBe('DERISK');
    expect(d.actions).toHaveLength(1);
    expect(d.actions[0]?.kind).toBe('reduceShort');
  });

  it('works when the treasury and the reference price are unreadable', () => {
    const d = decide(snap({ treasuryZat: null, ref: null, hl: { shortLots: 10, accountValueUsd: 23 } }), policy());
    expect(d.mode).toBe('DERISK');
    expect(d.actions[0]).toMatchObject({ kind: 'reduceShort', lots: 3 });
  });

  it('does not reopen what it just bought back', () => {
    // After buying back 3 of 10 lots at an 18.8% ratio the remaining 7 lots sit near 26.9%.
    const after = decide(snap({ treasuryZat: 10_000_000n, hl: { shortLots: 7, accountValueUsd: 23 } }), policy());
    expect(after.mode).toBe('HOLD');
    expect(after.actions).toEqual([]);
    expect(codes(after)).toEqual(['LEVERAGE_CAP']);
  });

  it('leaves a healthy short alone', () => {
    const d = decide(short10(61.165), policy());
    expect(d.mode).toBe('HOLD');
    expect(d.actions).toEqual([]);
  });
});
