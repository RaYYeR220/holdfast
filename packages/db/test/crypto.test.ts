import { describe, expect, it } from 'vitest';
import { decryptSecret, encryptSecret, parseMasterKey } from '../src';

const KEY = new Uint8Array(32).fill(1);
const OTHER_KEY = new Uint8Array(32).fill(2);
const UFVK = 'uview1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq';

const WRONG = 'the secret could not be decrypted: wrong key or altered envelope';

describe('secrets at rest', () => {
  it('opens what it sealed', () => {
    for (const secret of [UFVK, '', 'ключ от казны 𝔷', 'x'.repeat(10_000)]) {
      expect(decryptSecret(encryptSecret(secret, KEY), KEY)).toBe(secret);
    }
  });

  it('writes a versioned envelope with a 12-byte nonce and a 16-byte tag', () => {
    const [version, nonce, tag, ciphertext] = encryptSecret(UFVK, KEY).split('.');
    expect(version).toBe('v1');
    expect(Buffer.from(nonce ?? '', 'base64url')).toHaveLength(12);
    expect(Buffer.from(tag ?? '', 'base64url')).toHaveLength(16);
    expect(Buffer.from(ciphertext ?? '', 'base64url')).toHaveLength(Buffer.byteLength(UFVK));
  });

  it('never writes the same envelope twice, nor the secret itself', () => {
    const envelopes = new Set(Array.from({ length: 50 }, () => encryptSecret(UFVK, KEY)));
    expect(envelopes.size).toBe(50);
    for (const envelope of envelopes) expect(envelope).not.toContain(UFVK);
  });

  it('does not open with the wrong key', () => {
    expect(() => decryptSecret(encryptSecret(UFVK, KEY), OTHER_KEY)).toThrow(WRONG);
  });

  it('does not open after a change to any character of the envelope', () => {
    const envelope = encryptSecret(UFVK, KEY);
    for (let i = 0; i < envelope.length; i++) {
      if (envelope[i] === '.') continue;
      const altered = `${envelope.slice(0, i)}${envelope[i] === 'A' ? 'B' : 'A'}${envelope.slice(i + 1)}`;
      expect(() => decryptSecret(altered, KEY), `character ${i}`).toThrow();
    }
  });

  it('does not open after a single bit of the nonce, tag or ciphertext is flipped', () => {
    const [version, ...parts] = encryptSecret(UFVK, KEY).split('.');
    for (let part = 0; part < parts.length; part++) {
      const bytes = Buffer.from(parts[part] ?? '', 'base64url');
      bytes[0] = (bytes[0] ?? 0) ^ 0x01;
      const altered = [version, ...parts.map((p, i) => (i === part ? bytes.toString('base64url') : p))].join('.');
      expect(() => decryptSecret(altered, KEY)).toThrow(WRONG);
    }
  });

  it('does not open a truncated or padded envelope', () => {
    const envelope = encryptSecret(UFVK, KEY);
    const [version, nonce, tag, ciphertext] = envelope.split('.');
    expect(() => decryptSecret(envelope.slice(0, -4), KEY)).toThrow();
    expect(() => decryptSecret(`${envelope}AAAA`, KEY)).toThrow();
    expect(() => decryptSecret(`${envelope}.extra`, KEY)).toThrow('malformed secret envelope');
    expect(() => decryptSecret([version, nonce, (tag ?? '').slice(0, 8), ciphertext].join('.'), KEY)).toThrow('malformed secret envelope');
    expect(() => decryptSecret([version, nonce, tag].join('.'), KEY)).toThrow('malformed secret envelope');
    expect(() => decryptSecret(`${envelope}==`, KEY)).toThrow('malformed secret envelope');
    expect(() => decryptSecret('', KEY)).toThrow('malformed secret envelope');
  });

  it('does not open an envelope of a version it does not know', () => {
    const envelope = encryptSecret(UFVK, KEY);
    expect(() => decryptSecret(envelope.replace(/^v1/, 'v2'), KEY)).toThrow('unsupported secret envelope version v2');
  });

  it('binds an envelope to the context it was sealed for', () => {
    const envelope = encryptSecret(UFVK, KEY, 'ufvk:acme');
    expect(decryptSecret(envelope, KEY, 'ufvk:acme')).toBe(UFVK);
    expect(() => decryptSecret(envelope, KEY, 'ufvk:globex')).toThrow(WRONG);
    expect(() => decryptSecret(envelope, KEY)).toThrow(WRONG);
  });

  it('insists on a 32-byte key', () => {
    for (const bad of [new Uint8Array(16), new Uint8Array(31), new Uint8Array(33), new Uint8Array(0)]) {
      expect(() => encryptSecret(UFVK, bad)).toThrow('the master key must be 32 bytes');
      expect(() => decryptSecret('v1.a.b.c', bad)).toThrow('the master key must be 32 bytes');
    }
  });

  it('reads a master key written as hex or base64', () => {
    const key = Uint8Array.from({ length: 32 }, (_, i) => i * 7);
    expect(parseMasterKey(Buffer.from(key).toString('hex'))).toEqual(key);
    expect(parseMasterKey(Buffer.from(key).toString('base64'))).toEqual(key);
    expect(parseMasterKey(`  ${Buffer.from(key).toString('base64url')}\n`)).toEqual(key);
    expect(decryptSecret(encryptSecret(UFVK, key), parseMasterKey(Buffer.from(key).toString('hex')))).toBe(UFVK);
  });

  it('refuses a master key of the wrong length', () => {
    for (const bad of ['', 'abcd', 'a'.repeat(63), Buffer.alloc(16).toString('base64'), Buffer.alloc(48, 0xff).toString('base64')]) {
      expect(() => parseMasterKey(bad)).toThrow('the master key must be 32 bytes');
    }
  });
});
