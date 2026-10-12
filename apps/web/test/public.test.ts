import type { OrgRecord, PgliteConnection } from '@holdfast/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getDemoBooks, getDemoJournal, getDemoList, getDemoOverview, getDemoPayouts, getDemoReceipts, getDemoSafety, getReceipt, getScorecard, getSeries } from '../src/server/api/public';
import type { Endpoint } from '../src/server/http/endpoint';
import { PX, SOLANA_PAYEES } from './support/fakes';
import { BARS, BIRTHDAY, PAYEES, STARTUP_TIMEOUT_MS, UFVK, type World, call, keyAddress, migratedPglite, newAccount, note, organisation, tickOnce, world } from './support/world';

let connection: PgliteConnection;

beforeAll(async () => {
  connection = await migratedPglite();
}, STARTUP_TIMEOUT_MS);

afterAll(() => connection.close());

const DEMO_ROUTES: [string, Endpoint][] = [
  ['overview', getDemoOverview],
  ['journal', getDemoJournal],
  ['receipts', getDemoReceipts],
  ['payouts', getDemoPayouts],
  ['safety', getDemoSafety],
  ['books', getDemoBooks],
];

/** A demo organisation with the lock on, 0.05 ZEC received with a memo, and one tick behind it. */
async function demo(): Promise<{ w: World; org: OrgRecord }> {
  const w = world(connection);
  const created = await organisation(w, newAccount().address, { name: 'Holdfast Demo' });
  await w.store.updateOrg(created.id, { publicDemo: true, lockEnabled: true });
  w.chain.notes = [note(BIRTHDAY + 10, 5_000_000n, { memo: 'ZCG grant, milestone 2 of 4' }), note(BIRTHDAY + 12, 1n, { kind: 'change', memo: 'change of a spend' })];
  await tickOnce(w, created.id);
  const org = await w.store.findOrg(created.id);
  if (org === null) throw new Error('the organisation is gone');
  return { w, org };
}

const get = (w: World, endpoint: Endpoint, orgId: string, query: Record<string, string> = {}) => call(w, endpoint, 'GET', { params: { orgId }, query });

