import type { PgliteConnection } from '@holdfast/db';
import { ASSETS } from '@holdfast/intents';
import { parsePaymentUri } from '@holdfast/zcash';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getSwap, getSwaps, postQuote } from '../src/server/api/funding';
import { SOLANA_USDC } from '../src/server/config';
import { expectOwnerOnly } from './support/access';
import { PX, SOLANA_OWNER } from './support/fakes';
import { STARTUP_TIMEOUT_MS, STRANGER, type World, call, migratedPglite, newAccount, organisation, sessionOf, world } from './support/world';

let connection: PgliteConnection;
let w: World;

beforeAll(async () => {
  connection = await migratedPglite();
}, STARTUP_TIMEOUT_MS);

afterAll(() => connection.close());

beforeEach(() => {
  w = world(connection);
});

async function owned(over: { solanaOwner?: string | null } = {}) {
  const owner = newAccount();
  const org = await organisation(w, owner.address, over);
  return { org, cookie: await sessionOf(w, owner.address), params: { orgId: org.id } };
}

/** A transparent address of the treasurer's own, for refunds. */
const REFUND_TO = 't1VmmGiyjVNeCjxDZzg7vZmd99WyzVby9yC';
const SHIELDED = `u1${'q'.repeat(70)}`;
const QUOTE = { purpose: 'margin', amountZat: '250000000', refundTo: REFUND_TO };

