import type { PgliteConnection } from '@holdfast/db';
import { verifyChain } from '@holdfast/engine';
import { ZERO_ROOT } from '@holdfast/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { occupy, pending } from '../../../packages/db/test/support/fakes';
import { postTick } from '../src/server/api/tick';
import { scheduledEndpoint } from '../src/server/http/endpoint';
import { runTick } from '../src/server/tick/service';
import { BIRTHDAY, STARTUP_TIMEOUT_MS, TICK_SECRET, UFVK, type World, call, migratedPglite, newAccount, note, organisation, world } from './support/world';

// The tick takes every organisation in the database, so each test has a database of its own.
let connection: PgliteConnection;
let w: World;

beforeEach(async () => {
  connection = await migratedPglite();
  w = world(connection);
}, STARTUP_TIMEOUT_MS);

afterEach(() => connection.close());

const bearer = (secret: string) => ({ authorization: `Bearer ${secret}` });
const tick = (headers: Record<string, string> = bearer(TICK_SECRET)) => call(w, postTick, 'POST', { headers, origin: null });

/** Lock on, so that a treasury with ZEC in it makes the controller open a short. */
async function lockedOrg(name: string) {
  const org = await organisation(w, newAccount().address, { name });
  await w.store.updateOrg(org.id, { lockEnabled: true });
  return org;
}

describe('POST /api/tick', () => {
  it('is refused without the secret', async () => {
    await lockedOrg('Acme');
    const answer = await tick({});
    expect(answer.status).toBe(401);
    expect(answer.body).toEqual({ error: 'unauthenticated', message: 'the tick secret is missing or wrong' });
    expect(await w.store.listJournal((await w.store.listOrgIds())[0] ?? '')).toEqual([]);
  });

  it('is refused with a wrong secret, whatever its length or scheme', async () => {
    await lockedOrg('Acme');
    for (const headers of [bearer('wrong'), bearer(`${TICK_SECRET}x`), bearer(TICK_SECRET.slice(0, -1)), { authorization: `Basic ${TICK_SECRET}` }, { authorization: TICK_SECRET }]) {
      const answer = await tick(headers);
      expect(answer.status).toBe(401);
      expect(answer.body.error).toBe('unauthenticated');
    }
    expect(w.venue.orders).toEqual([]);
  });

  it('ticks every organisation and answers with what each tick did', async () => {
    const first = await lockedOrg('First');
    const second = await organisation(w, newAccount().address, { name: 'Second, lock off' });
    w.chain.notes = [note(BIRTHDAY + 10, 5_000_000n)];

    const answer = await tick();
    expect(answer.status).toBe(200);
    expect(answer.body.startedAt).toBe(w.clock.ms);
    const byOrg = new Map<string, Record<string, unknown>>(answer.body.orgs.map((o: { orgId: string }) => [o.orgId, o]));
    expect(byOrg.get(first.id)).toEqual({
      orgId: first.id,
      status: 'ran',
      seq: 1,
      at: w.clock.ms,
      mode: 'REBALANCE',
      refusals: [],
      advisories: [],
      order: { side: 'sell', lots: 5, ok: true, filledLots: 5, error: null },
      unread: [],
    });
    expect(byOrg.get(second.id)).toMatchObject({ status: 'ran', seq: 1, mode: 'HOLD', order: null });
    expect(answer.body.swaps).toEqual([]);

    const journal = await w.store.journalRange(first.id, 1, 10);
    expect(journal).toHaveLength(1);
    expect(verifyChain(journal, ZERO_ROOT)).toEqual({ ok: true });
    expect(w.venue.orders).toHaveLength(1);
  });

  it('goes on with the others when one organisation throws, and says nothing secret about why', async () => {
    const broken = await lockedOrg('Broken');
    const sound = await lockedOrg('Sound');
    w.chain.notes = [note(BIRTHDAY + 10, 5_000_000n)];
    // A viewing key sealed under another master key: the tick cannot even load the organisation.
    await connection.client.query("update holdfast.orgs set ufvk_enc = 'v1.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA.AAAA' where id = $1", [broken.id]);

    const answer = await tick();
    expect(answer.status).toBe(200);
    const byOrg = new Map<string, Record<string, unknown>>(answer.body.orgs.map((o: { orgId: string }) => [o.orgId, o]));
    expect(byOrg.get(broken.id)).toEqual({ orgId: broken.id, status: 'failed', error: 'the secret could not be decrypted: wrong key or altered envelope' });
    expect(byOrg.get(sound.id)).toMatchObject({ status: 'ran', seq: 1, mode: 'REBALANCE' });
    expect(await w.store.listJournal(sound.id)).toHaveLength(1);
  });

  it('reports a source that could not be read without the viewing key that was used to read it', async () => {
    const org = await lockedOrg('Acme');
    w.chain.scan = async () => {
      throw new Error(`lightwalletd refused ${UFVK} at https://zec.example.test`);
    };
    w.venue.down = 'fetch failed';

    const answer = await tick();
    expect(answer.body.orgs).toEqual([
      {
        orgId: org.id,
        status: 'ran',
        seq: 1,
        at: w.clock.ms,
        mode: 'HOLD',
        refusals: ['STALE_HL'],
        advisories: [],
        order: null,
        unread: expect.arrayContaining([
          { source: 'treasury', message: 'lightwalletd refused [viewing key] at https://zec.example.test' },
          { source: 'venue', message: 'fetch failed' },
        ]),
      },
    ]);
    expect(answer.body.orgs[0].unread).toHaveLength(2);
    expect(answer.text).not.toContain(UFVK);
  });

  it('never puts a key or a secret in its answer', async () => {
    const org = await lockedOrg('Acme');
    w.chain.notes = [note(BIRTHDAY + 10, 5_000_000n)];
    const answer = await tick();
    const secrets = [UFVK, TICK_SECRET, (await w.store.activeKey(org.id, 'hl_agent'))?.secret, (await w.store.activeKey(org.id, 'tempo_access'))?.secret, (await w.store.activeKey(org.id, 'solana_delegate'))?.secret];
    for (const secret of secrets) {
      expect(secret).toBeTruthy();
      expect(answer.text).not.toContain(secret);
    }
  });

  it('leaves alone an organisation another tick is holding', async () => {
    const org = await lockedOrg('Held');
    const holder = await occupy(w.store, org.id);
    const answer = await tick();
    expect(answer.body.orgs).toEqual([{ orgId: org.id, status: 'busy' }]);
    await holder.leave();
  });

  it('asks the swap service about swaps that have not settled, and writes the answer down', async () => {
    const org = await lockedOrg('Acme');
    const open = await w.store.recordSwap(org.id, { purpose: 'margin', originAsset: 'zec', destinationAsset: 'usdc', amountIn: 100n, minAmountOut: 90n, depositAddress: 't1open', recipient: org.hlUser, quote: {}, state: 'PENDING_DEPOSIT' });
    const done = await w.store.recordSwap(org.id, { purpose: 'margin', originAsset: 'zec', destinationAsset: 'usdc', amountIn: 100n, minAmountOut: 90n, depositAddress: 't1done', recipient: org.hlUser, quote: {}, state: 'PENDING_DEPOSIT' });
    await w.store.updateSwap(org.id, done.id, { state: 'SUCCESS', originTxs: [], destinationTxs: [], amountOut: 95n });
    w.oneClick.swaps.set('t1open', { status: 'SUCCESS', swapDetails: { amountOut: '96', originChainTxHashes: [{ hash: 'zec-tx' }], destinationChainTxHashes: [{ hash: 'hl-tx' }] } });

    const answer = await tick();
    expect(answer.body.swaps).toEqual([{ swapId: open.id, orgId: org.id, status: 'ok', state: 'SUCCESS', final: true }]);
    expect(w.oneClick.statusCalls).toEqual(['t1open']);
    expect(await w.store.findSwap(org.id, open.id)).toMatchObject({ state: 'SUCCESS', amountOut: 96n, originTxs: ['zec-tx'], destinationTxs: ['hl-tx'] });
  });

  it('still answers when the swap service does not, and leaves the swap as it was', async () => {
    const org = await lockedOrg('Acme');
    const open = await w.store.recordSwap(org.id, { purpose: 'margin', originAsset: 'zec', destinationAsset: 'usdc', amountIn: 100n, minAmountOut: 90n, depositAddress: 't1open', recipient: org.hlUser, quote: {}, state: 'PROCESSING' });
    w.oneClick.down = 'connect ETIMEDOUT';

    const answer = await tick();
    expect(answer.status).toBe(200);
    expect(answer.body.orgs).toHaveLength(1);
    expect(answer.body.swaps).toEqual([{ swapId: open.id, orgId: org.id, status: 'unavailable', reason: '1Click is unreachable: connect ETIMEDOUT' }]);
    expect(await w.store.findSwap(org.id, open.id)).toMatchObject({ state: 'PROCESSING', amountOut: null });
  });
});

