import { buildPaymentUri } from '@holdfast/zcash';
import { describe, expect, it } from 'vitest';
import { ClientError } from '../../src/client/errors';
import { encodeQr, qrByteCapacity, reedSolomon } from '../../src/client/qr';
import { zcashPaymentRequest } from '../../src/client/zcash';
import vectors from './fixtures/qr-vectors.json';

/** A symbol as one hex string, row after row, four modules to a digit. */
function hexOf(modules: boolean[][]): string {
  const bits = modules.flat();
  let hex = '';
  for (let i = 0; i < bits.length; i += 4) {
    let nibble = 0;
    for (let j = 0; j < 4; j += 1) nibble = (nibble << 1) | (bits[i + j] === true ? 1 : 0);
    hex += nibble.toString(16);
  }
  return hex;
}

const dark = (modules: boolean[][], x: number, y: number): '0' | '1' => (modules[y]?.[x] === true ? '1' : '0');

/** The fifteen format bits, highest first, read from beside the top-left finder pattern. */
function formatBits(modules: boolean[][]): string {
  let bits = '';
  for (let i = 14; i >= 0; i -= 1) {
    if (i <= 5) bits += dark(modules, 8, i);
    else if (i === 6) bits += dark(modules, 8, 7);
    else if (i === 7) bits += dark(modules, 8, 8);
    else if (i === 8) bits += dark(modules, 7, 8);
    else bits += dark(modules, 14 - i, 8);
  }
  return bits;
}

/** The eighteen version bits, highest first, read from beside the top-right finder pattern. */
function versionBits(modules: boolean[][], size: number): string {
  let bits = '';
  for (let i = 17; i >= 0; i -= 1) bits += dark(modules, size - 11 + (i % 3), Math.floor(i / 3));
  return bits;
}

describe('the QR encoder', () => {
  it('holds what the standard says a symbol holds in byte mode at level M', () => {
    // ISO/IEC 18004, table 7: data capacity in bytes, versions 1 to 40, level M.
    const capacity = [14, 26, 42, 62, 84, 106, 122, 152, 180, 213, 251, 287, 331, 362, 412, 450, 504, 560, 624, 666, 711, 779, 857, 911, 997, 1059, 1125, 1190, 1264, 1370, 1452, 1538, 1628, 1722, 1809, 1911, 1989, 2099, 2213, 2331];
    expect(capacity.map((_, i) => qrByteCapacity(i + 1))).toEqual(capacity);
  });

  it('computes the error correction codewords of the worked example', () => {
    // "HELLO WORLD" at version 1-M: its sixteen data codewords and the ten that correct them.
    const data = [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17];
    expect(reedSolomon(data, 10)).toEqual([196, 35, 39, 119, 235, 215, 231, 226, 93, 23]);
  });

  it('writes the format information of level M for each mask as the standard tabulates it', () => {
    const table = ['101010000010010', '101000100100101', '101111001111100', '101101101001011', '100010111111001', '100000011001110', '100111110010111', '100101010100000'];
    table.forEach((bits, mask) => {
      const qr = encodeQr('zcash:', { mask });
      expect(qr.mask).toBe(mask);
      expect(formatBits(qr.modules)).toBe(bits);
    });
  });

  it('writes the version information from version 7 up', () => {
    for (const [version, bits] of [[7, '000111110010010100'], [8, '001000010110111100'], [21, '010101011010000011'], [40, '101000110001101001']] as const) {
      const qr = encodeQr('x'.repeat(qrByteCapacity(version)), { mask: 0 });
      expect(qr.version).toBe(version);
      expect(versionBits(qr.modules, qr.size)).toBe(bits);
    }
  });

  it('produces, module for module, the symbols of an independent encoder', () => {
    // Made with the `qrcode` package (1.5.4) for the same bytes in byte mode, level M, with the mask given.
    expect(vectors.map((vector) => vector.version)).toEqual([4, 4, 4, 4, 4, 4, 4, 4, 1, 7, 10, 14, 32, 40, 8]);
    for (const vector of vectors) {
      const qr = encodeQr(vector.text, { mask: vector.mask });
      expect({ version: qr.version, size: qr.size, mask: qr.mask }).toEqual({ version: vector.version, size: vector.size, mask: vector.mask });
      expect(qr.modules).toHaveLength(vector.size);
      expect(qr.modules.every((row) => row.length === vector.size)).toBe(true);
      expect(hexOf(qr.modules), `${vector.text.slice(0, 24)}… at mask ${vector.mask}`).toBe(vector.modules);
    }
  });

  it('picks the smallest version that fits and steps up exactly at the limit', () => {
    for (const version of [1, 2, 9, 10, 26, 27, 39]) {
      const limit = qrByteCapacity(version);
      expect(encodeQr('a'.repeat(limit)).version).toBe(version);
      expect(encodeQr('a'.repeat(limit + 1)).version).toBe(version + 1);
    }
    // Capacity is counted in bytes: these are six characters and eighteen bytes.
    expect(encodeQr('€€€€€€').version).toBe(2);
    expect(() => encodeQr('a'.repeat(2_332))).toThrow(RangeError);
    expect(encodeQr('').version).toBe(1);
  });

  it('chooses a mask by itself, the same one every time, and takes none that does not exist', () => {
    const uri = 'zcash:t1Hsc1LR8yKnbbe3twRp88p6vFfC5t7DLbs?amount=2.5';
    const qr = encodeQr(uri);
    expect(qr.mask).toBeGreaterThanOrEqual(0);
    expect(qr.mask).toBeLessThanOrEqual(7);
    expect(encodeQr(uri)).toEqual(qr);
    expect(encodeQr(uri, { mask: qr.mask })).toEqual(qr);
    for (const mask of [-1, 8, 1.5]) expect(() => encodeQr(uri, { mask })).toThrow(RangeError);
  });

  it('draws the three finder patterns and the dark module of every symbol', () => {
    for (const text of ['a', 'x'.repeat(300), 'x'.repeat(2_000)]) {
      const { modules, size } = encodeQr(text);
      const finder = ['1111111', '1000001', '1011101', '1011101', '1011101', '1000001', '1111111'];
      for (const [left, top] of [[0, 0], [size - 7, 0], [0, size - 7]] as const) {
        expect(finder.map((_, y) => finder.map((__, x) => dark(modules, left + x, top + y)).join(''))).toEqual(finder);
      }
      expect(dark(modules, 8, size - 8)).toBe('1');
    }
  });
});

