import type { OrgRecord, PgliteConnection } from '@holdfast/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { postPayout, postPayoutExecute } from '../../src/server/api/payouts';
import { auditView, createLink, revokeLink } from '../../src/server/books/audit-links';
import { ApiError } from '../../src/server/errors';
import { RECONCILIATION_CHECKS, auditPage } from '../../src/server/pages/books';
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

const EVERY = ['treasury', 'hedge', 'swaps', 'payouts'] as const;

/** An organisation with a grant received, the lock opened by two ticks and one payout run of two lines paid on Tempo. */
async function withHistory(): Promise<{ org: OrgRecord; accessKey: string }> {
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
  return { org, accessKey: await keyAddress(w, org.id, 'tempo_access') };
}

const link = (org: OrgRecord, scope: { from: number | null; to: number | null; modules: readonly string[] }, expiresAt: number | null = null) =>
  createLink(w.deps, org.id, { label: 'Q1 audit', scope, expiresAt });

async function refusalOf(token: string): Promise<unknown> {
  return auditPage(w.deps, token).catch((error: unknown) => error);
}

describe('what an auditor link opens on its page', () => {
  it('is the scoped statement and ledger the link’s route answers with, and every check for a link that covers everything', async () => {
    const { org } = await withHistory();
    const { token } = await link(org, { from: null, to: null, modules: EVERY });
    const page = await auditPage(w.deps, token);
    const view = await auditView(w.deps, token);

    const { checks, reconciliation, ...shared } = page;
    expect(shared).toEqual(view);
    expect(checks).toEqual([...RECONCILIATION_CHECKS]);
    expect(reconciliation).toMatchObject({ status: 'ok' });
    if (reconciliation?.status !== 'ok') return;
    expect(reconciliation.value.map((check) => check.id)).toEqual([...RECONCILIATION_CHECKS]);
    expect(reconciliation.value.find((check) => check.id === 'payouts')?.matched).toHaveLength(2);
  });

  it('shows a narrower link the checks of its own modules and nothing found by the others', async () => {
    const { org } = await withHistory();
    const { token } = await link(org, { from: null, to: null, modules: ['payouts'] });
    const page = await auditPage(w.deps, token);

    expect(page.scope.modules).toEqual(['payouts']);
    expect(page.ledger.every((entry) => entry.kind === 'payout')).toBe(true);
    expect(page.statement.treasury).toBeNull();
    expect(page.checks).toEqual(['payouts']);
    expect(page.reconciliation).toMatchObject({ status: 'ok' });
    if (page.reconciliation?.status !== 'ok') return;
    expect(page.reconciliation.value.map((check) => check.id)).toEqual(['payouts']);
    // Nothing of the orders or the balances reaches the holder of a payouts link.
    expect(JSON.stringify(page.reconciliation.value)).not.toContain('journal:');
  });

  it('runs no check for a link whose dates leave records out, so that none can name what the link does not show', async () => {
    const { org, accessKey } = await withHistory();
    const { token } = await link(org, { from: 1, to: null, modules: EVERY });
    // Were a check run, this chain would be asked and would fail.
    w.tempoChain(accessKey).failing.add('memoLogs');
    const page = await auditPage(w.deps, token);

    expect(page.checks).toEqual([]);
    expect(page.reconciliation).toBeNull();
    expect(page.ledger.length).toBeGreaterThan(0);
  });

  it('says that the reconciliation is unavailable when a chain it needs cannot be read', async () => {
    const { org, accessKey } = await withHistory();
    const { token } = await link(org, { from: null, to: null, modules: ['payouts'] });
    w.tempoChain(accessKey).failing.add('memoLogs');
    const page = await auditPage(w.deps, token);

    expect(page.reconciliation).toMatchObject({ status: 'unavailable', source: 'Tempo' });
    expect(page.ledger.length).toBeGreaterThan(0);
  });

  it('opens nothing, and says the same nothing, for a token that is unknown, revoked, expired or without a readable scope', async () => {
    const { org } = await withHistory();
    const unknown = await refusalOf('A'.repeat(43));

    const revoked = await link(org, { from: null, to: null, modules: EVERY });
    await revokeLink(w.deps, org.id, revoked.link.id);

    const expiring = await link(org, { from: null, to: null, modules: EVERY }, w.clock.ms + 60_000);
    expect((await auditPage(w.deps, expiring.token)).organisation).toBe('Acme Labs');
    w.clock.advance(120_000);

    const unreadable = await link(org, { from: null, to: null, modules: EVERY });
    await connection.client.query(`update holdfast.audit_links set scope = '{"modules":"all"}' where token_hash = $1`, [unreadable.link.id]);

    for (const refusal of [unknown, await refusalOf(revoked.token), await refusalOf(expiring.token), await refusalOf(unreadable.token)]) {
      expect(refusal).toBeInstanceOf(ApiError);
      expect(refusal).toMatchObject({ status: 404, code: 'not_found', message: 'not found', details: {} });
    }
  });
});