describe('funding margin and floats', () => {
  it('quotes ZEC into margin on the organisation’s own Hyperliquid account and hands back a payment request', async () => {
    const { org, cookie, params } = await owned();
    const { status, body } = await call(w, postQuote, 'POST', { cookie, params, body: QUOTE });
    expect(status).toBe(201);

    const deposit = w.oneClick.lastDeposit ?? '';
    expect(deposit).toMatch(/^t1[1-9A-HJ-NP-Za-km-z]{33}$/);
    const usdIn = 2.5 * PX;
    const out = BigInt(Math.floor(usdIn * 0.995 * 1e6));
    expect(body).toEqual({
      swapId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      purpose: 'margin',
      recipient: org.hlUser,
      originAsset: ASSETS.ZEC,
      destinationAsset: ASSETS.USDC_HYPERCORE,
      amountIn: '250000000',
      amountOut: out.toString(),
      minAmountOut: ((out * 9_900n) / 10_000n).toString(),
      amountInUsd: Number(usdIn.toFixed(4)),
      amountOutUsd: Number((usdIn * 0.995).toFixed(4)),
      costBps: 50,
      etaSeconds: 120,
      deadline: w.clock.ms + 3_600_000,
      depositAddress: deposit,
      paymentUri: `zcash:${deposit}?amount=2.5`,
    });
    expect(parsePaymentUri(body.paymentUri)).toEqual([{ address: deposit, amountZat: 250_000_000n }]);

    expect(w.oneClick.quotes).toHaveLength(1);
    expect(w.oneClick.quotes[0]).toMatchObject({ dry: false, originAsset: ASSETS.ZEC, destinationAsset: ASSETS.USDC_HYPERCORE, amount: '250000000', recipient: org.hlUser, refundTo: REFUND_TO, slippageTolerance: 100 });

    const stored = await w.store.findSwap(org.id, body.swapId);
    expect(stored).toMatchObject({ purpose: 'margin', amountIn: 250_000_000n, minAmountOut: (out * 9_900n) / 10_000n, depositAddress: deposit, recipient: org.hlUser, state: 'PENDING_DEPOSIT', amountOut: null });
    const evidence = await connection.client.query<{ quote: { signature: string } }>('select quote from holdfast.swaps where id = $1', [body.swapId]);
    expect(evidence.rows[0]?.quote.signature).toBe('ed25519:quote-signature');
  });

  it('prices a swap without creating a deposit address or a record when asked for a dry quote', async () => {
    const { org, cookie, params } = await owned();
    const { status, body } = await call(w, postQuote, 'POST', { cookie, params, body: { ...QUOTE, dry: true, slippageBps: 250 } });
    expect(status).toBe(200);
    expect(body).toMatchObject({ swapId: null, depositAddress: null, paymentUri: null, amountIn: '250000000', costBps: 50 });
    expect(w.oneClick.quotes[0]).toMatchObject({ dry: true, slippageTolerance: 250 });
    expect(await w.store.listSwaps(org.id)).toEqual([]);
  });

  it('tops up the payout float only to the organisation’s own Solana wallet, and only where the swap service delivers', async () => {
    const { cookie, params } = await owned();
    const float = { ...QUOTE, purpose: 'payout_float' };
    const onDevnet = await call(w, postQuote, 'POST', { cookie, params, body: float });
    expect(onDevnet.status).toBe(409);
    expect(onDevnet.body.error).toBe('refused');

    w.solana.cluster = 'mainnet-beta';
    w.solana.mint = SOLANA_USDC['mainnet-beta'];
    const { status, body } = await call(w, postQuote, 'POST', { cookie, params, body: float });
    expect(status).toBe(201);
    expect(body).toMatchObject({ purpose: 'payout_float', recipient: SOLANA_OWNER, destinationAsset: ASSETS.USDC_SOLANA });
    expect(w.oneClick.quotes.at(-1)).toMatchObject({ recipient: SOLANA_OWNER, destinationAsset: ASSETS.USDC_SOLANA });

    const unset = await owned({ solanaOwner: null });
    expect((await call(w, postQuote, 'POST', { cookie: unset.cookie, params: unset.params, body: float })).body).toEqual({ error: 'refused', message: 'the organisation has no Solana wallet yet; set one in its profile first' });
    expect(w.oneClick.quotes).toHaveLength(1);
  });

  it('has no way to name another recipient, and refuses what is not a quote request', async () => {
    const { org, cookie, params } = await owned();
    const cases: unknown[] = [
      { ...QUOTE, recipient: STRANGER.address },
      { ...QUOTE, purpose: 'unlock' },
      { ...QUOTE, amountZat: '0' },
      { ...QUOTE, amountZat: 250_000_000 },
      { ...QUOTE, amountZat: '2.5' },
      { ...QUOTE, slippageBps: 501 },
      { ...QUOTE, dry: 'yes' },
      { purpose: 'margin', amountZat: '1' },
    ];
    for (const body of cases) {
      const answer = await call(w, postQuote, 'POST', { cookie, params, body });
      expect(answer.status, JSON.stringify(body)).toBe(400);
      expect(answer.body.error).toBe('invalid_input');
    }
    for (const refundTo of [SHIELDED, 'not-an-address', org.hlUser]) {
      const answer = await call(w, postQuote, 'POST', { cookie, params, body: { ...QUOTE, refundTo } });
      expect(answer.status).toBe(400);
      expect(answer.body.message).toBe('refundTo must be a transparent Zcash address: the swap service returns ZEC to transparent addresses only');
    }
    expect(w.oneClick.quotes).toEqual([]);
    expect(await w.store.listSwaps(org.id)).toEqual([]);
  });

  it('does not swap on testnet', async () => {
    const { cookie, params } = await owned();
    w.deps.network = 'testnet';
    const answer = await call(w, postQuote, 'POST', { cookie, params, body: QUOTE });
    expect(answer.body).toEqual({ error: 'refused', message: 'ZEC is swapped on mainnet only, and this deployment runs on testnet' });
    expect(w.oneClick.quotes).toEqual([]);
  });

  it('records nothing and hands out nothing to pay when the swap service fails or answers with something unusable', async () => {
    const { org, cookie, params } = await owned();
    w.oneClick.down = 'getaddrinfo ENOTFOUND 1click.chaindefuser.com';
    const down = await call(w, postQuote, 'POST', { cookie, params, body: QUOTE });
    expect(down.status).toBe(503);
    expect(down.body).toEqual({ error: 'unavailable', message: '1Click is unavailable: 1Click is unreachable: getaddrinfo ENOTFOUND 1click.chaindefuser.com', source: '1Click' });
    w.oneClick.down = null;

    for (const forced of ['', '0x3c71213434d56CC8ACDe9Fb1c6b3d4920e40E19A', SHIELDED.slice(0, 20)]) {
      w.oneClick.forceDeposit = forced;
      const answer = await call(w, postQuote, 'POST', { cookie, params, body: QUOTE });
      expect(answer.status, forced).toBe(503);
      expect(answer.body.error).toBe('unavailable');
      expect(answer.body.paymentUri).toBeUndefined();
    }
    expect(await w.store.listSwaps(org.id)).toEqual([]);
  });

  it('gives each request its own deposit address: asking twice moves nothing twice, it only offers two addresses', async () => {
    const { org, cookie, params } = await owned();
    const first = (await call(w, postQuote, 'POST', { cookie, params, body: QUOTE })).body;
    const second = (await call(w, postQuote, 'POST', { cookie, params, body: QUOTE })).body;
    expect(first.depositAddress).not.toBe(second.depositAddress);
    expect(first.swapId).not.toBe(second.swapId);
    const { body } = await call(w, getSwaps, 'GET', { cookie, params });
    expect(body.swaps.map((swap: { id: string; state: string; final: boolean }) => [swap.id, swap.state, swap.final]).sort()).toEqual([[first.swapId, 'PENDING_DEPOSIT', false], [second.swapId, 'PENDING_DEPOSIT', false]].sort());
    expect(await w.store.listSwaps(org.id)).toHaveLength(2);
  });

  it('follows a swap by asking the swap service, and stops asking once it has settled', async () => {
    const { org, cookie, params } = await owned();
    const quote = (await call(w, postQuote, 'POST', { cookie, params, body: QUOTE })).body;
    const swapParams = { ...params, swapId: quote.swapId };

    expect((await call(w, getSwap, 'GET', { cookie, params: swapParams })).body).toMatchObject({ id: quote.swapId, state: 'PENDING_DEPOSIT', final: false });

    w.oneClick.swaps.set(quote.depositAddress, { status: 'PROCESSING', swapDetails: { originChainTxHashes: [{ hash: 'zec-tx' }] } });
    w.clock.advance(60_000);
    expect((await call(w, getSwap, 'GET', { cookie, params: swapParams })).body).toMatchObject({ state: 'PROCESSING', originTxs: ['zec-tx'], final: false, updatedAt: w.clock.ms });

    w.oneClick.swaps.set(quote.depositAddress, { status: 'SUCCESS', swapDetails: { amountOut: '3040000000', originChainTxHashes: [{ hash: 'zec-tx' }], destinationChainTxHashes: [{ hash: '0xhl' }] } });
    const done = await call(w, getSwap, 'GET', { cookie, params: swapParams });
    expect(done.body).toMatchObject({ state: 'SUCCESS', final: true, amountOut: '3040000000', destinationTxs: ['0xhl'] });
    expect(await w.store.findSwap(org.id, quote.swapId)).toMatchObject({ state: 'SUCCESS', amountOut: 3_040_000_000n });

    const asked = w.oneClick.statusCalls.length;
    w.oneClick.down = 'fetch failed';
    expect((await call(w, getSwap, 'GET', { cookie, params: swapParams })).body).toEqual(done.body);
    expect(w.oneClick.statusCalls).toHaveLength(asked);
  });

  it('says a swap’s state is unavailable when the swap service cannot be asked, beside what was last recorded', async () => {
    const { org, cookie, params } = await owned();
    const quote = (await call(w, postQuote, 'POST', { cookie, params, body: QUOTE })).body;
    const recordedAt = w.clock.ms;
    w.clock.advance(60_000);
    w.oneClick.down = 'fetch failed';
    const answer = await call(w, getSwap, 'GET', { cookie, params: { ...params, swapId: quote.swapId } });
    expect(answer.status).toBe(503);
    expect(answer.body).toEqual({ error: 'unavailable', message: '1Click is unavailable: 1Click is unreachable: fetch failed', source: '1Click', lastRecorded: { state: 'PENDING_DEPOSIT', updatedAt: recordedAt } });

    w.oneClick.down = null;
    w.oneClick.swaps.set(quote.depositAddress, { status: 'SOMETHING_NEW' });
    expect((await call(w, getSwap, 'GET', { cookie, params: { ...params, swapId: quote.swapId } })).status).toBe(503);
    expect((await w.store.findSwap(org.id, quote.swapId))?.state).toBe('PENDING_DEPOSIT');
  });

  it('knows a swap only under its own organisation', async () => {
    const { cookie, params } = await owned();
    const quote = (await call(w, postQuote, 'POST', { cookie, params, body: QUOTE })).body;
    const other = await owned();
    expect((await call(w, getSwap, 'GET', { cookie: other.cookie, params: { ...other.params, swapId: quote.swapId } })).status).toBe(404);
    expect((await call(w, getSwap, 'GET', { cookie, params: { ...params, swapId: '0d7c2b0e-52a4-4c7b-9f0e-3a1d5b8c6e21' } })).status).toBe(404);
    expect((await call(w, getSwap, 'GET', { cookie, params: { ...params, swapId: 'not-a-swap' } })).status).toBe(404);
    expect((await call(w, getSwaps, 'GET', { cookie: other.cookie, params: other.params })).body.swaps).toEqual([]);
  });

  it('is for the owner alone', async () => {
    const { org, cookie, params } = await owned();
    const quote = (await call(w, postQuote, 'POST', { cookie, params, body: QUOTE })).body;
    const before = w.oneClick.quotes.length;
    await expectOwnerOnly(
      w,
      org.id,
      [
        { name: 'quote', endpoint: postQuote, method: 'POST', body: QUOTE },
        { name: 'swaps', endpoint: getSwaps, method: 'GET' },
        { name: 'swap', endpoint: getSwap, method: 'GET', params: { swapId: quote.swapId } },
      ],
      async () => {
        expect(w.oneClick.quotes).toHaveLength(before);
        expect(await w.store.listSwaps(org.id)).toHaveLength(1);
      },
    );
  });
});
