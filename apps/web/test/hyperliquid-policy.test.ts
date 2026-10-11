import { DEFAULT_POLICY, SCENARIO_DEFAULTS, planLock } from '@holdfast/core';
import type { PgliteConnection } from '@holdfast/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getApproval, getVenueState, postApproval } from '../src/server/api/hyperliquid';
import { getAdvisories, getLockPreview, getPolicy, putLock, putPolicy } from '../src/server/api/policy';
import { expectOwnerOnly } from './support/access';
import { PX } from './support/fakes';
import { BIRTHDAY, STARTUP_TIMEOUT_MS, STRANGER, type World, call, keyAddress, migratedPglite, newAccount, note, organisation, sessionOf, tickOnce, world } from './support/world';

let connection: PgliteConnection;
let w: World;

beforeAll(async () => {
  connection = await migratedPglite();
}, STARTUP_TIMEOUT_MS);

afterAll(() => connection.close());

beforeEach(() => {
  w = world(connection);
});

/** An organisation, the account that owns it, and that account's session. */
async function owned() {
  const owner = newAccount();
  const org = await organisation(w, owner.address);
  return { owner, org, cookie: await sessionOf(w, owner.address), params: { orgId: org.id } };
}

describe('setting up Hyperliquid', () => {
  it('hands the owner the typed data that approves the agent of the organisation, and nothing else', async () => {
    const { org, cookie, params } = await owned();
    const { status, body } = await call(w, getApproval, 'GET', { cookie, params });
    expect(status).toBe(200);
    const agent = await keyAddress(w, org.id, 'hl_agent');
    expect(body).toMatchObject({ agentAddress: agent, agentName: 'holdfast', nonce: w.clock.ms, signatureChainId: null, validUntil: null });
    expect(body.typedData).toEqual({
      domain: { name: 'HyperliquidSignTransaction', version: '1', chainId: 42_161, verifyingContract: '0x0000000000000000000000000000000000000000' },
      types: {
        'HyperliquidTransaction:ApproveAgent': [
          { name: 'hyperliquidChain', type: 'string' },
          { name: 'agentAddress', type: 'address' },
          { name: 'agentName', type: 'string' },
          { name: 'nonce', type: 'uint64' },
        ],
      },
      primaryType: 'HyperliquidTransaction:ApproveAgent',
      message: { hyperliquidChain: 'Mainnet', agentAddress: agent, agentName: 'holdfast', nonce: w.clock.ms },
    });
    expect(w.exchange.calls).toEqual([]);
  });

  it('submits the owner’s signature and reports the approval', async () => {
    const { owner, org, cookie, params } = await owned();
    const request = (await call(w, getApproval, 'GET', { cookie, params, query: { chainId: '1', validUntil: String(w.clock.ms + 86_400_000) } })).body;
    const signature = await owner.signTypedData(request.typedData);
    const answer = await call(w, postApproval, 'POST', { cookie, params, body: { nonce: request.nonce, signature, signatureChainId: 1, validUntil: request.validUntil } });

    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({ approved: true, agentAddress: await keyAddress(w, org.id, 'hl_agent') });
    expect(w.exchange.calls).toHaveLength(1);
    expect(w.exchange.calls[0]).toMatchObject({
      nonce: request.nonce,
      action: { type: 'approveAgent', hyperliquidChain: 'Mainnet', signatureChainId: '0x1', agentAddress: request.agentAddress, agentName: `holdfast valid_until ${request.validUntil}` },
    });
  });

  it('sends nothing when the signature is not the owner’s, or is over other terms', async () => {
    const { owner, cookie, params } = await owned();
    const request = (await call(w, getApproval, 'GET', { cookie, params })).body;

    const byStranger = await STRANGER.signTypedData(request.typedData);
    const wrongSigner = await call(w, postApproval, 'POST', { cookie, params, body: { nonce: request.nonce, signature: byStranger } });
    expect(wrongSigner.status).toBe(400);
    expect(wrongSigner.body.message).toMatch(/^the approval was not sent: signed by 0x[0-9a-f]{40}, expected 0x[0-9a-f]{40}$/);

    const signature = await owner.signTypedData(request.typedData);
    const otherNonce = await call(w, postApproval, 'POST', { cookie, params, body: { nonce: request.nonce + 1, signature } });
    expect(otherNonce.status).toBe(400);
    const otherAgent = await owner.signTypedData({ ...request.typedData, message: { ...request.typedData.message, agentAddress: STRANGER.address.toLowerCase() } });
    expect((await call(w, postApproval, 'POST', { cookie, params, body: { nonce: request.nonce, signature: otherAgent } })).status).toBe(400);
    expect(w.exchange.calls).toEqual([]);
  });

  it('says so when Hyperliquid turns the approval down, and when it cannot be reached', async () => {
    const { owner, cookie, params } = await owned();
    const request = (await call(w, getApproval, 'GET', { cookie, params })).body;
    const body = { nonce: request.nonce, signature: await owner.signTypedData(request.typedData) };

    w.exchange.answer = () => ({ status: 'err', response: 'Extra agent already used.' });
    const refusal = await call(w, postApproval, 'POST', { cookie, params, body });
    expect(refusal.status).toBe(409);
    expect(refusal.body).toEqual({ error: 'refused', message: 'Hyperliquid refused the approval: Extra agent already used.' });

    w.exchange.answer = () => {
      throw new Error('fetch failed');
    };
    const down = await call(w, postApproval, 'POST', { cookie, params, body });
    expect(down.status).toBe(503);
    expect(down.body).toMatchObject({ error: 'unavailable', source: 'Hyperliquid' });
  });

  it('refuses a request that is not an approval', async () => {
    const { cookie, params } = await owned();
    for (const body of [{}, { nonce: w.clock.ms }, { nonce: w.clock.ms, signature: '0x1234' }, { nonce: -1, signature: `0x${'ab'.repeat(65)}` }, { nonce: w.clock.ms, signature: `0x${'ab'.repeat(65)}`, agentAddress: STRANGER.address }]) {
      expect((await call(w, postApproval, 'POST', { cookie, params, body })).status).toBe(400);
    }
    expect((await call(w, getApproval, 'GET', { cookie, params, query: { chainId: 'arbitrum' } })).status).toBe(400);
    expect((await call(w, getApproval, 'GET', { cookie, params, query: { validUntil: '1' } })).body).toMatchObject({ error: 'invalid_input', message: 'validUntil must be a millisecond timestamp after the nonce' });
    expect(w.exchange.calls).toEqual([]);
  });

  it('reports the account on the venue as it stands now, or that it cannot', async () => {
    const { org, cookie, params } = await owned();
    w.venue.shortLots = 40;
    w.venue.equity = 400;
    const { status, body } = await call(w, getVenueState, 'GET', { cookie, params });
    expect(status).toBe(200);
    expect(body).toEqual({
      readAt: w.clock.ms,
      account: org.hlUser,
      agentAddress: await keyAddress(w, org.id, 'hl_agent'),
      marginRatioBps: Math.round((400 / ((40 * PX) / 100)) * 10_000),
      state: { asOf: w.clock.ms, markPx: PX, oraclePx: PX, shortLots: 40, accountValueUsd: 400, coin: 'ZEC', mode: 'unified', abstraction: 'unifiedAccount', fundingAprBps: 1_190 },
    });

    w.venue.down = 'info clearinghouseState: HTTP 502';
    const down = await call(w, getVenueState, 'GET', { cookie, params });
    expect(down.status).toBe(503);
    expect(down.body).toEqual({ error: 'unavailable', message: 'Hyperliquid is unavailable: info clearinghouseState: HTTP 502', source: 'Hyperliquid' });
  });

  it('is for the owner alone', async () => {
    const { org } = await owned();
    await expectOwnerOnly(
      w,
      org.id,
      [
        { name: 'approval request', endpoint: getApproval, method: 'GET' },
        { name: 'approval', endpoint: postApproval, method: 'POST', body: { nonce: w.clock.ms, signature: `0x${'ab'.repeat(65)}` } },
        { name: 'venue state', endpoint: getVenueState, method: 'GET' },
      ],
      async () => expect(w.exchange.calls).toEqual([]),
    );
  });
});

