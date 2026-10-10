import { describe, expect, it } from 'vitest';
import { lotsToZat, lotsToZec, notionalUsd, roundPx, zatToLots, zatToZec } from '../src/units';

describe('units', () => {
  it('floors zatoshi to whole 0.01 ZEC lots', () => {
    expect(zatToLots(1_450_000n)).toBe(1);
    expect(zatToLots(999_999n)).toBe(0);
    expect(zatToLots(2_000_000n)).toBe(2);
    expect(zatToLots(0n)).toBe(0);
    expect(zatToLots(-5n)).toBe(0);
  });

  it('converts lots back to ZEC and zatoshi', () => {
    expect(lotsToZec(1)).toBe(0.01);
    expect(lotsToZec(250)).toBe(2.5);
    expect(lotsToZat(3)).toBe(3_000_000n);
    expect(zatToZec(1_450_000n)).toBeCloseTo(0.0145, 10);
  });

  it('computes notional in dollars', () => {
    expect(notionalUsd(1, 1223.3)).toBeCloseTo(12.233, 9);
    expect(notionalUsd(0, 1223.3)).toBe(0);
  });

  it('rounds prices to five significant figures, away from the trader', () => {
    expect(roundPx(1223.456, 'sell')).toBe(1223.4);
    expect(roundPx(1223.456, 'buy')).toBe(1223.5);
    expect(roundPx(98.76543, 'buy')).toBe(98.766);
    expect(roundPx(98.76543, 'sell')).toBe(98.765);
  });

  it('keeps prices that are already on the grid', () => {
    expect(roundPx(1223.4, 'buy')).toBe(1223.4);
    expect(roundPx(1223.4, 'sell')).toBe(1223.4);
    expect(roundPx(100, 'buy')).toBe(100);
  });

  it('never uses more than four decimals and allows large integers', () => {
    expect(roundPx(0.123456789, 'sell')).toBe(0.1234);
    expect(roundPx(123456.7, 'sell')).toBe(123456);
    expect(roundPx(123456.7, 'buy')).toBe(123457);
  });

  it('rejects non-positive or non-finite prices', () => {
    expect(() => roundPx(0, 'buy')).toThrow();
    expect(() => roundPx(Number.NaN, 'sell')).toThrow();
  });
});
