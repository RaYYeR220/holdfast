import { describe, expect, it } from 'vitest';
import { formatBaseUnits, MAX_TOKEN_AMOUNT, toBaseUnits } from '../src/amounts';

describe('toBaseUnits', () => {
  it('scales a decimal string by the token decimals', () => {
    expect(toBaseUnits('12.34', 6)).toBe(12_340_000n);
    expect(toBaseUnits('1', 6)).toBe(1_000_000n);
    expect(toBaseUnits('0.000001', 6)).toBe(1n);
    expect(toBaseUnits('0', 6)).toBe(0n);
    expect(toBaseUnits('007.50', 6)).toBe(7_500_000n);
  });

  it('handles tokens without decimals', () => {
    expect(toBaseUnits('42', 0)).toBe(42n);
    expect(() => toBaseUnits('42.0', 0)).toThrow(/more than 0 decimal places/);
  });

  it('refuses digits the token cannot represent instead of rounding', () => {
    expect(() => toBaseUnits('1.2345678', 6)).toThrow(/more than 6 decimal places/);
  });

  it('refuses anything that is not a plain non-negative decimal', () => {
    for (const bad of ['', ' 1', '1 ', '-1', '+1', '.5', '1.', '1e3', '1,000', '0x10', 'NaN', '1.2.3']) {
      expect(() => toBaseUnits(bad, 6), bad).toThrow(/invalid amount/);
    }
  });

  it('keeps precision where a float would lose it', () => {
    expect(toBaseUnits('9007199254.740993', 6)).toBe(9_007_199_254_740_993n);
    expect(formatBaseUnits(9_007_199_254_740_993n, 6)).toBe('9007199254.740993');
  });

  it('refuses amounts beyond a 64-bit token amount', () => {
    expect(toBaseUnits('18446744073709.551615', 6)).toBe(MAX_TOKEN_AMOUNT);
    expect(() => toBaseUnits('18446744073709.551616', 6)).toThrow(/does not fit/);
  });

  it('refuses nonsensical decimals', () => {
    expect(() => toBaseUnits('1', -1)).toThrow(/invalid token decimals/);
    expect(() => toBaseUnits('1', 1.5)).toThrow(/invalid token decimals/);
  });
});

describe('formatBaseUnits', () => {
  it('prints base units as a decimal without trailing zeros', () => {
    expect(formatBaseUnits(5_750_000n, 6)).toBe('5.75');
    expect(formatBaseUnits(10_000_000n, 6)).toBe('10');
    expect(formatBaseUnits(1n, 6)).toBe('0.000001');
    expect(formatBaseUnits(0n, 6)).toBe('0');
    expect(formatBaseUnits(42n, 0)).toBe('42');
  });

  it('refuses negative amounts', () => {
    expect(() => formatBaseUnits(-1n, 6)).toThrow(/negative/);
  });

  it('round-trips with toBaseUnits', () => {
    for (const units of [0n, 1n, 999_999n, 1_000_000n, 123_456_789n, MAX_TOKEN_AMOUNT]) {
      expect(toBaseUnits(formatBaseUnits(units, 6), 6)).toBe(units);
    }
  });
});