describe('policy and lock', () => {
  it('reads the policy and replaces it with one that passes validation', async () => {
    const { org, cookie, params } = await owned();
    expect((await call(w, getPolicy, 'GET', { cookie, params })).body).toEqual({ policy: DEFAULT_POLICY, lockEnabled: false });

    const policy = { ...DEFAULT_POLICY, hedgeRatioBps: 8_000, bandLots: 5 };
    const answer = await call(w, putPolicy, 'PUT', { cookie, params, body: policy });
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({ policy, lockEnabled: false });
    expect((await w.store.findOrg(org.id))?.policy).toEqual(policy);
  });

  it('refuses a policy that does not validate, with every reason, and keeps the one it has', async () => {
    const { org, cookie, params } = await owned();
    const cases: [unknown, string[]][] = [
      [{ ...DEFAULT_POLICY, deRiskRestoreBps: 1_000 }, ['deRiskRestoreBps must be above deRiskTriggerBps']],
      [{ ...DEFAULT_POLICY, maxLeverage: 50, turbo: true }, ['unknown field turbo']],
      [{ hedgeRatioBps: 10_000 }, expect.arrayContaining(['missing field bandLots', 'missing field maxLeverage']) as unknown as string[]],
      [{ ...DEFAULT_POLICY, hedgeRatioBps: '10000' }, ['hedgeRatioBps must be an integer in [0, 10000]']],
    ];
    for (const [body, problems] of cases) {
      const answer = await call(w, putPolicy, 'PUT', { cookie, params, body });
      expect(answer.status).toBe(400);
      expect(answer.body).toMatchObject({ error: 'invalid_input', message: 'the policy is not valid' });
      expect(answer.body.problems).toEqual(problems);
    }
    expect((await call(w, putPolicy, 'PUT', { cookie, params, rawBody: '[1,2,3]' })).status).toBe(400);
    expect((await w.store.findOrg(org.id))?.policy).toEqual(DEFAULT_POLICY);
  });

  it('switches the lock on and off, and takes nothing but a yes or a no', async () => {
    const { org, cookie, params } = await owned();
    expect((await call(w, putLock, 'PUT', { cookie, params, body: { enabled: true } })).body).toEqual({ policy: DEFAULT_POLICY, lockEnabled: true });
    expect((await w.store.findOrg(org.id))?.lockEnabled).toBe(true);
    for (const body of [{}, { enabled: 'yes' }, { enabled: true, hedgeRatioBps: 0 }]) expect((await call(w, putLock, 'PUT', { cookie, params, body })).status).toBe(400);
    expect((await w.store.findOrg(org.id))?.lockEnabled).toBe(true);
    expect((await call(w, putLock, 'PUT', { cookie, params, body: { enabled: false } })).body.lockEnabled).toBe(false);
    expect(w.venue.orders).toEqual([]);
  });

  it('previews a lock from the treasury as last scanned and the price as it is now', async () => {
    const { org, cookie, params } = await owned();
    w.chain.notes = [note(BIRTHDAY + 10, 10_000_000_000n)];
    await tickOnce(w, org.id);
    const treasuryReadAt = w.clock.ms;
    w.clock.advance(20_000);
    w.venue.markPx = 1_250;

    const { status, body } = await call(w, getLockPreview, 'GET', { cookie, params });
    expect(status).toBe(200);
    const expected = planLock({ treasuryZat: 10_000_000_000n, hedgeRatioBps: 10_000, marginRatioBps: 8_000, px: 1_250, swapCostBps: 50, maintenanceBps: 500, firstRungBps: 2_000 });
    expect(body.inputs).toEqual({ treasury: { zat: '10000000000', zec: '100', readAt: treasuryReadAt }, price: { px: 1_250, readAt: w.clock.ms }, hedgeRatioBps: 10_000, marginRatioBps: 8_000, firstRungBps: 2_000 });
    expect(body.assumed).toEqual({ swapCostBps: SCENARIO_DEFAULTS.swapCostBps, maintenanceBps: SCENARIO_DEFAULTS.maintenanceBps });
    expect(body.plan).toEqual({ ...expected, sellZat: expected.sellZat.toString(), sellZec: expect.stringMatching(/^44\.\d+$/) });
    expect(body.plan.hedgeLots).toBeGreaterThan(5_000);

    const dearer = await call(w, getLockPreview, 'GET', { cookie, params, query: { swapCostBps: '200' } });
    expect(BigInt(dearer.body.plan.sellZat)).toBeGreaterThan(expected.sellZat);
    expect(w.venue.orders).toHaveLength(0);
  });

  it('gives no preview on a treasury reading that is missing or old, or without the venue', async () => {
    const { org, cookie, params } = await owned();
    const never = await call(w, getLockPreview, 'GET', { cookie, params });
    expect(never.status).toBe(503);
    expect(never.body).toEqual({ error: 'unavailable', message: 'the treasury balance is unavailable: no tick has run for this organisation yet', source: 'the treasury balance' });

    w.chain.notes = [note(BIRTHDAY + 10, 10_000_000_000n)];
    await tickOnce(w, org.id);
    w.venue.down = 'fetch failed';
    expect((await call(w, getLockPreview, 'GET', { cookie, params })).body).toEqual({ error: 'unavailable', message: 'Hyperliquid is unavailable: fetch failed', source: 'Hyperliquid' });
    w.venue.down = null;
    expect((await call(w, getLockPreview, 'GET', { cookie, params })).status).toBe(200);

    w.clock.advance(DEFAULT_POLICY.maxDataAgeMs + 1_000);
    const stale = await call(w, getLockPreview, 'GET', { cookie, params });
    expect(stale.status).toBe(503);
    expect(stale.body.message).toBe('the treasury balance is unavailable: the latest treasury reading is 181 s old, over the 180 s allowed');
    expect(stale.body.plan).toBeUndefined();
  });

  it('says there is nothing to lock rather than planning an empty lock', async () => {
    const { org, cookie, params } = await owned();
    w.chain.notes = [note(BIRTHDAY + 10, 500_000n)];
    await tickOnce(w, org.id);
    const answer = await call(w, getLockPreview, 'GET', { cookie, params });
    expect(answer.status).toBe(409);
    expect(answer.body.error).toBe('refused');
    expect((await call(w, getLockPreview, 'GET', { cookie, params, query: { swapCostBps: '-5' } })).status).toBe(400);
  });

  it('lists what the treasurer is asked to do, from the venue as it stands now', async () => {
    const { org, cookie, params } = await owned();
    expect((await call(w, getAdvisories, 'GET', { cookie, params })).body).toEqual({ lockEnabled: false, advisories: [], treasury: null, readAt: w.clock.ms });

    await w.store.updateOrg(org.id, { lockEnabled: true });
    w.chain.notes = [note(BIRTHDAY + 10, 10_000_000_000n)];
    await tickOnce(w, org.id);
    w.venue.shortLots = 10_000;
    w.venue.equity = 50_000;
    const { status, body } = await call(w, getAdvisories, 'GET', { cookie, params });
    expect(status).toBe(200);
    expect(body.lockEnabled).toBe(true);
    expect(body.advisories).toEqual([{ kind: 'TOP_UP_MARGIN', usd: Math.ceil((100 * PX * 0.8 - 50_000) * 100) / 100, severity: 'warn' }]);
    expect(body.treasury).toMatchObject({ status: 'ok', value: { zat: '10000000000' } });

    w.venue.equity = 200_000;
    expect((await call(w, getAdvisories, 'GET', { cookie, params })).body.advisories).toEqual([{ kind: 'SWEEP_EXCESS_MARGIN', usd: Math.floor((200_000 - 100 * PX * 0.8) * 100) / 100 }]);
  });

  it('does not answer "nothing to do" when it cannot see the venue', async () => {
    const { org, cookie, params } = await owned();
    await w.store.updateOrg(org.id, { lockEnabled: true });
    w.venue.down = 'fetch failed';
    const answer = await call(w, getAdvisories, 'GET', { cookie, params });
    expect(answer.status).toBe(503);
    expect(answer.body.advisories).toBeUndefined();

    w.venue.down = null;
    w.venue.shortLots = 100;
    w.venue.equity = 10;
    const blind = await call(w, getAdvisories, 'GET', { cookie, params });
    expect(blind.body.treasury).toMatchObject({ status: 'unavailable', reason: 'no tick has run for this organisation yet' });
    expect(blind.body.advisories).toEqual([{ kind: 'TOP_UP_MARGIN', usd: expect.any(Number), severity: 'critical' }]);
  });

  it('is for the owner alone', async () => {
    const { org } = await owned();
    await expectOwnerOnly(
      w,
      org.id,
      [
        { name: 'policy', endpoint: getPolicy, method: 'GET' },
        { name: 'replace policy', endpoint: putPolicy, method: 'PUT', body: { ...DEFAULT_POLICY, hedgeRatioBps: 0 } },
        { name: 'lock', endpoint: putLock, method: 'PUT', body: { enabled: true } },
        { name: 'lock preview', endpoint: getLockPreview, method: 'GET' },
        { name: 'advisories', endpoint: getAdvisories, method: 'GET' },
      ],
      async () => expect(await w.store.findOrg(org.id)).toMatchObject({ policy: DEFAULT_POLICY, lockEnabled: false }),
    );
  });
});
