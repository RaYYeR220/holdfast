import type { PgliteConnection } from '@holdfast/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getRefusals, getSafety, postProbe } from '../src/server/api/safety';
import { expectOwnerOnly } from './support/access';
import { SOLANA_OWNER } from './support/fakes';
import { PAYEES, ROOT, STARTUP_TIMEOUT_MS, STRANGER, type World, call, keyAddress, migratedPglite, newAccount, organisation, sessionOf, world } from './support/world';

let connection: PgliteConnection;
let w: World;

beforeAll(async () => {
  connection = await migratedPglite();
}, STARTUP_TIMEOUT_MS);

afterAll(() => connection.close());

beforeEach(() => {
  w = world(connection);
});

async function owned() {
  const owner = newAccount();
  const org = await organisation(w, owner.address);
  const accessKey = await keyAddress(w, org.id, 'tempo_access');
  return { org, cookie: await sessionOf(w, owner.address), params: { orgId: org.id }, chain: w.tempoChain(accessKey) };
}

const probe = (cookie: string, params: { orgId: string }, kind: string) => call(w, postProbe, 'POST', { cookie, params, body: { kind } });

describe('safety', () => {
  it('shows every key with its scope read now, and the refusals on record', async () => {
    const { org, cookie, params } = await owned();
    await w.store.recordRefusal(org.id, { chain: 'solana', kind: 'over_allowance', attempted: 'a transfer above the allowance', outcome: 'insufficient delegated amount', tx: '5sig', evidence: { failedOnChain: true } });
    const { status, body } = await call(w, getSafety, 'GET', { cookie, params });
    expect(status).toBe(200);
    expect(body.keys.map((key: { kind: string; scope: { status: string } }) => [key.kind, key.scope.status])).toEqual([
      ['zcash_viewing_key', 'ok'],
      ['hl_agent', 'unavailable'],
      ['tempo_access', 'ok'],
      ['solana_delegate', 'ok'],
      ['hl_attester', 'ok'],
    ]);
    expect(body.keys[2]).toMatchObject({ address: await keyAddress(w, org.id, 'tempo_access'), scope: { readAt: w.clock.ms, value: { authorized: true, remaining: '10000000', scope: { recipients: [...PAYEES] } } } });
    // The attester key is listed with what the contract says of it now: the owner has not named it yet.
    expect(body.keys[4]).toMatchObject({ address: await keyAddress(w, org.id, 'hl_attester'), chain: 'hyperliquid', scope: { source: 'hyperevm', readAt: w.clock.ms, value: { registered: false } } });
    expect(body.refusals).toEqual([
      { id: expect.any(String), chain: 'solana', kind: 'over_allowance', attempted: 'a transfer above the allowance', outcome: 'insufficient delegated amount', tx: '5sig', evidence: { failedOnChain: true }, createdAt: w.clock.ms, txUrl: 'https://explorer.solana.com/tx/5sig?cluster=devnet' },
    ]);
    expect((await call(w, getRefusals, 'GET', { cookie, params })).body).toEqual({ refusals: body.refusals });
  });
});