describe('a Zcash payment request', () => {
  const uri = 'zcash:t1Hsc1LR8yKnbbe3twRp88p6vFfC5t7DLbs?amount=2.5';

  it('is handed over as text, as a link and as a QR code of the same URI', () => {
    const request = zcashPaymentRequest(uri);
    expect(request.uri).toBe(uri);
    expect(request.href).toBe(uri);
    expect(request.qr).toEqual(encodeQr(uri));
    expect(request.qr.modules).toHaveLength(request.qr.size);
  });

  it('carries a long request with a unified address and a memo', () => {
    const long = `zcash:?address=u1${'q'.repeat(210)}&amount=1.5&memo=${'A'.repeat(120)}&address.1=u1${'z'.repeat(210)}&amount.1=0.25`;
    const request = zcashPaymentRequest(long);
    expect(request.qr.version).toBeGreaterThan(15);
    expect(request.qr.size).toBe(17 + 4 * request.qr.version);
  });

  it('refuses whatever is not a zcash: URI, since it becomes the target of a link', () => {
    for (const bad of ['', 'zcash:', 'javascript:alert(1)', ' zcash:t1abc?amount=1', 'ZCASH:t1abc', 'https://example.com/zcash:t1abc', 'zcash:t1abc?message=two words', 'zcash:t1abc\n?amount=1']) {
      expect(() => zcashPaymentRequest(bad), bad).toThrow(ClientError);
    }
    expect(() => zcashPaymentRequest(`zcash:${'a'.repeat(2_400)}`)).toThrow('too long for a QR code');
  });

  it('is held to the payment that was asked for, where the page says what that was', () => {
    const address = 't1Hsc1LR8yKnbbe3twRp88p6vFfC5t7DLbs';
    // The request the server's own package writes for a payment is the one expected for it.
    for (const amountZat of [250_000_000n, 1n, 100_000_000n, 123_456_789n, 2_100_000_000_000_000n, 10n]) {
      const written = buildPaymentUri([{ address, amountZat }]);
      expect(zcashPaymentRequest(written, { address, amountZat }).uri).toBe(written);
    }
    const refused = (text: string, expected: { address: string; amountZat: bigint }): string => {
      try {
        zcashPaymentRequest(text, expected);
      } catch (error) {
        if (error instanceof ClientError) return error.code;
        throw error;
      }
      return 'taken';
    };
    const expected = { address, amountZat: 250_000_000n };
    expect(refused(uri, expected)).toBe('taken');
    // Another amount, another address, a second payment tacked on, a memo nobody asked for.
    expect(refused(`zcash:${address}?amount=25`, expected)).toBe('unexpected_request');
    expect(refused('zcash:t1VmmGiyjVNeCjxDZzg7vZmd99WyzVby9yC?amount=2.5', expected)).toBe('unexpected_request');
    expect(refused(`zcash:?address=${address}&amount=2.5&address.1=t1VmmGiyjVNeCjxDZzg7vZmd99WyzVby9yC&amount.1=100`, expected)).toBe('unexpected_request');
    expect(refused(`${uri}&memo=aGVsbG8`, expected)).toBe('unexpected_request');
    expect(refused(uri, { address, amountZat: 0n })).toBe('unexpected_request');
  });
});
