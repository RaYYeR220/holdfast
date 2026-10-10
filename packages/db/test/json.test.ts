import { canonicalJson, digest } from '@holdfast/core';
import { describe, expect, it } from 'vitest';
import { decodeJson, encodeJson, parseJson, stringifyJson } from '../src';
import { isStorableText } from '../src/text';
import { GAP, HIGH_HALF, LOW_HALF, NUL } from './support/fakes';

const roundTrip = (v: unknown) => parseJson(stringifyJson(v));

/** Whether every string in a parsed JSON value, keys included, is one Postgres accepts. */
const storable = (v: unknown): boolean => {
  if (typeof v === 'string') return isStorableText(v);
  if (Array.isArray(v)) return v.every(storable);
  if (v !== null && typeof v === 'object') return Object.entries(v).every(([key, value]) => isStorableText(key) && storable(value));
  return true;
};

describe('bigint-safe JSON', () => {
  it('writes a bigint as a tagged decimal string and reads it back', () => {
    expect(stringifyJson({ zat: 5_000_000n })).toBe('{"zat":{"$bigint":"5000000"}}');
    expect(parseJson('{"zat":{"$bigint":"5000000"}}')).toEqual({ zat: 5_000_000n });
  });

  it('keeps every bigint exact, however large or small', () => {
    const values = [0n, -1n, 9_007_199_254_740_993n, -(2n ** 63n), 2n ** 256n - 1n, 2_100_000_000_000_000n];
    for (const value of values) {
      const back = roundTrip({ value }) as { value: unknown };
      expect(typeof back.value).toBe('bigint');
      expect(back.value).toBe(value);
    }
  });

  it('finds bigints at any depth', () => {
    const value = { a: [1n, { b: 2n, c: [[3n]] }], d: { e: { f: 4n } } };
    expect(roundTrip(value)).toEqual(value);
  });

  it('leaves ordinary JSON as it is', () => {
    const value = { text: 'ünïcode "quoted"', n: 1_223.3, whole: 42, yes: true, no: false, none: null, list: [1, 'two', null], empty: {} };
    expect(encodeJson(value)).toEqual(value);
    expect(roundTrip(value)).toEqual(value);
  });

  it('keeps numbers exactly as doubles', () => {
    const numbers = [0.1 + 0.2, 1e21, 1e-7, 5e-324, Number.MAX_VALUE, Number.MAX_SAFE_INTEGER, -1_219.6, 16_349.01];
    expect(roundTrip(numbers)).toEqual(numbers);
  });

  it('does not mistake text or a number for a bigint', () => {
    const value = { text: '{"$bigint":"1"}', digits: '5000000', number: 5_000_000 };
    expect(roundTrip(value)).toEqual(value);
    expect(typeof (roundTrip(value) as typeof value).digits).toBe('string');
  });

  it('drops what JSON has no place for the same way the digest does', () => {
    const value = { kept: 1, dropped: undefined, list: [undefined, 2] };
    const back = roundTrip(value);
    expect(back).toEqual({ kept: 1, list: [null, 2] });
    expect(canonicalJson(back)).toBe(canonicalJson(value));
  });

  it('reads negative zero back as zero, which digests the same', () => {
    expect(Object.is(roundTrip(-0), 0)).toBe(true);
    expect(digest({ n: -0 })).toBe(digest({ n: 0 }));
  });

  it('gives a value that digests exactly like the original', () => {
    const value = { zat: 123_456_789_012_345_678_901n, px: 1_223.3, nested: [{ lots: 5, fee: 10_000n }], note: null };
    expect(digest(roundTrip(value))).toBe(digest(value));
  });

  it('keeps a key named __proto__ as data', () => {
    const back = parseJson('{"__proto__":{"polluted":true},"n":{"$bigint":"1"}}') as Record<string, unknown>;
    expect(Object.keys(back).sort()).toEqual(['__proto__', 'n']);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(back)).toBe(Object.prototype);
  });

  it('writes a string Postgres would refuse as its JSON escapes, and reads it back', () => {
    const escaped = JSON.stringify(`pay${NUL}roll`).slice(1, -1);
    expect(escaped).toHaveLength('pay'.length + 6 + 'roll'.length);
    expect(JSON.parse(stringifyJson({ memo: `pay${NUL}roll` }))).toEqual({ memo: { $string: escaped } });

    const strings = [
      `pay${NUL}roll`,
      NUL,
      `half ${HIGH_HALF} of a pair`,
      `${LOW_HALF} the other half`,
      `the wrong way round ${LOW_HALF}${HIGH_HALF}`,
      `a quote " a backslash ${String.fromCharCode(92)} and ${NUL}`,
    ];
    for (const text of strings) {
      const stored = stringifyJson({ text });
      expect(storable(JSON.parse(stored))).toBe(true);
      expect((parseJson(stored) as { text: string }).text).toBe(text);
      expect(digest(parseJson(stored))).toBe(digest({ text }));
    }
  });

  it('leaves text Postgres can hold exactly as it is', () => {
    const backslash = String.fromCharCode(92);
    for (const text of ['', 'plain', 'tab\tnewline\n', `a whole pair ${HIGH_HALF}${LOW_HALF}`, `already ${GAP} replaced`, `back${backslash}slash ${backslash}u0000`]) {
      expect(encodeJson(text)).toBe(text);
      expect(roundTrip(text)).toBe(text);
    }
  });

  it('refuses a number that is not finite', () => {
    for (const n of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(() => encodeJson({ n })).toThrow('cannot store a non-finite number');
    }
  });

  it('refuses an object that would read back as something else', () => {
    expect(() => encodeJson({ $bigint: '5' })).toThrow('the key $bigint is reserved');
    expect(() => encodeJson({ a: { $string: 'x', b: 1 } })).toThrow('the key $string is reserved');
    expect(() => encodeJson({ when: new Date(0) })).toThrow('not a plain record');
    expect(() => encodeJson(new Map([['a', 1]]))).toThrow('not a plain record');
    expect(() => encodeJson({ f: () => 1 })).toThrow('cannot store a value of type function');
    expect(() => encodeJson(undefined)).toThrow('cannot store a value of type undefined');
  });

  it('refuses a key Postgres would refuse', () => {
    expect(() => encodeJson({ [`bad${NUL}key`]: 1 })).toThrow('cannot store the key');
    expect(() => encodeJson({ [`bad${HIGH_HALF}key`]: 1 })).toThrow('cannot store the key');
  });

  it('refuses a tag that does not hold a whole number', () => {
    for (const bad of ['{"$bigint":"1.5"}', '{"$bigint":"0x10"}', '{"$bigint":""}', '{"$bigint":5}', '{"$bigint":"1e3"}']) {
      expect(() => parseJson(bad)).toThrow('malformed bigint');
    }
  });

  it('refuses a tag that does not hold the escapes of a string', () => {
    for (const bad of [{ $string: 5 }, { $string: null }, { $string: 'a"b' }, { $string: `${String.fromCharCode(92)}x` }]) {
      expect(() => decodeJson(bad)).toThrow('malformed string');
    }
  });

  it('reads an object that merely has a tag among other keys as an object', () => {
    expect(decodeJson({ $bigint: '5', other: 1 })).toEqual({ $bigint: '5', other: 1 });
    expect(decodeJson({ $string: 'x', other: 1 })).toEqual({ $string: 'x', other: 1 });
  });
});
