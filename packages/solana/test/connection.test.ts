import { createKeyPairSignerFromPrivateKeyBytes, getAddressEncoder, getBase58Decoder } from '@solana/kit';
import { describe, expect, it } from 'vitest';
import { loadKeyPairSigner } from '../src/connection';

describe('loadKeyPairSigner', () => {
  const seed = new Uint8Array(32).fill(7);

  async function keypairBytes(): Promise<Uint8Array> {
    const { address } = await createKeyPairSignerFromPrivateKeyBytes(seed);
    return new Uint8Array([...seed, ...getAddressEncoder().encode(address)]);
  }

  it('loads the same key from a seed, a CLI keypair, or either in base58', async () => {
    const expected = (await createKeyPairSignerFromPrivateKeyBytes(seed)).address;
    const keypair = await keypairBytes();
    expect((await loadKeyPairSigner(seed)).address).toBe(expected);
    expect((await loadKeyPairSigner(keypair)).address).toBe(expected);
    expect((await loadKeyPairSigner(getBase58Decoder().decode(seed))).address).toBe(expected);
    expect((await loadKeyPairSigner(getBase58Decoder().decode(keypair))).address).toBe(expected);
  });

  it('refuses a key of the wrong length, naming only the length', async () => {
    await expect(loadKeyPairSigner(new Uint8Array(31).fill(9))).rejects.toThrow(
      'secret key must be 64 bytes (seed and public key) or a 32-byte seed, got 31 bytes',
    );
  });

  it('refuses a keypair whose public half does not belong to the seed', async () => {
    const mismatched = new Uint8Array([...seed, ...new Uint8Array(32).fill(1)]);
    await expect(loadKeyPairSigner(mismatched)).rejects.toThrow();
  });
});
