import { parsePublishedStatement, reconcile } from '@holdfast/books';
import { ZERO_ROOT } from '@holdfast/core';
import type { PgliteConnection } from '@holdfast/db';
import { verifyChain } from '@holdfast/engine';
import { checkUfvk } from '@holdfast/zcash';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { deleteAuditLink, getAudit, getAuditLinks, getExport, getReconciliation, getStatement, postAuditLink } from '../src/server/api/books';
import { postPayout, postPayoutExecute } from '../src/server/api/payouts';
import { hashToken } from '../src/server/books/audit-links';
import { expectOwnerOnly } from './support/access';
import { BIRTHDAY, PAYEES, RPC_URL, STARTUP_TIMEOUT_MS, UFVK, type World, call, keyAddress, migratedPglite, newAccount, note, organisation, sessionOf, tickOnce, world } from './support/world';

let connection: PgliteConnection;
let w: World;

beforeAll(async () => {
  connection = await migratedPglite();
}, STARTUP_TIMEOUT_MS);

afterAll(() => connection.close());

beforeEach(() => {
  w = world(connection);
});

const MEMO = 'ZCG grant, milestone 2 of 4';

/**
 * An organisation with some history: a grant received, the lock opened by
 * two ticks, and one payout run of two lines paid on Tempo.
 */
async function withHistory() {
  const owner = newAccount();
  const org = await organisation(w, owner.address);
  const cookie = await sessionOf(w, owner.address);
  const params = { orgId: org.id };
  await w.store.updateOrg(org.id, { lockEnabled: true });
  w.chain.notes = [note(BIRTHDAY + 10, 5_000_000n, { memo: MEMO })];
  await tickOnce(w, org.id);
  await tickOnce(w, org.id);
  const lines = [
    { payee: { name: 'Ada Lovelace', address: PAYEES[0] }, amount: '1000000', reference: 'INV-1041' },
    { payee: { name: 'Grace Hopper', address: PAYEES[1] }, amount: '2500000', reference: 'INV-1042' },
  ];
  const run = (await call(w, postPayout, 'POST', { cookie, params, body: { chain: 'tempo', lines } })).body;
  const paid = (await call(w, postPayoutExecute, 'POST', { cookie, params: { ...params, runId: run.id } })).body.run;
  return { org, cookie, params, run: paid, chain: w.tempoChain(await keyAddress(w, org.id, 'tempo_access')) };
}

const kinds = (ledger: { kind: string }[]) => [...new Set(ledger.map((entry) => entry.kind))].sort();

