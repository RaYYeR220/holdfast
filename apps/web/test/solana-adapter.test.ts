import { describe, expect, it } from 'vitest';
import { delegateSecretBytes, solanaPort } from '../src/server/adapters/solana';
import { looksLikeSolanaAddress } from '../src/server/config';
import { SOLANA_OWNER } from './support/fakes';

/**
 * The adapter over the Solana package itself, as far as it goes without a
 * node: making and loading service keys, and the one read the adapter makes
 * of its own. Paying and looking runs up is the package's business and is
 * tested there.
 */
const SETTINGS = { cluster: 'devnet' as const, rpcUrl: 'https://rpc.example.test/solana', mint: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU', decimals: 6, tokenSymbol: 'USDC', markersFrom: 412_000_000n };

function rpc(answer: unknown, status = 200) {
  const calls: { url: string; body: { method: string; params: unknown[] } }[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify(answer), { status, headers: { 'content-type': 'application/json' } });
  };
  return { fetch, calls };
}

describe('the Solana adapter', () => {
  it('makes a service key whose address the rail derives again from the stored secret', async () => {
    const port = solanaPort(SETTINGS);
    const key = await port.newDelegateKey();
    expect(key.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(looksLikeSolanaAddress(key.address)).toBe(true);
    expect(await port.rail(key.secret).delegate()).toBe(key.address);
    expect(await port.rail(key.secret, [SOLANA_OWNER]).delegate()).toBe(key.address);
    expect((await port.newDelegateKey()).address).not.toBe(key.address);
  });

  it('reads a stored key as the seed or as the key file it is the hex of, and nothing else', () => {
    expect(delegateSecretBytes('ab'.repeat(32))).toHaveLength(32);
    expect(delegateSecretBytes('ab'.repeat(64))).toHaveLength(64);
    for (const secret of ['', 'ab'.repeat(31), 'zz'.repeat(32), `0x${'ab'.repeat(32)}`]) expect(() => delegateSecretBytes(secret)).toThrow('64 or 128 hex characters');
  });

  it('describes the rail it was configured for', () => {
    const port = solanaPort(SETTINGS);
    expect(port).toMatchObject({ cluster: 'devnet', mint: SETTINGS.mint, decimals: 6, tokenSymbol: 'USDC' });
    expect(port.txUrl('5sig')).toBe('https://explorer.solana.com/tx/5sig?cluster=devnet');
    expect(solanaPort({ ...SETTINGS, cluster: 'mainnet-beta' }).txUrl('5sig')).toBe('https://explorer.solana.com/tx/5sig');
  });

  it('asks the node how one transaction was recorded', async () => {
    const failed = rpc({ jsonrpc: '2.0', id: 1, result: { meta: { err: { InstructionError: [1, { Custom: 1 }] } } } });
    expect(await solanaPort(SETTINGS, failed).recorded('5sig')).toEqual({ failed: true, error: '{"InstructionError":[1,{"Custom":1}]}' });
    expect(failed.calls).toEqual([{ url: SETTINGS.rpcUrl, body: { jsonrpc: '2.0', id: 1, method: 'getTransaction', params: ['5sig', { commitment: 'finalized', encoding: 'json', maxSupportedTransactionVersion: 0 }] } }]);

    expect(await solanaPort(SETTINGS, rpc({ result: { meta: { err: null } } })).recorded('5sig')).toEqual({ failed: false, error: null });
    expect(await solanaPort(SETTINGS, rpc({ result: null })).recorded('5sig')).toBeNull();
  });

  it('does not take an answer it cannot use for an answer', async () => {
    await expect(solanaPort(SETTINGS, rpc({}, 429)).recorded('5sig')).rejects.toThrow('the Solana node answered HTTP 429');
    await expect(solanaPort(SETTINGS, rpc({ error: { code: -32602, message: 'Invalid param' } })).recorded('5sig')).rejects.toThrow('the Solana node refused the request: Invalid param');
    await expect(solanaPort(SETTINGS, rpc({ result: { meta: null } })).recorded('5sig')).rejects.toThrow('without its outcome');
  });
});
