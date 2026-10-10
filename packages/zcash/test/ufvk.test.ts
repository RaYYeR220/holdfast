import { testDeriveKeys } from '@ledgerhq/zcash-utils';
import { describe, expect, it } from 'vitest';
import { checkUfvk } from '../src/ufvk';

// The standard all-"abandon" test mnemonic. Nothing is ever sent to it.
const WORDS = `${'abandon '.repeat(23)}art`;
const mainnet = testDeriveKeys(WORDS, 0, 'mainnet').ufvk;
const testnet = testDeriveKeys(WORDS, 0, 'testnet').ufvk;

describe('checkUfvk', () => {
  it('accepts a viewing key and returns the address it receives on', () => {
    const r = checkUfvk(mainnet, 'mainnet');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.address).toMatch(/^u1[02-9ac-hj-np-z]{60,}$/);
  });

  it('tolerates surrounding whitespace', () => {
    expect(checkUfvk(`  ${mainnet}\n`, 'mainnet').ok).toBe(true);
  });

  it('tells a testnet key from a mainnet one', () => {
    expect(checkUfvk(testnet, 'testnet').ok).toBe(true);
    expect(checkUfvk(testnet, 'mainnet')).toEqual({ ok: false, error: 'this is a testnet viewing key' });
    expect(checkUfvk(mainnet, 'testnet')).toEqual({ ok: false, error: 'this is a mainnet viewing key' });
  });

  it('refuses anything that looks like spending material', () => {
    for (const secret of [WORDS, 'secret-extended-key-main1qqqq', 'uskprivate1qqqq']) {
      const r = checkUfvk(secret, 'mainnet');
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/never paste/);
    }
  });

  it('refuses other strings', () => {
    expect(checkUfvk('', 'mainnet').ok).toBe(false);
    expect(checkUfvk('zs1abcdef', 'mainnet').ok).toBe(false);
    expect(checkUfvk('uview1BOGUS', 'mainnet').ok).toBe(false);
    expect(checkUfvk(`${mainnet.slice(0, -6)}qqqqqq`, 'mainnet').ok).toBe(false);
  });
});