describe('the public demo', () => {
  it('lists the organisations that chose to be one, and no other', async () => {
    const { w, org } = await demo();
    const hidden = await organisation(w, newAccount().address, { name: 'Private Treasury' });
    const answer = await call(w, getDemoList, 'GET');
    expect(answer.status).toBe(200);
    expect(answer.body.orgs).toContainEqual({ id: org.id, name: 'Holdfast Demo' });
    expect(answer.text).not.toContain(hidden.id);
    expect(answer.text).not.toContain('Private Treasury');
  });

  it('answers for an organisation that is not a demo exactly as for one that does not exist', async () => {
    const { w } = await demo();
    const hidden = await organisation(w, newAccount().address, { name: 'Private Treasury' });
    await tickOnce(w, hidden.id);
    for (const [name, endpoint] of DEMO_ROUTES) {
      const real = await get(w, endpoint, hidden.id);
      const absent = await get(w, endpoint, 'no-such-organisation');
      expect(real.status, name).toBe(404);
      expect(real.text, name).toBe(absent.text);
      expect(real.body, name).toEqual({ error: 'not_found', message: 'not found' });
    }
  });

  it('needs no session and sets no cookie', async () => {
    const { w, org } = await demo();
    const answer = await get(w, getDemoOverview, org.id);
    expect(answer.status).toBe(200);
    expect(answer.headers.get('set-cookie')).toBeNull();
    expect(answer.headers.get('cache-control')).toBe('no-store');
  });

  describe('overview', () => {
    it('shows the treasury from the latest tick and the hedge from the venue now, each with when it was read', async () => {
      const { w, org } = await demo();
      w.venue.equity = 80;
      const tickAt = w.clock.ms;
      w.clock.advance(30_000);
      const { body } = await get(w, getDemoOverview, org.id);

      expect(body.org).toEqual({ id: org.id, name: 'Holdfast Demo' });
      expect(body.lockEnabled).toBe(true);
      expect(body.lastTick).toEqual({ status: 'ok', source: 'journal', readAt: tickAt, value: { seq: 1, at: tickAt, ageMs: 30_000, mode: 'REBALANCE', digest: org.lastDigest } });
      expect(body.treasury).toEqual({ status: 'ok', source: 'zcash', readAt: tickAt, value: { zat: '5000001', zec: '0.05000001' } });
      expect(body.hedge).toEqual({
        status: 'ok',
        source: 'hyperliquid',
        readAt: w.clock.ms,
        value: { shortLots: 5, shortZec: 0.05, markPx: PX, oraclePx: PX, notionalUsd: (5 * PX) / 100, accountValueUsd: 80 },
      });
      expect(body.marginRatio.value).toEqual({ bps: Math.round((80 / ((5 * PX) / 100)) * 10_000) });
      expect(body.funding).toMatchObject({ status: 'ok', source: 'hyperliquid', value: { aprBps: 1_190 } });
      expect(body.locked.value).toEqual({ lots: 5, zec: 0.05, usd: (5 * PX) / 100 });
      expect(body.coverage).toMatchObject({ status: 'ok', value: { targetLots: 5, bps: 10_000 } });
    });

    it('says the hedge is unavailable when the venue cannot be read, and gives no number in its place', async () => {
      const { w, org } = await demo();
      w.venue.down = 'fetch failed';
      const { status, body } = await get(w, getDemoOverview, org.id);
      expect(status).toBe(200);
      for (const field of ['hedge', 'marginRatio', 'funding', 'locked', 'coverage']) {
        expect(body[field], field).toEqual({ status: 'unavailable', source: 'hyperliquid', readAt: w.clock.ms, reason: 'fetch failed' });
      }
      expect(body.treasury.status).toBe('ok');
    });

    it('does not pass off a venue answer that is too old as the present', async () => {
      const { w, org } = await demo();
      w.venue.lag = org.policy.maxDataAgeMs + 1_000;
      const { body } = await get(w, getDemoOverview, org.id);
      expect(body.hedge).toMatchObject({ status: 'unavailable', reason: 'the venue state is 181 s old, over the 180 s allowed' });
    });

    it('says the treasury is unavailable once the latest tick is too old to speak for it', async () => {
      const { w, org } = await demo();
      w.clock.advance(org.policy.maxDataAgeMs + 1_000);
      const { body } = await get(w, getDemoOverview, org.id);
      expect(body.treasury).toMatchObject({ status: 'unavailable', source: 'zcash', reason: 'the latest treasury reading is 181 s old, over the 180 s allowed' });
      expect(body.coverage.status).toBe('unavailable');
      expect(body.lastTick).toMatchObject({ status: 'ok', value: { ageMs: org.policy.maxDataAgeMs + 1_000 } });
      expect(body.hedge.status).toBe('ok');
    });

    it('gives the reason the latest tick could not read the treasury, without the viewing key', async () => {
      const { w, org } = await demo();
      w.chain.scan = async () => {
        throw new Error(`lightwalletd refused ${UFVK}`);
      };
      await tickOnce(w, org.id);
      const answer = await get(w, getDemoOverview, org.id);
      expect(answer.body.treasury).toMatchObject({ status: 'unavailable', reason: 'lightwalletd refused [viewing key]' });
      expect(answer.text).not.toContain(UFVK);
    });

    it('says so when no tick has run yet', async () => {
      const w = world(connection);
      const org = await organisation(w, newAccount().address);
      await w.store.updateOrg(org.id, { publicDemo: true });
      const { body } = await get(w, getDemoOverview, org.id);
      expect(body.lastTick).toMatchObject({ status: 'unavailable', reason: 'no tick has run for this organisation yet' });
      expect(body.treasury).toMatchObject({ status: 'unavailable', reason: 'no tick has run for this organisation yet' });
    });
  });

  describe('journal', () => {
    it('serves the entries newest first with the result of checking their chain', async () => {
      const { w, org } = await demo();
      await tickOnce(w, org.id);
      await tickOnce(w, org.id);
      const { body } = await get(w, getDemoJournal, org.id);
      expect(body.entries.map((e: { seq: number }) => e.seq)).toEqual([3, 2, 1]);
      expect(body.chain).toEqual({ ok: true, fromSeq: 1, toSeq: 3 });
      expect(body.isHead).toBe(true);
      expect(body.nextBeforeSeq).toBeNull();
      expect(body.readAt).toBe(w.clock.ms);
      expect(body.entries[2].snapshot.treasury.zat).toBe('5000001');
    });

    it('pages backwards, checking each page on its own', async () => {
      const { w, org } = await demo();
      await tickOnce(w, org.id);
      await tickOnce(w, org.id);
      const first = await get(w, getDemoJournal, org.id, { limit: '2' });
      expect(first.body.entries.map((e: { seq: number }) => e.seq)).toEqual([3, 2]);
      expect(first.body.nextBeforeSeq).toBe(2);
      const second = await get(w, getDemoJournal, org.id, { limit: '2', beforeSeq: '2' });
      expect(second.body.entries.map((e: { seq: number }) => e.seq)).toEqual([1]);
      expect(second.body).toMatchObject({ chain: { ok: true, fromSeq: 1, toSeq: 1 }, isHead: null, nextBeforeSeq: null });
    });

    it('reports an entry that was changed after it was written', async () => {
      const { w, org } = await demo();
      await tickOnce(w, org.id);
      await connection.client.query("update holdfast.journal set entry = jsonb_set(entry, '{decision,mode}', '\"HOLD\"') where org_id = $1 and seq = 1", [org.id]);
      const { body } = await get(w, getDemoJournal, org.id);
      expect(body.chain).toEqual({ ok: false, seq: 1, reason: 'content does not match its digest' });
    });

    it('refuses a page that is not a page', async () => {
      const { w, org } = await demo();
      for (const query of [{ limit: '0' }, { limit: '101' }, { limit: 'ten' }, { beforeSeq: '-1' }, { offset: '5' }]) {
        const answer = await get(w, getDemoJournal, org.id, query);
        expect(answer.status).toBe(400);
        expect(answer.body.error).toBe('invalid_input');
      }
    });
  });

  describe('receipts', () => {
    it('lists what the treasury received with its memo, and leaves out its own change', async () => {
      const { w, org } = await demo();
      const { body } = await get(w, getDemoReceipts, org.id);
      expect(body.receipts).toMatchObject({ status: 'ok', source: 'zcash', readAt: w.clock.ms });
      expect(body.receipts.value.scannedTo).toBe(BIRTHDAY + 100);
      expect(body.receipts.value.items).toEqual([
        { txid: `tx${BIRTHDAY + 10}`, height: BIRTHDAY + 10, time: expect.any(Number), zat: '5000000', zec: '0.05', memo: 'ZCG grant, milestone 2 of 4', pool: 'ironwood' },
      ]);
    });

    it('is unavailable when the scan behind it is too old', async () => {
      const { w, org } = await demo();
      w.clock.advance(org.policy.maxDataAgeMs + 1_000);
      const { body } = await get(w, getDemoReceipts, org.id);
      expect(body.receipts.status).toBe('unavailable');
      expect(body.receipts.value).toBeUndefined();
    });
  });

  describe('payouts and their receipts', () => {
    async function withRuns() {
      const { w, org } = await demo();
      const lines = (runId: string) => [
        { payeeName: 'Ada Lovelace', toAddress: PAYEES[0], amount: 1_000_000n, memo: `${runId}/1`, reference: 'INV-1041' },
        { payeeName: 'Grace Hopper', toAddress: PAYEES[1], amount: 2_500_000n, memo: `${runId}/2`, reference: 'INV-1042' },
      ];
      const run = { chain: 'tempo' as const, token: w.deps.tempo.token, tokenSymbol: 'AlphaUSD', tokenDecimals: 6, account: org.tempoAccount ?? '', notBefore: null, at: w.clock.ms, lines };
      const paid = await w.store.createPayoutRun(org.id, run);
      await w.store.settlePayoutRun(org.id, paid.id, { status: 'paid', tx: `0x${'ab'.repeat(32)}`, error: null, executedAt: w.clock.ms });
      const draft = await w.store.createPayoutRun(org.id, run);
      return { w, org, paid, draft };
    }

    it('shows the runs that were paid and nothing of the payees', async () => {
      const { w, org, paid, draft } = await withRuns();
      const answer = await get(w, getDemoPayouts, org.id);
      expect(answer.body.payouts).toMatchObject({ status: 'ok', source: 'database', readAt: w.clock.ms });
      expect(answer.body.payouts.value).toEqual([
        {
          id: paid.id,
          chain: 'tempo',
          token: { address: w.deps.tempo.token, symbol: 'AlphaUSD', decimals: 6 },
          total: '3500000',
          paidAt: w.clock.ms,
          tx: `0x${'ab'.repeat(32)}`,
          txUrl: `https://explore.testnet.tempo.xyz/tx/0x${'ab'.repeat(32)}`,
          lines: [
            { lineNo: 1, amount: '1000000', memo: `${paid.id}/1`, receiptToken: paid.lines[0]?.receiptToken },
            { lineNo: 2, amount: '2500000', memo: `${paid.id}/2`, receiptToken: paid.lines[1]?.receiptToken },
          ],
        },
      ]);
      for (const hidden of ['Ada Lovelace', 'Grace Hopper', PAYEES[0], PAYEES[1], 'INV-1041', draft.id, org.tempoAccount ?? '']) expect(answer.text).not.toContain(hidden);
    });

    it('serves the receipt of a paid line to whoever holds its token: the payment, and nothing about who paid', async () => {
      const { w, org, paid } = await withRuns();
      const token = paid.lines[1]?.receiptToken ?? '';
      const answer = await call(w, getReceipt, 'GET', { params: { token } });
      expect(answer.status).toBe(200);
      expect(answer.body).toEqual({
        chain: 'tempo',
        token: { address: w.deps.tempo.token, symbol: 'AlphaUSD', decimals: 6 },
        amount: '2500000',
        memo: `${paid.id}/2`,
        tx: `0x${'ab'.repeat(32)}`,
        txUrl: `https://explore.testnet.tempo.xyz/tx/0x${'ab'.repeat(32)}`,
      });
      for (const hidden of [org.id, org.name, org.tempoAccount ?? '', org.hlUser, 'Grace Hopper', '3500000']) expect(answer.text).not.toContain(hidden);
    });

    it('has no receipt for a line that was not paid, for a token nobody was given, or for something that is no token', async () => {
      const { w, draft } = await withRuns();
      const absent = await call(w, getReceipt, 'GET', { params: { token: 'A'.repeat(43) } });
      expect(absent.status).toBe(404);
      for (const token of [draft.lines[0]?.receiptToken ?? '', 'short', `${'A'.repeat(43)}'; drop table holdfast.orgs; --`]) {
        const answer = await call(w, getReceipt, 'GET', { params: { token } });
        expect(answer.status).toBe(404);
        expect(answer.text).toBe(absent.text);
      }
    });
  });

  describe('safety', () => {
    it('shows each key with its scope as the chain reports it now, and where the limit is enforced', async () => {
      const { w, org } = await demo();
      await w.store.recordRefusal(org.id, { chain: 'tempo', kind: 'over_limit', attempted: 'transferWithMemo of the largest amount there is', outcome: 'SpendingLimitExceeded', tx: '0xr1', evidence: { returnData: '0x8a9e71ea' } });
      const answer = await get(w, getDemoSafety, org.id);
      const byKind = new Map<string, Record<string, any>>(answer.body.keys.map((key: { kind: string }) => [key.kind, key]));

      expect([...byKind.keys()]).toEqual(['zcash_viewing_key', 'hl_agent', 'tempo_access', 'solana_delegate', 'hl_attester']);
      expect(byKind.get('zcash_viewing_key')).toMatchObject({ address: null, scope: { status: 'ok', value: { canView: true, canSpend: false } } });
      expect(byKind.get('hl_agent')).toMatchObject({ address: await keyAddress(w, org.id, 'hl_agent'), scope: { status: 'unavailable', source: 'hyperliquid' } });
      expect(byKind.get('tempo_access')).toMatchObject({
        address: await keyAddress(w, org.id, 'tempo_access'),
        chain: 'tempo',
        scope: { status: 'ok', source: 'tempo', value: { authorized: true, revoked: false, limited: true, remaining: '10000000', scope: { unrestricted: false, otherTargets: [] } } },
      });
      expect(byKind.get('solana_delegate')).toMatchObject({ address: await keyAddress(w, org.id, 'solana_delegate'), scope: { status: 'ok', source: 'solana', value: { remaining: '50000000' } } });
      expect(byKind.get('hl_attester')).toMatchObject({ address: await keyAddress(w, org.id, 'hl_attester'), scope: { status: 'ok', source: 'hyperevm', readAt: w.clock.ms, value: { registered: false } } });
      for (const key of byKind.values()) expect(key.enforcedBy.length).toBeGreaterThan(40);

      expect(answer.body.refusals.value).toEqual([
        { chain: 'tempo', kind: 'over_limit', attempted: 'transferWithMemo of the largest amount there is', outcome: 'SpendingLimitExceeded', tx: '0xr1', txUrl: 'https://explore.testnet.tempo.xyz/tx/0xr1', at: w.clock.ms },
      ]);
      expect(answer.text).not.toContain('returnData');
    });

    it('says a scope is unavailable when its chain cannot be read, and never what it was before', async () => {
      const { w, org } = await demo();
      w.tempoChain(await keyAddress(w, org.id, 'tempo_access')).failing.add('keyState');
      w.solana.down = 'connect ECONNREFUSED';
      w.attestor.down = 'attesterOf failed: HTTP request failed.';
      const { body } = await get(w, getDemoSafety, org.id);
      const scope = (kind: string) => body.keys.find((key: { kind: string }) => key.kind === kind).scope;
      expect(scope('tempo_access')).toEqual({ status: 'unavailable', source: 'tempo', readAt: w.clock.ms, reason: 'keyState failed: fetch failed' });
      expect(scope('solana_delegate')).toEqual({ status: 'unavailable', source: 'solana', readAt: w.clock.ms, reason: 'connect ECONNREFUSED' });
      expect(scope('hl_attester')).toEqual({ status: 'unavailable', source: 'hyperevm', readAt: w.clock.ms, reason: 'attesterOf failed: HTTP request failed.' });
    });

    it('never shows a key itself', async () => {
      const { w, org } = await demo();
      const answer = await get(w, getDemoSafety, org.id);
      for (const kind of ['hl_agent', 'tempo_access', 'solana_delegate', 'hl_attester'] as const) {
        expect(answer.text).not.toContain((await w.store.activeKey(org.id, kind))?.secret);
      }
      expect(answer.text).not.toContain(UFVK);
    });
  });

  describe('books', () => {
    it('summarises the statement without the ledger behind it', async () => {
      const { w, org } = await demo();
      // A second tick, so that the journal holds a reading of the short the first one opened.
      await tickOnce(w, org.id);
      const { body, text } = await get(w, getDemoBooks, org.id);
      expect(body.books).toMatchObject({ status: 'ok', source: 'ledger', readAt: w.clock.ms });
      const { value } = body.books;
      // The ledger books the receipt; the lone change note of this fixture has no spend to belong to.
      expect(value.treasury).toMatchObject({ zat: '5000000', px: PX });
      expect(value.hedge).toMatchObject({ shortLots: 5, markPx: PX });
      expect(value.receipts).toMatchObject({ zat: '5000000', count: 1 });
      expect(value.fees).toMatchObject({ tradeUsd: 0.01 });
      expect(value.stale).toEqual([]);
      expect(Object.keys(value).sort()).toEqual(['asOf', 'fees', 'funding', 'hedge', 'lock', 'payments', 'payouts', 'range', 'receipts', 'runwayMonths', 'stale', 'swapped', 'treasury']);
      expect(text).not.toContain('ZCG grant');
    });

    it('is unavailable when the venue cannot be read: a ledger without the hedge would be a wrong one', async () => {
      const { w, org } = await demo();
      w.venue.down = 'fetch failed';
      const { status, body } = await get(w, getDemoBooks, org.id);
      expect(status).toBe(200);
      expect(body.books).toEqual({ status: 'unavailable', source: 'Hyperliquid', readAt: w.clock.ms, reason: 'Hyperliquid is unavailable: fetch failed' });
    });
  });
});