describe('the books', () => {
  it('state what the organisation holds and list everything that moved', async () => {
    const { cookie, params, run } = await withHistory();
    const { status, body } = await call(w, getStatement, 'GET', { cookie, params });
    expect(status).toBe(200);
    expect(body.statement).toMatchObject({
      asOf: w.clock.ms,
      range: { from: null, to: null },
      monthlyBurnUsd: 42_500,
      treasury: { zat: '5000000' },
      hedge: { shortLots: 5 },
      receipts: { zat: '5000000', count: 1 },
      payouts: { usd: 3.5, count: 2 },
      stale: [],
    });
    expect(kinds(body.ledger)).toEqual(['hedge_open', 'payout', 'receipt', 'trade_fee']);
    const payout = body.ledger.find((entry: { kind: string; ref: string }) => entry.kind === 'payout' && entry.ref === `${run.id}/2`);
    expect(payout).toMatchObject({ source: 'tempo', asset: 'AlphaUSD', decimals: 6, amount: '-2500000', usd: -2.5, counterparty: { name: 'Grace Hopper', address: PAYEES[1] }, proof: { chain: 'tempo', tx: run.tx, url: `https://explore.testnet.tempo.xyz/tx/${run.tx}` } });
  });

  it('cover the period that was asked for', async () => {
    const { cookie, params } = await withHistory();
    // Later than anything on record, the fixture's block times included.
    const from = 4_000_000_000_000;
    const later = await call(w, getStatement, 'GET', { cookie, params, query: { from: String(from) } });
    expect(later.body.ledger).toEqual([]);
    expect(later.body.statement).toMatchObject({ range: { from, to: null }, receipts: { count: 0 }, payouts: { count: 0 } });
    const earlier = await call(w, getStatement, 'GET', { cookie, params, query: { to: String(w.clock.ms) } });
    expect(kinds(earlier.body.ledger)).toEqual(['hedge_open', 'payout', 'trade_fee']);
    for (const query of [{ from: 'yesterday' }, { to: '-1' }, { format: 'xlsx' }, { range: 'all' }]) expect((await call(w, getStatement, 'GET', { cookie, params, query })).status).toBe(400);
  });

  it('are exported as a CSV ledger that a spreadsheet can open', async () => {
    const { cookie, params, run } = await withHistory();
    const answer = await call(w, getStatement, 'GET', { cookie, params, query: { format: 'csv' } });
    expect(answer.status).toBe(200);
    expect(answer.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(answer.headers.get('content-disposition')).toBe('attachment; filename="holdfast-ledger.csv"');
    expect(answer.headers.get('cache-control')).toBe('no-store');
    const rows = answer.text.trimEnd().split('\r\n');
    expect(rows[0]).toBe('id,time,source,kind,asset,amount,base_units,usd,usd_price,usd_price_time,reference,counterparty_name,counterparty_address,chain,tx,block,url,linked');
    expect(rows).toHaveLength(6);
    expect(answer.text).toContain(`"${MEMO}"`);
    expect(answer.text).toContain(`${run.id}/1,Ada Lovelace,${PAYEES[0]},tempo,${run.tx}`);
    expect((await call(w, getExport, 'GET', { cookie, params, query: { format: 'csv' } })).text).toBe(answer.text);
  });

  it('are not made up from half the records when the venue cannot be read', async () => {
    const { cookie, params } = await withHistory();
    w.venue.down = 'fetch failed';
    for (const endpoint of [getStatement, getReconciliation, getExport]) {
      const answer = await call(w, endpoint, 'GET', { cookie, params });
      expect(answer.status).toBe(503);
      expect(answer.body).toEqual({ error: 'unavailable', message: 'Hyperliquid is unavailable: fetch failed', source: 'Hyperliquid' });
    }
  });

  it('are reconciled against the chain as it is now', async () => {
    const { cookie, params, run, chain } = await withHistory();
    const { status, body } = await call(w, getReconciliation, 'GET', { cookie, params });
    expect(status).toBe(200);
    expect(body.problems.filter((problem: { severity: string }) => problem.severity === 'error')).toEqual([]);
    const matched = body.matched.filter((match: { kind: string }) => match.kind === 'payout_line');
    expect(matched).toHaveLength(2);
    expect(matched[0].refs).toContain(run.tx);
    expect(body.matched.some((match: { kind: string }) => match.kind === 'order')).toBe(true);

    chain.failing.add('memoLogs');
    const blind = await call(w, getReconciliation, 'GET', { cookie, params });
    expect(blind.status).toBe(503);
    expect(blind.body).toEqual({ error: 'unavailable', message: `Tempo is unavailable: run ${run.id} could not be looked up: memoLogs failed: fetch failed`, source: 'Tempo' });
  });

  it('report a payout the record calls paid and the chain does not hold', async () => {
    const { org, cookie, params, run } = await withHistory();
    await connection.client.query("update holdfast.payout_runs set id = 'HF-2027-01-0077' where org_id = $1", [org.id]).catch(() => undefined);
    const lines = (runId: string) => [{ payeeName: 'Nobody', toAddress: PAYEES[2], amount: 9n, memo: `${runId}/1`, reference: '' }];
    const ghost = await w.store.createPayoutRun(org.id, { chain: 'tempo', token: run.token, tokenSymbol: 'AlphaUSD', tokenDecimals: 6, account: run.account, notBefore: null, at: w.clock.ms, lines });
    await w.store.settlePayoutRun(org.id, ghost.id, { status: 'paid', tx: `0x${'ee'.repeat(32)}`, error: null, executedAt: w.clock.ms });

    const { body } = await call(w, getReconciliation, 'GET', { cookie, params });
    expect(body.problems).toContainEqual(expect.objectContaining({ kind: 'missing_transfer', severity: 'error', detail: expect.stringContaining(`run ${ghost.id}`) }));
  });

  it('are published whole in the form the verifier reads, naming the treasury by its address and never by its key', async () => {
    const { org, cookie, params, run } = await withHistory();
    const answer = await call(w, getExport, 'GET', { cookie, params });
    expect(answer.status).toBe(200);
    expect(answer.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(answer.headers.get('content-disposition')).toBe('attachment; filename="holdfast-statement.json"');
    expect(answer.text).not.toContain(UFVK);

    const published = parsePublishedStatement(answer.text);
    const treasury = checkUfvk(UFVK, 'mainnet');
    expect(published.org).toEqual({
      id: org.id,
      name: 'Acme Labs',
      zcash: { network: 'mainnet', address: treasury.ok ? treasury.address : '', birthday: 3_512_000, scannedTo: BIRTHDAY + 100 },
      hyperliquid: { account: org.hlUser, since: org.createdAt, through: w.clock.ms },
      payoutAccounts: expect.arrayContaining([{ chain: 'tempo', account: run.account, token: run.token }]),
    });
    expect(verifyChain(published.journal, ZERO_ROOT)).toEqual({ ok: true });
    expect(published.payouts).toHaveLength(1);
    expect(published.payouts[0]?.onChain).toMatchObject({ tx: run.tx, otherTxs: [] });
    expect(published.statement.treasury?.zat).toBe(5_000_000n);
    // What was published reconciles on its own, with nothing but the token facts the reader brings.
    const again = reconcile({ ledger: published.ledger, journal: published.journal, payouts: published.payouts, swaps: published.swaps, assets: { [run.token]: { symbol: 'AlphaUSD', decimals: 6, chain: 'tempo', usdPegged: true } } });
    expect(again.problems.filter((problem) => problem.severity === 'error')).toEqual([]);
  });

  it('refuse to publish a journal that quotes a secret', async () => {
    const { org, cookie, params } = await withHistory();
    w.chain.scan = async () => {
      throw new Error(`POST ${RPC_URL} failed`);
    };
    await tickOnce(w, org.id);
    const answer = await call(w, getExport, 'GET', { cookie, params });
    expect(answer.status).toBe(409);
    expect(answer.body.error).toBe('refused');
    expect(answer.body.message).toMatch(/^refusing to publish: the export would contain secret number \d+ of those it was told to keep$/);
    expect(answer.text).not.toContain(RPC_URL);
  });
});

describe('auditor links', () => {
  const scope = { from: null, to: null, modules: ['payouts'] };
  const create = (cookie: string, params: { orgId: string }, body: unknown = { label: 'Q1 audit', scope }) => call(w, postAuditLink, 'POST', { cookie, params, body });
  const open = (token: string, query: Record<string, string> = {}) => call(w, getAudit, 'GET', { params: { token }, query });

  it('are made with a scope, shown their token once, and kept only as its hash', async () => {
    const { org, cookie, params } = await withHistory();
    const { status, body } = await create(cookie, params, { label: '  Q1 audit ', scope, expiresAt: w.clock.ms + 86_400_000 });
    expect(status).toBe(201);
    expect(body.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(body.link).toEqual({ id: hashToken(body.token), label: 'Q1 audit', scope, expiresAt: w.clock.ms + 86_400_000, revokedAt: null, createdAt: w.clock.ms });

    const stored = await connection.client.query('select * from holdfast.audit_links where org_id = $1', [org.id]);
    expect(stored.rows).toHaveLength(1);
    expect(JSON.stringify(stored.rows)).not.toContain(body.token);
    const listed = await call(w, getAuditLinks, 'GET', { cookie, params });
    expect(listed.body.links).toEqual([body.link]);
    expect(listed.text).not.toContain(body.token);
  });

  it('show their holder the modules and dates of the scope, with no session, and nothing outside it', async () => {
    const { cookie, params, run } = await withHistory();
    const { token } = (await create(cookie, params)).body;
    const answer = await open(token);
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ organisation: 'Acme Labs', label: 'Q1 audit', expiresAt: null, scope });
    expect(kinds(answer.body.ledger)).toEqual(['payout']);
    expect(answer.body.ledger).toHaveLength(2);
    expect(answer.body.statement).toMatchObject({ treasury: null, hedge: null, lock: null, receipts: null, funding: null, runwayMonths: null, monthlyBurnUsd: null, payouts: { usd: 3.5, count: 2 }, series: [] });
    for (const hidden of [MEMO, 'hedge_open', '5000000', UFVK]) expect(answer.text).not.toContain(hidden);

    const csv = await open(token, { format: 'csv' });
    expect(csv.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(csv.text.trimEnd().split('\r\n')).toHaveLength(3);
    expect(csv.text).toContain(`${run.id}/1`);
    expect(csv.text).not.toContain(MEMO);
  });

  it('cut the ledger to the dates of the scope', async () => {
    const { cookie, params } = await withHistory();
    const everything = (await create(cookie, params, { label: 'All', scope: { from: null, to: null, modules: ['treasury', 'hedge', 'swaps', 'payouts'] } })).body.token;
    const whole = (await open(everything)).body;
    expect(kinds(whole.ledger)).toEqual(['hedge_open', 'payout', 'receipt', 'trade_fee']);
    expect(whole.statement.treasury).toMatchObject({ zat: '5000000' });

    const before = (await create(cookie, params, { label: 'Before', scope: { from: null, to: 1_000, modules: ['treasury', 'payouts'] } })).body.token;
    const early = (await open(before)).body;
    expect(early.ledger).toEqual([]);
    expect(early.statement).toMatchObject({ hedge: null, receipts: { count: 0 }, payouts: { count: 0 } });
  });

  it('stop working when revoked or expired, and answer then as a token nobody was given', async () => {
    const { cookie, params } = await withHistory();
    const absent = await open('A'.repeat(43));
    expect(absent.status).toBe(404);
    expect(absent.body).toEqual({ error: 'not_found', message: 'not found' });

    const revoked = (await create(cookie, params)).body;
    expect((await open(revoked.token)).status).toBe(200);
    const revocation = await call(w, deleteAuditLink, 'DELETE', { cookie, params: { ...params, linkId: revoked.link.id } });
    expect(revocation.body.link).toMatchObject({ id: revoked.link.id, revokedAt: w.clock.ms });
    expect((await open(revoked.token)).text).toBe(absent.text);
    expect((await call(w, deleteAuditLink, 'DELETE', { cookie, params: { ...params, linkId: 'f'.repeat(64) } })).status).toBe(404);

    const shortLived = (await create(cookie, params, { label: 'Short', scope, expiresAt: w.clock.ms + 60_000 })).body;
    w.clock.advance(59_999);
    expect((await open(shortLived.token)).status).toBe(200);
    w.clock.advance(1);
    expect((await open(shortLived.token)).text).toBe(absent.text);

    for (const token of ['short', `${'A'.repeat(42)}!`, revoked.link.id]) expect((await open(token)).status).toBe(404);
  });

  it('open nothing when what is stored for them is not a scope', async () => {
    const { org, cookie, params } = await withHistory();
    const { token } = (await create(cookie, params)).body;
    await connection.client.query(`update holdfast.audit_links set scope = '{"modules":"all"}' where org_id = $1`, [org.id]);
    expect((await open(token)).status).toBe(404);
    expect((await call(w, getAuditLinks, 'GET', { cookie, params })).body.links[0].scope).toBeNull();
  });

  it('are not made without a label, with a scope that covers nothing, or already expired', async () => {
    const { org, cookie, params } = await withHistory();
    const cases: unknown[] = [
      { scope },
      { label: ' ', scope },
      { label: 'x', scope: { from: null, to: null, modules: [] } },
      { label: 'x', scope: { from: null, to: null, modules: ['everything'] } },
      { label: 'x', scope: { modules: ['payouts'] } },
      { label: 'x', scope: { from: 2_000, to: 1_000, modules: ['payouts'] } },
      { label: 'x', scope, expiresAt: w.clock.ms },
      { label: 'x', scope, orgId: 'another' },
    ];
    for (const body of cases) expect((await create(cookie, params, body)).status, JSON.stringify(body)).toBe(400);
    expect(await w.store.listAuditLinks(org.id)).toEqual([]);
  });

  it('are unavailable to their holder when the books cannot be built', async () => {
    const { cookie, params } = await withHistory();
    const { token } = (await create(cookie, params)).body;
    w.venue.down = 'fetch failed';
    const answer = await open(token);
    expect(answer.status).toBe(503);
    expect(answer.body.error).toBe('unavailable');
    expect(answer.body.ledger).toBeUndefined();
  });
});

describe('books and auditor links', () => {
  it('are for the owner alone, the auditor’s own view apart', async () => {
    const { org, cookie, params } = await withHistory();
    const link = (await call(w, postAuditLink, 'POST', { cookie, params, body: { label: 'Kept', scope: { from: null, to: null, modules: ['payouts'] } } })).body;
    await expectOwnerOnly(
      w,
      org.id,
      [
        { name: 'statement', endpoint: getStatement, method: 'GET' },
        { name: 'reconciliation', endpoint: getReconciliation, method: 'GET' },
        { name: 'export', endpoint: getExport, method: 'GET' },
        { name: 'links', endpoint: getAuditLinks, method: 'GET' },
        { name: 'create link', endpoint: postAuditLink, method: 'POST', body: { label: 'Theirs', scope: { from: null, to: null, modules: ['treasury'] } } },
        { name: 'revoke link', endpoint: deleteAuditLink, method: 'DELETE', params: { linkId: link.link.id } },
      ],
      async () => expect((await w.store.listAuditLinks(org.id)).map((row) => [row.label, row.revokedAt])).toEqual([['Kept', null]]),
    );
    expect((await call(w, getAudit, 'GET', { params: { token: link.token } })).status).toBe(200);
  });
});
