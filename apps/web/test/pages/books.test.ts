import type { Reconciliation } from '@holdfast/books';
import type { OrgRecord, PgliteConnection } from '@holdfast/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { postPayout, postPayoutExecute } from '../../src/server/api/payouts';
import { ApiError } from '../../src/server/errors';
import { RECONCILIATION_CHECKS, booksPage, checksInScope, checksOf, demoBooksPage } from '../../src/server/pages/books';
import { BIRTHDAY, PAYEES, STARTUP_TIMEOUT_MS, type World, call, keyAddress, migratedPglite, newAccount, note, organisation, sessionOf, tickOnce, world } from '../support/world';

let connection: PgliteConnection;
let w: World;

beforeAll(async () => {
  connection = await migratedPglite();
}, STARTUP_TIMEOUT_MS);

afterAll(() => connection.close());

beforeEach(() => {
  w = world(connection);
});

const ALL_TIME = { from: null, to: null };

/** An organisation with a grant received, the lock opened by two ticks and one payout run of two lines paid on Tempo. */
async function withHistory(): Promise<{ org: OrgRecord; runId: string; accessKey: string }> {
  const owner = newAccount();
  const created = await organisation(w, owner.address);
  const cookie = await sessionOf(w, owner.address);
  const params = { orgId: created.id };
  await w.store.updateOrg(created.id, { lockEnabled: true });
  w.chain.notes = [note(BIRTHDAY + 10, 5_000_000n, { memo: 'ZCG grant, milestone 2 of 4' })];
  await tickOnce(w, created.id);
  await tickOnce(w, created.id);
  const lines = [
    { payee: { name: 'Ada Lovelace', address: PAYEES[0] }, amount: '1000000', reference: 'INV-1041' },
    { payee: { name: 'Grace Hopper', address: PAYEES[1] }, amount: '2500000', reference: 'INV-1042' },
  ];
  const run = (await call(w, postPayout, 'POST', { cookie, params, body: { chain: 'tempo', lines } })).body;
  await call(w, postPayoutExecute, 'POST', { cookie, params: { ...params, runId: run.id } });
  const org = await w.store.findOrg(created.id);
  if (org === null) throw new Error('the organisation was not stored');
  return { org, runId: run.id, accessKey: await keyAddress(w, org.id, 'tempo_access') };
}

describe('the books a page reads', () => {
  it('hold the statement, the ledger and every check of the reconciliation, read at one moment', async () => {
    const { org } = await withHistory();
    const page = await booksPage(w.deps, org, ALL_TIME);

    expect(page.statement).toMatchObject({ asOf: w.clock.ms, range: ALL_TIME, treasury: { zat: 5_000_000n }, payouts: { usd: 3.5, count: 2 } });
    expect(page.entries).toBe(page.ledger.length);
    expect([...new Set(page.ledger.map((entry) => entry.kind))].sort()).toEqual(['hedge_open', 'payout', 'receipt', 'trade_fee']);
    expect(page.months).toEqual([...page.months].sort());
    expect(page.months.every((month) => /^\d{4}-\d{2}$/.test(month))).toBe(true);

    expect(page.reconciliation.status).toBe('ok');
    if (page.reconciliation.status !== 'ok') return;
    expect(page.reconciliation.readAt).toBe(w.clock.ms);
    expect(page.reconciliation.value.map((check) => check.id)).toEqual([...RECONCILIATION_CHECKS]);
    const byId = Object.fromEntries(page.reconciliation.value.map((check) => [check.id, check]));
    expect(byId.payouts?.matched).toHaveLength(2);
    expect(byId.orders?.matched.length).toBeGreaterThan(0);
    expect(byId.balances?.matched.length).toBeGreaterThan(0);
    expect(byId.swaps).toMatchObject({ matched: [], problems: [] });
    expect(page.reconciliation.value.flatMap((check) => check.problems).filter((problem) => problem.severity === 'error')).toEqual([]);
  });

  it('cut the ledger and the flow figures to the period, and leave the reconciliation whole', async () => {
    const { org } = await withHistory();
    const whole = await booksPage(w.deps, org, ALL_TIME);
    // Later than anything on record, the fixture's block times included.
    const later = await booksPage(w.deps, org, { from: 4_000_000_000_000, to: null });

    expect(later.ledger).toEqual([]);
    expect(later.entries).toBe(whole.entries);
    expect(later.months).toEqual(whole.months);
    expect(later.statement).toMatchObject({ receipts: { count: 0 }, payouts: { count: 0 } });
    // A balance is the sum of everything before it, whatever period the flows are shown for.
    expect(later.statement.treasury).toMatchObject({ zat: 5_000_000n });
    expect(later.reconciliation).toMatchObject({ status: 'ok', value: whole.reconciliation.status === 'ok' ? whole.reconciliation.value : [] });
  });

  it('say that there is no reconciliation, and why, when a payout chain cannot be read', async () => {
    const { org, runId, accessKey } = await withHistory();
    w.tempoChain(accessKey).failing.add('memoLogs');
    const page = await booksPage(w.deps, org, ALL_TIME);

    expect(page.reconciliation).toEqual({ status: 'unavailable', source: 'Tempo', readAt: w.clock.ms, reason: `run ${runId} could not be looked up: memoLogs failed: fetch failed` });
    // The statement and the ledger do not depend on that chain.
    expect(page.statement.payouts).toMatchObject({ count: 2 });
    expect(page.ledger.length).toBeGreaterThan(0);
  });

  it('are shown without a reconciliation when a payout chain does not answer in time', async () => {
    const { org } = await withHistory();
    const never = new Promise<never>(() => undefined);
    const deps = { ...w.deps, tempo: { ...w.deps.tempo, rail: (key: Parameters<typeof w.deps.tempo.rail>[0]) => ({ ...w.deps.tempo.rail(key), findRun: () => never }) } };
    const page = await booksPage(deps, org, ALL_TIME, { reconciliationPatienceMs: 50 });

    expect(page.reconciliation).toEqual({ status: 'unavailable', source: 'records and chains', readAt: w.clock.ms, reason: 'the payout chains did not answer within 0.05 s' });
    expect(page.statement.payouts).toMatchObject({ count: 2 });
    expect(page.ledger.length).toBeGreaterThan(0);
  });

  it('are not made up from half the records when the venue cannot be read', async () => {
    const { org } = await withHistory();
    w.venue.down = 'fetch failed';
    await expect(booksPage(w.deps, org, ALL_TIME)).rejects.toMatchObject({ code: 'unavailable', details: { source: 'Hyperliquid' } });
  });
});