describe('the tick, on a budget', () => {
  it('never runs more organisations at once than it was told', async () => {
    for (let i = 0; i < 6; i++) await lockedOrg(`Org ${i}`);
    let running = 0;
    let most = 0;
    const venue = w.venue;
    const state = venue.state.bind(venue);
    venue.state = async () => {
      running++;
      most = Math.max(most, running);
      await new Promise((resolve) => setTimeout(resolve, 20));
      running--;
      return state();
    };

    const report = await runTick(w.deps, { concurrency: 2 });
    expect(report.orgs.map((o) => o.status)).toEqual(Array.from({ length: 6 }, () => 'ran'));
    expect(most).toBe(2);
  });

  it('starts nothing once the time is spent, and says which organisations it did not reach', async () => {
    const org = await lockedOrg('Late');
    const report = await runTick(w.deps, { budgetMs: 0 });
    expect(report.orgs).toEqual([{ orgId: org.id, status: 'skipped', reason: 'the time allowed for this invocation ran out' }]);
    expect(await w.store.listJournal(org.id)).toEqual([]);
  });

  it('answers in time even when a tick does not come back', async () => {
    const org = await lockedOrg('Stuck');
    const stuck = pending();
    w.venue.state = async () => {
      await stuck.done;
      throw new Error('too late');
    };
    const report = await runTick(w.deps, { budgetMs: 60 });
    expect(report.orgs).toEqual([{ orgId: org.id, status: 'failed', error: 'the time allowed for this invocation ran out before the tick finished' }]);
    stuck.finish();
  });

  it('is served through an endpoint that asks for the secret before it does anything', async () => {
    let ran = false;
    const endpoint = scheduledEndpoint(async () => {
      ran = true;
      return { done: true };
    });
    expect((await call(w, endpoint, 'POST', { origin: null })).status).toBe(401);
    expect(ran).toBe(false);
    expect((await call(w, endpoint, 'POST', { origin: null, headers: bearer(TICK_SECRET) })).body).toEqual({ done: true });
  });
});