describe('the backtest', () => {
  it('grades the default policy on the nine scenarios, once for the life of the process', async () => {
    const w = world(connection);
    let loads = 0;
    w.deps.bars = async () => {
      loads++;
      return BARS;
    };
    const [first, second] = await Promise.all([call(w, getScorecard, 'GET'), call(w, getScorecard, 'GET')]);
    const third = await call(w, getSeries, 'GET', { query: { scenario: 'june-crash' } });
    expect(loads).toBe(1);
    expect(first.status).toBe(200);
    expect(second.text).toBe(first.text);
    expect(third.status).toBe(200);

    const { body } = first;
    expect(body.ok).toBe(true);
    expect(body.policy.hedgeRatioBps).toBe(10_000);
    expect(body.scenarios).toHaveLength(9);
    expect(body.scenarios.map((s: { id: string }) => s.id)).toContain('squeeze-then-crash-unanswered');
    for (const scenario of body.scenarios) {
      expect(scenario.result.series).toBeUndefined();
      expect(scenario.result.liquidated).toBe(false);
      expect(scenario.checks.length).toBeGreaterThan(0);
      if (!scenario.control) expect(scenario.pass, scenario.id).toBe(true);
    }
    const crash = body.scenarios.find((s: { id: string }) => s.id === 'june-crash');
    expect(crash.result.unhedgedMaxDrawdownBps).toBeGreaterThan(3_000);
    expect(crash.result.maxDrawdownBps).toBeLessThanOrEqual(300);
  }, 60_000);

  it('serves one scenario hour by hour', async () => {
    const w = world(connection);
    const { status, body } = await call(w, getSeries, 'GET', { query: { scenario: 'april-wick' } });
    expect(status).toBe(200);
    expect(body).toMatchObject({ id: 'april-wick', title: 'Largest one-hour spike', from: '2026-04-06T00:00:00Z', to: '2026-04-09T00:00:00Z' });
    expect(body.points).toHaveLength(72);
    expect(body.points[0]).toEqual({ t: Date.parse('2026-04-06T00:00:00Z'), px: expect.any(Number), nav: expect.any(Number), unhedgedNav: expect.any(Number), shortLots: expect.any(Number), marginRatioBps: expect.any(Number), coverageBps: expect.any(Number), fundingAprBps: expect.any(Number) });
  }, 60_000);

  it('does not know a scenario that is not one, and asks which one is meant', async () => {
    const w = world(connection);
    expect((await call(w, getSeries, 'GET', { query: { scenario: 'no-such-scenario' } })).status).toBe(404);
    expect((await call(w, getSeries, 'GET')).status).toBe(400);
    expect((await call(w, getSeries, 'GET', { query: { scenario: 'june-crash', extra: '1' } })).status).toBe(400);
  }, 60_000);

  it('is unavailable when the market data cannot be loaded, and works again once it can', async () => {
    const w = world(connection);
    let broken = true;
    w.deps.bars = async () => {
      if (broken) throw new Error('ENOENT: zec-1h.json');
      return BARS;
    };
    const failed = await call(w, getScorecard, 'GET');
    expect(failed.status).toBe(503);
    expect(failed.body).toEqual({ error: 'unavailable', message: 'the market data is unavailable: ENOENT: zec-1h.json', source: 'the market data' });
    broken = false;
    expect((await call(w, getScorecard, 'GET')).status).toBe(200);
  }, 60_000);
});
