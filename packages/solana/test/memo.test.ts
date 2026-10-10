import { describe, expect, it } from 'vitest';
import { MAX_MEMO_LENGTH, parseSignatureMemos, validateMemo } from '../src/memo';

describe('validateMemo', () => {
  it('accepts run ids and invoice references', () => {
    expect(validateMemo('HF-2026-10-0001')).toBeNull();
    expect(validateMemo('INV-1041 design retainer (Oct) #2 ~ ok!')).toBeNull();
    expect(validateMemo('x'.repeat(MAX_MEMO_LENGTH))).toBeNull();
  });

  it('rejects an empty memo', () => {
    expect(validateMemo('')).toMatch(/empty/);
  });

  it('rejects a memo over the length cap', () => {
    expect(validateMemo('x'.repeat(MAX_MEMO_LENGTH + 1))).toMatch(/longer than 64/);
  });

  it('rejects anything outside printable ASCII', () => {
    for (const bad of ['Zahlung für Oktober', 'line\nbreak', 'tab\there', 'nul\u0000', 'del\u007f', 'paid ✓']) {
      expect(validateMemo(bad), JSON.stringify(bad)).toMatch(/printable ASCII/);
    }
  });

  it('rejects surrounding spaces, which would make two memos look alike', () => {
    expect(validateMemo(' HF-1')).toMatch(/start or end with a space/);
    expect(validateMemo('HF-1 ')).toMatch(/start or end with a space/);
  });
});

describe('parseSignatureMemos', () => {
  it('returns nothing for a transaction without memos', () => {
    expect(parseSignatureMemos(null)).toEqual([]);
    expect(parseSignatureMemos('')).toEqual([]);
  });

  it('reads a single memo', () => {
    expect(parseSignatureMemos('[15] HF-2026-10-0001')).toEqual(['HF-2026-10-0001']);
  });

  it('reads several memos in order', () => {
    const field = '[15] HF-2026-10-0001; [24] INV-1041 design retainer; [26] INV-1042 audit milestone 2';
    expect(parseSignatureMemos(field)).toEqual([
      'HF-2026-10-0001',
      'INV-1041 design retainer',
      'INV-1042 audit milestone 2',
    ]);
  });

  it('trusts the length prefix, not the separator', () => {
    expect(parseSignatureMemos('[12] a; [3] b; [9; [1] z')).toEqual(['a; [3] b; [9', 'z']);
  });

  it('reads empty memos', () => {
    expect(parseSignatureMemos('[0] ; [0] ')).toEqual(['', '']);
  });

  it('counts the prefix in bytes, as the node does', () => {
    expect(parseSignatureMemos('[6] héllo; [2] ok')).toEqual(['héllo', 'ok']);
  });

  it('stops at the first entry that is not well formed', () => {
    expect(parseSignatureMemos('no prefix')).toEqual([]);
    expect(parseSignatureMemos('[2] ok; garbage')).toEqual(['ok']);
    expect(parseSignatureMemos('[99] too short')).toEqual([]);
    expect(parseSignatureMemos('[x] nope')).toEqual([]);
  });
});
