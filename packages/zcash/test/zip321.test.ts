import { describe, expect, it } from 'vitest';
import { addressKind, buildPaymentUri, formatZec, parsePaymentUri, parseZec } from '../src/zip321';

// Addresses from the ZIP-321 specification examples.
const SAPLING = 'ztestsapling10yy2ex5dcqkclhc7z7yrnjq2z6feyjad56ptwlfgmy77dmaqqrl9gyhprdx59qgmsnyfska2kez';
const TRANSPARENT = 'tmEZhbWHTpdKMw5it8YDspUXSMGQyFwovpU';

describe('amounts', () => {
  it('formats zatoshi as decimal ZEC without trailing zeros', () => {
    expect(formatZec(100_000_000n)).toBe('1');
    expect(formatZec(450_000n)).toBe('0.0045');
    expect(formatZec(1n)).toBe('0.00000001');
    expect(formatZec(12_345_600_000n)).toBe('123.456');
    expect(formatZec(0n)).toBe('0');
  });

  it('parses what it formats', () => {
    for (const zat of [1n, 450_000n, 100_000_000n, 2_099_999_999_999_999n]) {
      expect(parseZec(formatZec(zat))).toBe(zat);
    }
  });

  it('rejects amounts that are not plain decimals or exceed the supply', () => {
    for (const bad of ['', '1.', '.5', '1e3', '-1', '0.000000001', '1,5', '21000001']) {
      expect(() => parseZec(bad), bad).toThrow();
    }
    expect(() => formatZec(-1n)).toThrow();
  });
});

describe('address shapes', () => {
  it('recognises the four address families', () => {
    expect(addressKind(TRANSPARENT)).toBe('transparent');
    expect(addressKind(SAPLING)).toBe('sapling');
    expect(addressKind(`u1${'q'.repeat(100)}`)).toBe('unified');
    expect(addressKind(`tex1${'q'.repeat(38)}`)).toBe('tex');
  });

  it('rejects everything else', () => {
    for (const bad of ['', 'bc1qxyz', '0x52908400098527886E0F7030069857D2E4169EE7', `u1${'B'.repeat(100)}`, 'zcash']) {
      expect(addressKind(bad), bad).toBeNull();
    }
  });
});

describe('payment requests', () => {
  it('matches the single-payment example from the specification', () => {
    const uri = buildPaymentUri([
      { address: SAPLING, amountZat: 100_000_000n, memo: 'This is a simple memo.', message: 'Thank you for your purchase' },
    ]);
    expect(uri).toBe(
      `zcash:${SAPLING}?amount=1&memo=VGhpcyBpcyBhIHNpbXBsZSBtZW1vLg&message=Thank%20you%20for%20your%20purchase`,
    );
  });

  it('matches the two-payment example from the specification', () => {
    const uri = buildPaymentUri([
      { address: TRANSPARENT, amountZat: 12_345_600_000n },
      { address: SAPLING, amountZat: 78_900_000n, memo: 'This is a unicode memo ✨🦄🏆🎉' },
    ]);
    expect(uri).toBe(
      `zcash:?address=${TRANSPARENT}&amount=123.456&address.1=${SAPLING}&amount.1=0.789&memo.1=VGhpcyBpcyBhIHVuaWNvZGUgbWVtbyDinKjwn6aE8J-PhvCfjok`,
    );
  });

  it('round-trips through its own parser', () => {
    const payments = [
      { address: TRANSPARENT, amountZat: 450_000n, label: 'Margin top-up' },
      { address: SAPLING, amountZat: 1n, memo: 'HF-2026-10-0001 / Иван & co', message: 'a=b&c' },
    ];
    expect(parsePaymentUri(buildPaymentUri(payments))).toEqual(payments);
    expect(parsePaymentUri(buildPaymentUri([payments[1]!]))).toEqual([payments[1]]);
  });

  it('refuses a memo to a transparent address', () => {
    expect(() => buildPaymentUri([{ address: TRANSPARENT, amountZat: 1n, memo: 'hi' }])).toThrow(/transparent/);
  });

  it('refuses a memo over 512 bytes, counting bytes not characters', () => {
    expect(() => buildPaymentUri([{ address: SAPLING, amountZat: 1n, memo: 'x'.repeat(513) }])).toThrow(/513 bytes/);
    expect(() => buildPaymentUri([{ address: SAPLING, amountZat: 1n, memo: 'я'.repeat(257) }])).toThrow(/514 bytes/);
    expect(buildPaymentUri([{ address: SAPLING, amountZat: 1n, memo: 'x'.repeat(512) }])).toContain('memo=');
  });

  it('refuses empty requests, bad addresses, zero amounts and repeated addresses', () => {
    expect(() => buildPaymentUri([])).toThrow();
    expect(() => buildPaymentUri([{ address: 'nope', amountZat: 1n }])).toThrow(/not a Zcash address/);
    expect(() => buildPaymentUri([{ address: SAPLING, amountZat: 0n }])).toThrow(/positive/);
    expect(() =>
      buildPaymentUri([
        { address: SAPLING, amountZat: 1n },
        { address: SAPLING, amountZat: 2n },
      ]),
    ).toThrow(/twice/);
  });

  it('rejects malformed URIs when parsing', () => {
    for (const bad of [
      'bitcoin:abc?amount=1',
      `zcash:${SAPLING}`,
      `zcash:${SAPLING}?amount=1&amount=2`,
      `zcash:${SAPLING}?amount=abc`,
      `zcash:?amount=1`,
      `zcash:${SAPLING}?amount=1&memo=@@@`,
      `zcash:${TRANSPARENT}?amount=1&memo=aGk`,
    ]) {
      expect(() => parsePaymentUri(bad), bad).toThrow();
    }
  });
});
