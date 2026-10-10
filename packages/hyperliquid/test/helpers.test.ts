import { encodeAbiParameters, keccak256, parseAbiParameters } from 'viem';
import { describe, expect, it } from 'vitest';
import { cloidFor, FractionalLotError, fundingAprFromHistory, HyperliquidError, lotsToSize, sizeToLots } from '../src/index';
import { fixtures } from './support';

describe('lotsToSize', () => {
  it('writes lots as a size with exactly two decimals', () => {
    expect(lotsToSize(1)).toBe('0.01');
    expect(lotsToSize(10)).toBe('0.10');
    expect(lotsToSize(99)).toBe('0.99');
    expect(lotsToSize(100)).toBe('1.00');
    expect(lotsToSize(124)).toBe('1.24');
    expect(lotsToSize(123_456)).toBe('1234.56');
    expect(lotsToSize(0)).toBe('0.00');
  });

  it('refuses anything that is not a whole, non-negative number of lots', () => {
    for (const lots of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) {
      expect(() => lotsToSize(lots)).toThrow(HyperliquidError);
    }
  });
});

describe('sizeToLots', () => {
  it('reads signed sizes the way Hyperliquid prints them', () => {
    expect(sizeToLots('0.01')).toBe(1);
    expect(sizeToLots('-1.24')).toBe(-124);
    expect(sizeToLots('550.58')).toBe(55_058);
    expect(sizeToLots('3')).toBe(300);
    expect(sizeToLots('0.5')).toBe(50);
    expect(sizeToLots('-0.02')).toBe(-2);
    expect(sizeToLots('1.2400')).toBe(124);
  });

  it('gives plain zero for an empty position, never negative zero', () => {
    expect(Object.is(sizeToLots('0.0'), 0)).toBe(true);
    expect(Object.is(sizeToLots('-0.00'), 0)).toBe(true);
  });

  it('round-trips with lotsToSize', () => {
    for (const lots of [1, 7, 100, 12_345, 1_000_000]) expect(sizeToLots(lotsToSize(lots))).toBe(lots);
  });

  it('rejects a size finer than one lot with a typed error', () => {
    for (const size of ['0.001', '-1.245', '2.0000001', '0.019']) {
      expect(() => sizeToLots(size)).toThrow(FractionalLotError);
    }
    try {
      sizeToLots('-1.245');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(FractionalLotError);
      expect((error as FractionalLotError).code).toBe('FRACTIONAL_LOT');
      expect((error as FractionalLotError).size).toBe('-1.245');
    }
  });

  it('rejects text that is not a decimal number', () => {
    for (const size of ['', 'abc', '1e3', '.5', '1.', '+1', '1,5', ' 1', '99999999999999999999']) {
      expect(() => sizeToLots(size)).toThrow(HyperliquidError);
    }
  });
});

describe('cloidFor', () => {
  it('is 16 bytes of lowercase hex', () => {
    expect(cloidFor('org_1', 1_791_635_000_000, 0)).toMatch(/^0x[0-9a-f]{32}$/);
  });

  it('is deterministic', () => {
    expect(cloidFor('org_1', 42, 0)).toBe(cloidFor('org_1', 42, 0));
    // Pinned: a change to the derivation would stop a retry after a deploy from matching its first attempt.
    expect(cloidFor('org_1', 42, 0)).toBe('0x6d999ab2872e7f2c8f8d2a76304e486c');
  });

  it('is the first 16 bytes of keccak256 over the ABI-encoded inputs', () => {
    const preimage = encodeAbiParameters(parseAbiParameters('string, string, uint256, uint256'), [
      'holdfast/cloid/1',
      'treasury-7',
      1_791_635_000_000n,
      3n,
    ]);
    expect(cloidFor('treasury-7', 1_791_635_000_000, 3)).toBe(keccak256(preimage).slice(0, 34));
  });

  it('changes with every input', () => {
    const ids = new Set([
      cloidFor('org_1', 42, 0),
      cloidFor('org_2', 42, 0),
      cloidFor('org_1', 43, 0),
      cloidFor('org_1', 42, 1),
      cloidFor('org_14', 2, 0),
      cloidFor('org_1', 4, 20),
    ]);
    expect(ids.size).toBe(6);
  });

  it('validates its inputs', () => {
    expect(() => cloidFor('', 1, 0)).toThrow(HyperliquidError);
    expect(() => cloidFor('org', -1, 0)).toThrow(HyperliquidError);
    expect(() => cloidFor('org', 1.5, 0)).toThrow(HyperliquidError);
    expect(() => cloidFor('org', 1, -1)).toThrow(HyperliquidError);
  });
});

describe('fundingAprFromHistory', () => {
  it('annualises the mean hourly rate into bps', () => {
    // Hyperliquid's base rate of 0.00125% an hour is 10.95% a year.
    expect(fundingAprFromHistory([0.0000125])).toBe(1095);
    expect(fundingAprFromHistory([0.0000125, 0.0000125, -0.000025])).toBe(0);
    expect(fundingAprFromHistory([0.00001, 0.00003])).toBe(1752);
  });

  it('is negative when shorts pay', () => {
    expect(fundingAprFromHistory([-0.00005])).toBe(-4380);
  });

  it('matches the recorded ZEC funding history', () => {
    const rates = fixtures.fundingHistory.map((sample) => Number(sample.fundingRate));
    expect(rates).toHaveLength(72);
    expect(fundingAprFromHistory(rates)).toBe(1095);
  });

  it('treats missing or broken data as an error, not as zero', () => {
    expect(() => fundingAprFromHistory([])).toThrow(HyperliquidError);
    expect(() => fundingAprFromHistory([0.0000125, Number.NaN])).toThrow(HyperliquidError);
  });
});
