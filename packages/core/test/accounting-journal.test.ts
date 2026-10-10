import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { describe, expect, it } from 'vitest';
import { driftUsd, fundingAprBps, navUsd, runwayMonths } from '../src/accounting';
import { type Hex, ZERO_ROOT, canonicalJson, digest, merkleRoot } from '../src/journal';

describe('accounting', () => {
  it('adds the three legs of the treasury', () => {
    const nav = navUsd({ treasuryZat: 1_000_000n, px: 1223.3, hlAccountValueUsd: 5.5, payoutFloatUsd: 3 });
    expect(nav).toBeCloseTo(12.233 + 5.5 + 3, 9);
  });

  it('does not count deliberate flows as drift', () => {
    expect(driftUsd({ navNow: 130, navAtLock: 100, externalFlowsUsd: 25 })).toBe(5);
    expect(driftUsd({ navNow: 70, navAtLock: 100, externalFlowsUsd: -30 })).toBe(0);
  });

  it('measures runway in months and refuses to divide by nothing', () => {
    expect(runwayMonths(120_000, 10_000)).toBe(12);
    expect(runwayMonths(-5, 10_000)).toBe(0);
    expect(runwayMonths(120_000, 0)).toBeNull();
    expect(runwayMonths(120_000, Number.NaN)).toBeNull();
  });

  it('annualises hourly funding', () => {
    expect(fundingAprBps(Array(24).fill(0.0000125))).toBe(1_095);
    expect(fundingAprBps([0.0001, -0.0001])).toBe(0);
    expect(fundingAprBps([])).toBe(0);
  });
});

describe('journal', () => {
  it('serialises the same content the same way whatever the key order', () => {
    const a = canonicalJson({ b: 1, a: { d: [1, 2n, 'x'], c: null } });
    const b = canonicalJson({ a: { c: null, d: [1, 2n, 'x'] }, b: 1 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":{"c":null,"d":[1,"2","x"]},"b":1}');
  });

  it('drops undefined properties and keeps array positions', () => {
    expect(canonicalJson({ a: undefined, b: [undefined, 1] })).toBe('{"b":[null,1]}');
  });

  it('refuses values it cannot represent', () => {
    expect(() => canonicalJson(Number.NaN)).toThrow();
    expect(() => canonicalJson({ f: () => 1 })).toThrow();
  });

  it('digests to a stable 32-byte hash', () => {
    const d = digest({ lots: 1, px: 1223.3 });
    expect(d).toMatch(/^0x[0-9a-f]{64}$/);
    expect(digest({ px: 1223.3, lots: 1 })).toBe(d);
    expect(digest({ lots: 2, px: 1223.3 })).not.toBe(d);
  });

  const leaf = (n: number): Hex => `0x${n.toString(16).padStart(64, '0')}`;
  const pair = (a: Hex, b: Hex): Hex => {
    const [lo, hi] = a <= b ? [a, b] : [b, a];
    return `0x${bytesToHex(keccak_256(hexToBytes(lo.slice(2) + hi.slice(2))))}`;
  };

  it('gives the zero root for an empty journal and the leaf for one entry', () => {
    expect(merkleRoot([])).toBe(ZERO_ROOT);
    expect(merkleRoot([leaf(7)])).toBe(leaf(7));
  });

  it('hashes pairs in sorted order', () => {
    expect(merkleRoot([leaf(1), leaf(2)])).toBe(pair(leaf(1), leaf(2)));
    expect(merkleRoot([leaf(2), leaf(1)])).toBe(merkleRoot([leaf(1), leaf(2)]));
  });

  it('moves an odd node up unchanged', () => {
    const expected = pair(pair(leaf(1), leaf(2)), leaf(3));
    expect(merkleRoot([leaf(1), leaf(2), leaf(3)])).toBe(expected);
  });

  it('matches the fixed vector shared with the contract tests', () => {
    expect(merkleRoot([leaf(1), leaf(2), leaf(3)])).toBe(
      '0x9b0225f2c6f59eeaf8302811ea290e95258763189b82dc033158e99a6ef45a87',
    );
  });

  it('rejects leaves of the wrong size', () => {
    expect(() => merkleRoot(['0x1234'])).toThrow();
  });
});
