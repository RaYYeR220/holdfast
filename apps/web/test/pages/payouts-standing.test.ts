import { describe, expect, it, vi } from 'vitest';
import { solanaForRuns, tempoForRuns } from '../../src/app/_sections/payouts/standing';
import { watched } from '../../src/app/_sections/payouts/watch';
import type { SolanaRailShown, TempoRailShown } from '../../src/server/pages/payouts';

const LINKS = { before: 'https://explore.tempo.xyz/address/', after: '' };
const PAYEES = ['0x3c71213434d56CC8ACDe9Fb1c6b3d4920e40E19A', '0xF3009617E5A04f001Fc6839Def7A7f8A7ab4545b'];

const tempo = (over: Partial<TempoRailShown>): { status: 'ok'; value: TempoRailShown } => ({
  status: 'ok',
  value: {
    network: 'mainnet',
    chainId: 4217,
    token: { address: '0x20C000000000000000000000b9537d11c60E8b50', symbol: 'USDC.e', decimals: 6 },
    account: '0x43E69cd36fbf1Bbe73E03Dd5d06c8ff9f81Be4c8',
    accessKey: '0x4527180245A3a804CeD5F7f5Dffd6B516a1366cd',
    sponsor: null,
    key: { state: 'authorized', remaining: 1_250_000n, periodEnd: 1_794_259_242_000, expiresAt: 1_794_259_204_000, recipients: PAYEES, readAt: 1 },
    links: LINKS,
    ...over,
  },
});