describe('refusal probes', () => {
  it('have the agent key ask Hyperliquid for a withdrawal and a transfer, and keep both refusals', async () => {
    const { org, cookie, params } = await owned();
    w.exchange.answer = (body) => ({ status: 'err', response: body.action.type === 'withdraw3' ? 'Must deposit before performing actions. User: 0xagent' : 'Insufficient balance for withdrawal' });
    const { status, body } = await probe(cookie, params, 'hyperliquid_withdrawal');
    expect(status).toBe(200);
    expect(body).toMatchObject({ kind: 'hyperliquid_withdrawal', refused: true, error: null });
    expect(body.refusals.map((r: { chain: string; kind: string; outcome: string; tx: null; txUrl: null }) => [r.chain, r.kind, r.outcome, r.tx, r.txUrl])).toEqual([
      ['hyperliquid', 'withdraw3', 'Must deposit before performing actions. User: 0xagent', null, null],
      ['hyperliquid', 'usdSend', 'Insufficient balance for withdrawal', null, null],
    ]);
    expect(body.refusals[0].attempted).toBe(`a withdrawal to the organisation's own account, signed by the agent key ${await keyAddress(w, org.id, 'hl_agent')}`);

    // Both actions name the organisation's own account and nothing else.
    expect(w.exchange.calls.map((sent) => [sent.action.type, sent.action.destination, sent.action.amount])).toEqual([['withdraw3', org.hlUser, '5'], ['usdSend', org.hlUser, '5']]);
    expect(await w.store.listRefusals(org.id)).toHaveLength(2);
    expect(body.refusals[0].evidence.attempted).toMatchObject({ type: 'withdraw3', destination: org.hlUser });
  });

  it('record nothing when Hyperliquid cannot be reached, and nothing as a refusal when it did not refuse', async () => {
    const { org, cookie, params } = await owned();
    w.exchange.answer = () => {
      throw new Error('fetch failed');
    };
    const down = await probe(cookie, params, 'hyperliquid_withdrawal');
    expect(down.status).toBe(503);
    expect(down.body).toMatchObject({ error: 'unavailable', source: 'Hyperliquid' });

    w.exchange.answer = () => ({ status: 'ok', response: { type: 'default' } });
    const accepted = await probe(cookie, params, 'hyperliquid_withdrawal');
    expect(accepted.status).toBe(200);
    expect(accepted.body).toEqual({ kind: 'hyperliquid_withdrawal', refused: false, error: 'withdraw3: Hyperliquid accepted a withdraw3 signed by the agent key; usdSend: Hyperliquid accepted a usdSend signed by the agent key', refusals: [] });
    expect(await w.store.listRefusals(org.id)).toEqual([]);
  });

  it('land a transfer no limit can cover on Tempo and keep the chain’s refusal with its transaction', async () => {
    const { org, cookie, params, chain } = await owned();
    const { status, body } = await probe(cookie, params, 'tempo_over_limit');
    expect(status).toBe(200);
    expect(body).toMatchObject({ kind: 'tempo_over_limit', refused: true, error: null });
    expect(body.refusals).toEqual([
      {
        id: expect.any(String),
        chain: 'tempo',
        kind: 'over_limit',
        attempted: `transferWithMemo of the largest amount there is, to ${PAYEES[0]}`,
        outcome: 'SpendingLimitExceeded',
        tx: expect.stringMatching(/^0x[0-9a-f]{64}$/),
        txUrl: expect.stringContaining('https://explore.testnet.tempo.xyz/tx/0x'),
        evidence: { reverted: true, reason: 'SpendingLimitExceeded', returnData: '0x8a9e71ea', gasUsed: expect.any(String) },
        createdAt: w.clock.ms,
      },
    ]);
    expect(chain.rootBalance).toBe(1_000_000_000n);
    expect(chain.key.remaining).toBe(10_000_000n);
    expect(await w.store.listRefusals(org.id)).toHaveLength(1);
  });

  it('land a call outside the key’s scope on Tempo, aimed at the organisation’s own account', async () => {
    const { cookie, params, chain } = await owned();
    const { body } = await probe(cookie, params, 'tempo_out_of_scope');
    expect(body).toMatchObject({ refused: true, refusals: [{ chain: 'tempo', kind: 'out_of_scope', outcome: 'CallNotAllowed', attempted: expect.stringContaining("to the organisation's own account") }] });
    expect(chain.signed.at(-1)?.root).toBe(ROOT);
    expect(chain.rootBalance).toBe(1_000_000_000n);
  });

  it('prove nothing on Tempo without a bounded key or without the chain, and say so', async () => {
    const { org, cookie, params, chain } = await owned();
    chain.forget();
    const unauthorized = await probe(cookie, params, 'tempo_out_of_scope');
    expect(unauthorized.status).toBe(503);
    expect(unauthorized.body.message).toContain('is not authorized on this account');

    chain.failing.add('keyState');
    expect((await probe(cookie, params, 'tempo_over_limit')).body).toEqual({ error: 'unavailable', message: 'Tempo is unavailable: keyState failed: fetch failed', source: 'Tempo' });
    expect(chain.broadcasts).toEqual([]);
    expect(await w.store.listRefusals(org.id)).toEqual([]);
  });

  it('send one base unit more than the allowance on Solana, to the organisation’s own wallet, and keep the refusal', async () => {
    const { org, cookie, params } = await owned();
    const { body } = await probe(cookie, params, 'solana_over_allowance');
    expect(body).toMatchObject({
      kind: 'solana_over_allowance',
      refused: true,
      refusals: [{ chain: 'solana', kind: 'over_allowance', outcome: 'the Token program refused the transfer: insufficient delegated amount', tx: expect.stringMatching(/^5sig/), txUrl: expect.stringContaining('?cluster=devnet') }],
    });
    expect(w.solana.probes).toEqual([{ account: SOLANA_OWNER, to: SOLANA_OWNER }]);
    expect(w.solana.allowance).toBe(50_000_000n);

    w.solana.down = 'fetch failed';
    const down = await probe(cookie, params, 'solana_over_allowance');
    expect(down.status).toBe(503);
    expect(await w.store.listRefusals(org.id)).toHaveLength(1);
  });

  it('take a kind of probe and nothing else: no destination can be named', async () => {
    const { org, cookie, params, chain } = await owned();
    for (const body of [{}, { kind: 'drain_everything' }, { kind: 'tempo_over_limit', to: STRANGER.address }, { kind: 'solana_over_allowance', account: SOLANA_OWNER }]) {
      expect((await call(w, postProbe, 'POST', { cookie, params, body })).status).toBe(400);
    }
    expect(chain.broadcasts).toEqual([]);
    expect(w.solana.probes).toEqual([]);
    expect(w.exchange.calls).toEqual([]);
    expect(await w.store.listRefusals(org.id)).toEqual([]);
  });

  it('are for the owner alone', async () => {
    const { org, chain } = await owned();
    await expectOwnerOnly(
      w,
      org.id,
      [
        { name: 'safety', endpoint: getSafety, method: 'GET' },
        { name: 'refusals', endpoint: getRefusals, method: 'GET' },
        { name: 'probe', endpoint: postProbe, method: 'POST', body: { kind: 'tempo_over_limit' } },
      ],
      async () => {
        expect(chain.broadcasts).toEqual([]);
        expect(w.exchange.calls).toEqual([]);
        expect(await w.store.listRefusals(org.id)).toEqual([]);
      },
    );
  });
});