describe('the books of a public demo', () => {
  it('do not exist for an organisation that has not chosen to be one', async () => {
    const { org } = await withHistory();
    const refusal = await demoBooksPage(w.deps, org, ALL_TIME).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(ApiError);
    expect(refusal).toMatchObject({ status: 404 });
  });

  it('keep every amount, memo and transaction, and name no payee', async () => {
    const { org } = await withHistory();
    await w.store.updateOrg(org.id, { publicDemo: true });
    const demo = { ...org, publicDemo: true };
    const owned = await booksPage(w.deps, demo, ALL_TIME);
    const shown = await demoBooksPage(w.deps, demo, ALL_TIME);

    expect(owned.statement.payouts?.byPayee.map((payee) => payee.payee)).toEqual(['Ada Lovelace', 'Grace Hopper']);
    expect(shown.statement.payouts).toMatchObject({ usd: 3.5, count: 2, byPayee: [] });
    // The runway is public for a demo, and so is the burn it is worked out from: the two are shown together or not at all.
    expect(shown.statement.monthlyBurnUsd).toBe(owned.statement.monthlyBurnUsd);
    expect(shown.statement.runwayMonths).toBe(owned.statement.runwayMonths);

    const payouts = shown.ledger.filter((entry) => entry.kind === 'payout');
    expect(payouts).toHaveLength(2);
    for (const payout of payouts) {
      expect(payout.counterparty).toBeNull();
      expect(payout.proof.tx).not.toBeNull();
    }
    expect(payouts.map((payout) => payout.amount)).toEqual(owned.ledger.filter((entry) => entry.kind === 'payout').map((payout) => payout.amount));
    expect(JSON.stringify(shown.ledger, (_key, value: unknown) => (typeof value === 'bigint' ? value.toString() : value))).not.toMatch(/Ada Lovelace|Grace Hopper/);
    // Everything that is not a payout is shown as the owner sees it.
    expect(shown.ledger.filter((entry) => entry.kind !== 'payout')).toEqual(owned.ledger.filter((entry) => entry.kind !== 'payout'));
  });
});

describe('the checks of a reconciliation', () => {
  const reconciliation: Reconciliation = {
    matched: [
      { kind: 'payout_line', refs: ['payout:HF-1:1', '0xaa'] },
      { kind: 'payout_line', refs: ['payout:HF-1:2', '0xaa'] },
      { kind: 'order', refs: ['journal:2', 'hl:fill:1'] },
      { kind: 'balance', refs: ['journal:1', 'journal:9'] },
    ],
    problems: [
      { kind: 'run_unsettled', severity: 'warning', detail: 'run HF-2 was sent and is not on chain yet', refs: ['run:HF-2'] },
      { kind: 'swap_arrival_missing', severity: 'error', detail: 'swap s1 is complete but records no arrival', refs: ['swap:s1'] },
      { kind: 'malformed_entry', severity: 'error', detail: 'ledger entry x has no time', refs: ['x'] },
    ],
  };

  it('are always the same five, in the same order, each with what it found', () => {
    const checks = checksOf(reconciliation);
    expect(checks.map((check) => [check.id, check.matched.length, check.problems.map((problem) => problem.kind)])).toEqual([
      ['payouts', 2, ['run_unsettled']],
      ['swaps', 0, ['swap_arrival_missing']],
      ['orders', 1, []],
      ['balances', 1, []],
      ['records', 0, ['malformed_entry']],
    ]);
    expect(checksOf({ matched: [], problems: [] }).map((check) => check.id)).toEqual([...RECONCILIATION_CHECKS]);
  });

  it('are shown to an auditor only where the scope covers every record the check reads', () => {
    const now = 1_800_000_000_000;
    const every = ['treasury', 'hedge', 'swaps', 'payouts'] as const;
    expect(checksInScope({ from: null, to: null, modules: every }, now)).toEqual([...RECONCILIATION_CHECKS]);
    expect(checksInScope({ from: null, to: null, modules: ['payouts'] }, now)).toEqual(['payouts']);
    expect(checksInScope({ from: null, to: null, modules: ['hedge'] }, now)).toEqual(['orders']);
    // A swap is held against a treasury payment, so the swaps module alone does not show its check.
    expect(checksInScope({ from: null, to: null, modules: ['swaps'] }, now)).toEqual([]);
    expect(checksInScope({ from: null, to: null, modules: ['treasury', 'swaps'] }, now)).toEqual(['swaps', 'balances']);
    // A date that leaves a record out hides every check: its findings would name what the scope does not show.
    expect(checksInScope({ from: 1, to: null, modules: every }, now)).toEqual([]);
    expect(checksInScope({ from: null, to: now - 1, modules: every }, now)).toEqual([]);
    expect(checksInScope({ from: null, to: now, modules: every }, now)).toEqual([...RECONCILIATION_CHECKS]);
    expect(checksInScope({ from: null, to: null, modules: [] }, now)).toEqual([]);
  });
});