const solana = (over: Partial<SolanaRailShown>): { status: 'ok'; value: SolanaRailShown } => ({
  status: 'ok',
  value: {
    cluster: 'mainnet-beta',
    token: { address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', symbol: 'USDC', decimals: 6 },
    owner: 'B1zTmCPofZo7TZET5k7jL43FzVG5TFcbQPijYi7mFV97',
    tokenAccount: 'A8VB3LCer26TftTWTnjqgnzrHYFGk72tHvN78yCNfgEw',
    delegate: 'HBy3fT36LiCgfBuf1mymsxRwv2DDKQd5MB8z8DJghnu3',
    allowance: { state: 'approved', remaining: 750_000n, readAt: 1 },
    delegateLamports: null,
    links: LINKS,
    ...over,
  },
});

describe('the Tempo rail as the form of a new run needs it', () => {
  it('gives what the key has left and whom it may pay when the key is authorized', () => {
    expect(tempoForRuns(tempo({}))).toEqual({
      token: { symbol: 'USDC.e', decimals: 6 },
      blocked: null,
      standing: 'The access key has 1.25 USDC.e left in this period and may pay the 2 addresses it lists.',
      remaining: '1250000',
      recipients: PAYEES,
    });
    const once = tempoForRuns(tempo({ key: { state: 'authorized', remaining: 2_000_000n, periodEnd: null, expiresAt: null, recipients: null, readAt: 1 } }));
    expect(once.standing).toBe('The access key has 2.00 USDC.e left and may pay any address.');
    expect(once.recipients).toBeNull();
    const one = tempoForRuns(tempo({ key: { state: 'authorized', remaining: 2_000_000n, periodEnd: null, expiresAt: null, recipients: [PAYEES[0] ?? ''], readAt: 1 } }));
    expect(one.standing).toContain('may pay the one address it lists');
  });

  it('lets a run be drafted while the key may pay nothing, and holds the draft to no bounds it cannot know', () => {
    const keys: TempoRailShown['key'][] = [{ state: 'not_authorized', readAt: 1 }, { state: 'revoked', readAt: 1 }, { state: 'expired', expiredAt: 1, readAt: 1 }, { state: 'broader', problems: ['it has no spending limit'], expiresAt: null, readAt: 1 }];
    for (const key of keys) {
      const rail = tempoForRuns(tempo({ key }));
      expect(rail.blocked, key.state).toBeNull();
      expect(rail.remaining, key.state).toBeNull();
      expect(rail.recipients, key.state).toBeNull();
      expect(rail.standing, key.state).toContain('A run can be drafted now and paid once');
    }
    const unread = tempoForRuns(tempo({ key: { state: 'unavailable', source: 'tempo', reason: 'keyState failed: fetch failed', readAt: 1 } }));
    expect(unread.blocked).toBeNull();
    expect(unread.standing).toContain('keyState failed: fetch failed');
  });

  it('takes no draft without an account to pay from, without a key, or when the rail could not be read', () => {
    expect(tempoForRuns(tempo({ account: null, key: { state: 'no_account' } })).blocked).toContain('no Tempo account yet');
    expect(tempoForRuns(tempo({ accessKey: null })).blocked).toBe('The organisation has no Tempo access key.');
    expect(tempoForRuns({ status: 'unavailable', reason: 'no answer within 15 s' })).toMatchObject({ blocked: 'The Tempo rail could not be read: no answer within 15 s.', remaining: null });
  });
});

describe('the Solana rail as the form of a new run needs it', () => {
  it('gives the allowance that is left', () => {
    expect(solanaForRuns(solana({}))).toEqual({ token: { symbol: 'USDC', decimals: 6 }, blocked: null, standing: 'The delegate has 0.75 USDC of allowance left.', remaining: '750000', recipients: null });
  });

  it('lets a run be drafted while the delegate may move nothing, and says the chain would refuse it', () => {
    const none = solanaForRuns(solana({ allowance: { state: 'nothing', readAt: 1 } }));
    expect(none).toMatchObject({ blocked: null, remaining: null });
    expect(none.standing).toContain('the chain would refuse any run');
    const unread = solanaForRuns(solana({ allowance: { state: 'unavailable', source: 'solana', reason: 'the node is down', readAt: 1 } }));
    expect(unread.blocked).toBeNull();
    expect(unread.standing).toContain('the node is down');
  });

  it('takes no draft without a wallet to pay from, without a service key, or when the rail could not be read', () => {
    expect(solanaForRuns(solana({ owner: null, tokenAccount: null, allowance: { state: 'no_wallet' } })).blocked).toContain('no Solana wallet yet');
    expect(solanaForRuns(solana({ delegate: null })).blocked).toBe('The organisation has no Solana service key.');
    expect(solanaForRuns({ status: 'unavailable', reason: 'solana could not be read' }).blocked).toBe('The Solana rail could not be read: solana could not be read.');
  });
});

describe('a signer with one of its methods watched', () => {
  it('says when the flow reaches the signature and when it has signed, and signs as the original does', async () => {
    const steps: string[] = [];
    const secret = 'kept in a closure';
    const signer = {
      address: '0xabc',
      sign: async (parameters: { hash: string }) => {
        steps.push('signing');
        return `${parameters.hash} signed with what is ${secret}`;
      },
    };
    const copy = watched(signer, 'sign', () => steps.push('prompt opens'), () => steps.push('signed'));
    expect(copy.address).toBe('0xabc');
    expect(await copy.sign({ hash: '0x01' })).toBe('0x01 signed with what is kept in a closure');
    expect(steps).toEqual(['prompt opens', 'signing', 'signed']);
  });

  it('passes a refusal on untouched and does not say the signer signed', async () => {
    const onReturn = vi.fn();
    const refusal = Object.assign(new Error('User rejected the request.'), { code: 4001 });
    const copy = watched({ signAndSend: async (): Promise<string> => Promise.reject(refusal) }, 'signAndSend', () => undefined, onReturn);
    await expect(copy.signAndSend()).rejects.toBe(refusal);
    expect(onReturn).not.toHaveBeenCalled();
  });

  it('refuses to watch what is not a method', () => {
    expect(() => watched({ address: '0xabc' }, 'address', () => undefined, () => undefined)).toThrow('address is not something the signer can be asked to do');
  });
});
