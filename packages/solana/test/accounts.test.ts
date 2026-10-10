import { describe, expect, it } from 'vitest';
import { associatedTokenAddress } from '../src/accounts';

describe('associatedTokenAddress', () => {
  // The Associated Token program created an account at exactly this address
  // for this wallet and mint, which it only does when the derivation matches.
  const wallet = '7dc8YmhWWxrTMdHmiuHcgRhymTSK5wnsP9FHwdfL35Jg';
  const mint = 'JBYjDHtQtHbBoP64iCexjGYczuca8ad5UFYeoc2b4oug';

  it('derives the token account the Associated Token program accepts', async () => {
    expect(await associatedTokenAddress(wallet, mint)).toBe('3GNMYKWYHFNb4cjkbsA23oB4WuQ8krWNawVnByxHLVjC');
  });

  it('depends on both the wallet and the mint', async () => {
    const other = '24b2RA36teGzrUr6U4HoVA9c7xRa6Ld8SVMLz2DcesDx';
    expect(await associatedTokenAddress(wallet, other)).toBe('9hsxzyjD6qAB3nJjaBQRd21a5oH5146eMtvEJgvv63Wn');
    expect(await associatedTokenAddress(other, mint)).not.toBe(await associatedTokenAddress(wallet, mint));
  });

  it('rejects strings that are not addresses', async () => {
    await expect(associatedTokenAddress('not-an-address', mint)).rejects.toThrow();
    await expect(associatedTokenAddress(wallet, '')).rejects.toThrow();
  });
});
