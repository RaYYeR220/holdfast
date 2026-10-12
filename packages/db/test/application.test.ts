import type { Hex } from '@holdfast/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type NewAttestation, type NewPayoutLine, type NewSwap, type PgliteConnection, type TreasuryOpening, runIdOf, runIdPrefix, runNumberOf } from '../src';
import { Clock } from './support/fakes';
import { ORG, STARTUP_TIMEOUT_MS, migratedPglite, pgStore, pgUnderTest } from './support/stores';

let connection: PgliteConnection;

beforeAll(async () => {
  connection = await migratedPglite();
}, STARTUP_TIMEOUT_MS);

afterAll(() => connection.close());

const rowsOf = async <T>(query: string, params: unknown[]): Promise<T[]> => (await connection.client.query<T>(query, params)).rows;

/** A store on a clock the test moves, and one organisation in it. */
const setup = async () => {
  const clock = new Clock();
  const under = pgUnderTest(connection.db, { clockForTests: clock.now });
  return { ...under, clock, org: await under.addOrg() };
};

const OCTOBER = Date.parse('2026-10-11T09:00:00Z');
const NOVEMBER = Date.parse('2026-11-01T00:00:00Z');

const line = (amount: bigint, over: Partial<NewPayoutLine> = {}): NewPayoutLine => ({
  payeeName: 'Ada Lovelace',
  toAddress: '0x3c71213434d56CC8ACDe9Fb1c6b3d4920e40E19A',
  amount,
  memo: 'INV-1041',
  reference: 'INV-1041',
  ...over,
});

const draft = (at = OCTOBER, lines: readonly NewPayoutLine[] = [line(1_000_000n), line(2_500_000n, { payeeName: 'Grace Hopper', memo: 'INV-1042' })]) => ({
  chain: 'tempo' as const,
  token: '0x20c0000000000000000000000000000000000001',
  tokenSymbol: 'AlphaUSD',
  tokenDecimals: 6,
  account: '0xAccount',
  notBefore: null,
  at,
  lines: (runId: string) => lines.map((l, i) => ({ ...l, memo: `${runId}/${i + 1}` })),
});

let deposits = 0;
const swap = (over: Partial<NewSwap> = {}): NewSwap => ({
  purpose: 'margin',
  originAsset: 'nep141:zec.omft.near',
  destinationAsset: '1cs_v1:hypercore:hip1:0x6d1e7cde53ba9467b783cb7c530ce054',
  amountIn: 250_000_000n,
  minAmountOut: 3_000_000_000n,
  depositAddress: `t1deposit${++deposits}`,
  recipient: '0xabc',
  quote: { amountOut: 3_050_000_000n, signature: 'ed25519:sig' },
  state: 'PENDING_DEPOSIT',
  ...over,
});

describe('organisations, as the application reads them', () => {
  it('are read without the viewing key and without the lease', async () => {
    const { store, clock } = await setup();
    await store.createOrg({ id: 'acme-record', name: 'Acme Labs', ...ORG, monthlyBurnUsd: 42_500, tempoAccount: '0xTempo', solanaOwner: 'So1ana' });
    const record = await store.findOrg('acme-record');
    expect(record).toEqual({
      id: 'acme-record',
      name: 'Acme Labs',
      createdAt: clock.ms,
      hlUser: ORG.hlUser,
      birthday: ORG.birthday,
      scannedTo: null,
      policy: ORG.policy,
      lockEnabled: true,
      nextSeq: 1,
      lastDigest: `0x${'00'.repeat(32)}`,
      monthlyBurnUsd: 42_500,
      publicDemo: false,
      tempoAccount: '0xTempo',
      solanaOwner: 'So1ana',
    });
    expect(JSON.stringify(record)).not.toContain(ORG.ufvk);
  });

  it('answer null for an id nobody has', async () => {
    const { store } = await setup();
    expect(await store.findOrg('nobody')).toBeNull();
  });

  it('are found by the account that owns them, whatever its case', async () => {
    const { store } = await setup();
    const owner = '0xAbCdEf0000000000000000000000000000000101';
    await store.createOrg({ id: 'owned-1', name: 'One', ...ORG, hlUser: owner });
    await store.createOrg({ id: 'owned-2', name: 'Two', ...ORG, hlUser: owner.toLowerCase() });
    await store.createOrg({ id: 'owned-by-another', name: 'Three', ...ORG, hlUser: '0xabcdef0000000000000000000000000000000102' });

    expect((await store.listOrgs({ owner: owner.toUpperCase().replace('0X', '0x') })).map((o) => o.id)).toEqual(['owned-1', 'owned-2']);
    expect(await store.listOrgs({ owner: '0x0000000000000000000000000000000000000999' })).toEqual([]);
  });

  it('are listed for the public demo only when they were marked for it', async () => {
    const { store, org } = await setup();
    await store.createOrg({ id: 'shown', name: 'Shown', ...ORG, publicDemo: true });
    const shown = (await store.listOrgs({ publicDemo: true })).map((o) => o.id);
    expect(shown).toContain('shown');
    expect(shown).not.toContain(org);
  });

  it('take their payout accounts, and give them up again', async () => {
    const { store, org } = await setup();
    expect(await store.findOrg(org)).toMatchObject({ tempoAccount: null, solanaOwner: null });
    await store.updateOrg(org, { tempoAccount: '0xTempo', solanaOwner: 'So1ana' });
    expect(await store.findOrg(org)).toMatchObject({ tempoAccount: '0xTempo', solanaOwner: 'So1ana' });
    await store.updateOrg(org, { solanaOwner: null });
    expect(await store.findOrg(org)).toMatchObject({ tempoAccount: '0xTempo', solanaOwner: null });
  });
});

describe('service keys', () => {
  const agent = { kind: 'hl_agent' as const, address: '0xagent1', secret: '0xsecret-of-agent-1' };
  const access = { kind: 'tempo_access' as const, address: '0xaccess1', secret: '0xsecret-of-access-1' };

  it('are written with the organisation, or not at all', async () => {
    const { store } = await setup();
    await store.createOrg({ id: 'with-keys', name: 'With Keys', ...ORG }, [agent, access]);
    expect((await store.listKeys('with-keys')).map((k) => [k.kind, k.address, k.status])).toEqual([
      ['hl_agent', '0xagent1', 'active'],
      ['tempo_access', '0xaccess1', 'active'],
    ]);

    await expect(store.createOrg({ id: 'half-made', name: 'Half', ...ORG }, [agent, { ...agent, kind: 'bogus' as never }])).rejects.toThrow();
    expect(await store.findOrg('half-made')).toBeNull();
    expect(await store.listKeys('half-made')).toEqual([]);
  });

  it('keep the secret encrypted, readable only under the master key and only from its own row', async () => {
    const { store, org, addOrg } = await setup();
    await store.installKey(org, agent);
    const [row] = await rowsOf<{ secret_enc: string }>('select secret_enc from holdfast.keys where org_id = $1', [org]);
    expect(row?.secret_enc).toMatch(/^v1\./);
    expect(row?.secret_enc).not.toContain(agent.secret);
    expect(await store.activeKey(org, 'hl_agent')).toEqual({ address: agent.address, secret: agent.secret });

    const stranger = pgStore(connection.db, { masterKey: new Uint8Array(32).fill(9) });
    await expect(stranger.activeKey(org, 'hl_agent')).rejects.toThrow('the secret could not be decrypted');

    const other = await addOrg();
    await connection.client.query("insert into holdfast.keys (org_id, kind, address, secret_enc, status) values ($1, 'hl_agent', $2, $3, 'active')", [other, agent.address, row?.secret_enc]);
    await expect(store.activeKey(other, 'hl_agent')).rejects.toThrow('the secret could not be decrypted');
  });

  it('are listed without their secrets', async () => {
    const { store, org, clock } = await setup();
    await store.installKey(org, agent);
    const listed = await store.listKeys(org);
    expect(listed).toEqual([{ kind: 'hl_agent', address: agent.address, status: 'active', createdAt: clock.ms, revokedAt: null }]);
    expect(JSON.stringify(listed)).not.toContain('secret');
  });

  it('are installed once however often that is asked', async () => {
    const { store, org } = await setup();
    expect(await store.installKey(org, agent)).toBe(true);
    expect(await store.installKey(org, agent)).toBe(false);
    expect(await store.listKeys(org)).toHaveLength(1);
  });

  it('give way to a new key of their kind, and cannot come back', async () => {
    const { store, org, clock } = await setup();
    await store.installKey(org, agent);
    await store.installKey(org, access);
    clock.advance(60_000);
    const next = { ...agent, address: '0xagent2', secret: '0xsecret-of-agent-2' };
    expect(await store.installKey(org, next)).toBe(true);

    expect(await store.activeKey(org, 'hl_agent')).toEqual({ address: next.address, secret: next.secret });
    expect(await store.activeKey(org, 'tempo_access')).toMatchObject({ address: access.address });
    expect(await store.listKeys(org)).toEqual([
      { kind: 'hl_agent', address: '0xagent2', status: 'active', createdAt: clock.ms, revokedAt: null },
      { kind: 'hl_agent', address: '0xagent1', status: 'revoked', createdAt: clock.ms - 60_000, revokedAt: clock.ms },
      { kind: 'tempo_access', address: '0xaccess1', status: 'active', createdAt: clock.ms - 60_000, revokedAt: null },
    ]);
    await expect(store.installKey(org, agent)).rejects.toThrow('was revoked and cannot be installed again');
  });

  it('are null for a kind the organisation has no key of, and refused for an organisation nobody has', async () => {
    const { store, org } = await setup();
    expect(await store.activeKey(org, 'solana_delegate')).toBeNull();
    await expect(store.installKey('nobody', agent)).rejects.toThrow('unknown organisation nobody');
  });
});

describe('sign-in challenges', () => {
  it('can be used once, and only once', async () => {
    const { store, clock } = await setup();
    expect(await store.issueNonce('nonce-once', 600_000)).toBe(clock.ms + 600_000);
    expect(await store.consumeNonce('nonce-once')).toBe(true);
    expect(await store.consumeNonce('nonce-once')).toBe(false);
  });

  it('cannot be used once they have run out, nor on the dot', async () => {
    const { store, clock } = await setup();
    await store.issueNonce('nonce-late', 1_000);
    clock.advance(1_000);
    expect(await store.consumeNonce('nonce-late')).toBe(false);

    await store.issueNonce('nonce-in-time', 1_000);
    clock.advance(999);
    expect(await store.consumeNonce('nonce-in-time')).toBe(true);
  });

  it('were never issued unless the store issued them', async () => {
    const { store } = await setup();
    expect(await store.consumeNonce('never-issued')).toBe(false);
  });

  it('are swept once they have run out, when the next one is issued', async () => {
    const { store, clock } = await setup();
    await store.issueNonce('nonce-stale', 1_000);
    await store.issueNonce('nonce-fresh', 60_000);
    clock.advance(5_000);
    await store.issueNonce('nonce-next', 60_000);
    const kept = (await rowsOf<{ nonce: string }>("select nonce from holdfast.auth_nonces where nonce in ('nonce-stale', 'nonce-fresh', 'nonce-next') order by nonce", [])).map((r) => r.nonce);
    expect(kept).toEqual(['nonce-fresh', 'nonce-next']);
  });

  it('are refused the same value twice, and a life that is not a positive whole number of milliseconds', async () => {
    const { store } = await setup();
    await store.issueNonce('nonce-twice', 60_000);
    await expect(store.issueNonce('nonce-twice', 60_000)).rejects.toThrow();
    for (const ttl of [0, -1, 1.5]) await expect(store.issueNonce('nonce-ttl', ttl)).rejects.toThrow('positive number of milliseconds');
  });
});

describe('swaps', () => {
  it('are recorded as quoted and read back with their amounts intact', async () => {
    const { store, org, clock } = await setup();
    const quoted = swap();
    const row = await store.recordSwap(org, quoted);
    expect(row).toEqual({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      orgId: org,
      purpose: 'margin',
      originAsset: quoted.originAsset,
      destinationAsset: quoted.destinationAsset,
      amountIn: 250_000_000n,
      minAmountOut: 3_000_000_000n,
      amountOut: null,
      depositAddress: quoted.depositAddress,
      recipient: '0xabc',
      state: 'PENDING_DEPOSIT',
      originTxs: [],
      destinationTxs: [],
      createdAt: clock.ms,
      updatedAt: clock.ms,
    });
    expect(await store.findSwap(org, row.id)).toEqual(row);
    const [kept] = await rowsOf<{ quote: unknown }>('select quote from holdfast.swaps where id = $1', [row.id]);
    expect(kept?.quote).toEqual({ amountOut: { $bigint: '3050000000' }, signature: 'ed25519:sig' });
  });

  it('are one row per deposit address, however often the quote is recorded', async () => {
    const { store, org, addOrg } = await setup();
    const quoted = swap();
    const first = await store.recordSwap(org, quoted);
    expect(await store.recordSwap(org, { ...quoted, state: 'PROCESSING' })).toEqual(first);
    expect(await store.listSwaps(org)).toEqual([first]);

    const other = await addOrg();
    await expect(store.recordSwap(other, quoted)).rejects.toThrow('already belongs to another swap');
  });

  it('belong to one organisation and are not found from another, nor under an id that is no id', async () => {
    const { store, org, addOrg } = await setup();
    const row = await store.recordSwap(org, swap());
    const other = await addOrg();
    expect(await store.findSwap(other, row.id)).toBeNull();
    expect(await store.findSwap(org, 'not-a-uuid')).toBeNull();
    expect(await store.updateSwap(other, row.id, { state: 'SUCCESS', originTxs: [], destinationTxs: [], amountOut: 1n })).toBeNull();
    expect(await store.findSwap(org, row.id)).toMatchObject({ state: 'PENDING_DEPOSIT' });
  });

  it('take what the swap service says until it says the swap is over', async () => {
    const { store, org, clock } = await setup();
    const row = await store.recordSwap(org, swap());
    clock.advance(30_000);
    expect(await store.updateSwap(org, row.id, { state: 'PROCESSING', originTxs: ['zec-tx'], destinationTxs: [], amountOut: null })).toEqual({
      ...row,
      state: 'PROCESSING',
      originTxs: ['zec-tx'],
      updatedAt: clock.ms,
    });
    clock.advance(30_000);
    const done = await store.updateSwap(org, row.id, { state: 'SUCCESS', originTxs: ['zec-tx'], destinationTxs: ['hl-tx'], amountOut: 3_040_000_000n });
    expect(done).toMatchObject({ state: 'SUCCESS', destinationTxs: ['hl-tx'], amountOut: 3_040_000_000n, updatedAt: clock.ms });

    clock.advance(30_000);
    expect(await store.updateSwap(org, row.id, { state: 'PROCESSING', originTxs: [], destinationTxs: [], amountOut: null })).toEqual(done);
  });

  it('are listed newest first, and for refreshing the one looked at longest ago first', async () => {
    const { store, org, clock } = await setup();
    const first = await store.recordSwap(org, swap());
    clock.advance(1_000);
    const second = await store.recordSwap(org, swap({ purpose: 'payout_float' }));
    clock.advance(1_000);
    const settled = await store.recordSwap(org, swap());
    await store.updateSwap(org, settled.id, { state: 'REFUNDED', originTxs: ['zec-tx'], destinationTxs: [], amountOut: null });
    await store.updateSwap(org, first.id, { state: 'PROCESSING', originTxs: ['zec-tx'], destinationTxs: [], amountOut: null });

    expect((await store.listSwaps(org)).map((s) => s.id)).toEqual([settled.id, second.id, first.id]);
    const open = (await store.unsettledSwaps(1_000)).filter((s) => s.orgId === org).map((s) => s.id);
    expect(open).toEqual([second.id, first.id]);
  });
});

describe('run ids', () => {
  it('carry the UTC month and a number within it', () => {
    expect(runIdPrefix(OCTOBER)).toBe('HF-2026-10-');
    expect(runIdPrefix(Date.parse('2026-10-31T23:59:59.999Z'))).toBe('HF-2026-10-');
    expect(runIdPrefix(NOVEMBER)).toBe('HF-2026-11-');
    expect(runIdOf(OCTOBER, 1)).toBe('HF-2026-10-0001');
    expect(runIdOf(OCTOBER, 9_999)).toBe('HF-2026-10-9999');
    expect(runNumberOf('HF-2026-10-0042')).toBe(42);
  });

  it('are refused outside what the form can carry', () => {
    for (const number of [0, 10_000, 1.5, -1]) expect(() => runIdOf(OCTOBER, number)).toThrow('a month has room for runs 1 to 9999');
    expect(() => runIdPrefix(Number.NaN)).toThrow('not a moment in time');
    for (const text of ['HF-2026-10-1', 'HF-2026-10-00001', 'hf-2026-10-0001', 'HF-2026-10-0001/1', '']) expect(runNumberOf(text)).toBeNull();
  });
});

describe('payout runs', () => {
  it('are numbered within their month, for each organisation on its own', async () => {
    const { store, org, addOrg } = await setup();
    const other = await addOrg();
    expect((await store.createPayoutRun(org, draft())).id).toBe('HF-2026-10-0001');
    expect((await store.createPayoutRun(org, draft())).id).toBe('HF-2026-10-0002');
    expect((await store.createPayoutRun(other, draft())).id).toBe('HF-2026-10-0001');
    expect((await store.createPayoutRun(org, draft(NOVEMBER))).id).toBe('HF-2026-11-0001');
    expect((await store.createPayoutRun(org, draft())).id).toBe('HF-2026-10-0003');
  });

  it('get different numbers when several are created at once', async () => {
    const { store, org } = await setup();
    const created = await Promise.all(Array.from({ length: 6 }, () => store.createPayoutRun(org, draft())));
    expect(created.map((run) => run.id).sort()).toEqual([1, 2, 3, 4, 5, 6].map((n) => runIdOf(OCTOBER, n)));
  });

  it('start as drafts with their lines in order, a total, and a receipt token on every line', async () => {
    const { store, org } = await setup();
    const run = await store.createPayoutRun(org, { ...draft(), chain: 'solana', notBefore: 412_000_111n });
    expect(run).toEqual({
      id: 'HF-2026-10-0001',
      orgId: org,
      chain: 'solana',
      token: '0x20c0000000000000000000000000000000000001',
      tokenSymbol: 'AlphaUSD',
      tokenDecimals: 6,
      account: '0xAccount',
      notBefore: 412_000_111n,
      status: 'draft',
      total: 3_500_000n,
      tx: null,
      error: null,
      createdAt: OCTOBER,
      executedAt: null,
      lines: [
        expect.objectContaining({ lineNo: 1, payeeName: 'Ada Lovelace', amount: 1_000_000n, memo: 'HF-2026-10-0001/1', reference: 'INV-1041', tx: null, logIndex: null, reconciled: false }),
        expect.objectContaining({ lineNo: 2, payeeName: 'Grace Hopper', amount: 2_500_000n, memo: 'HF-2026-10-0001/2', reference: 'INV-1041' }),
      ],
    });
    const tokens = run.lines.map((l) => l.receiptToken ?? '');
    for (const token of tokens) expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(new Set(tokens).size).toBe(2);
    expect(await store.findPayoutRun(org, run.id)).toEqual(run);
  });

  it('are not created without lines, with a line that pays nothing, or for an organisation nobody has', async () => {
    const { store, org } = await setup();
    await expect(store.createPayoutRun(org, draft(OCTOBER, []))).rejects.toThrow('has no lines');
    await expect(store.createPayoutRun(org, draft(OCTOBER, [line(0n)]))).rejects.toThrow('must pay a positive amount');
    await expect(store.createPayoutRun('nobody', draft())).rejects.toThrow('unknown organisation nobody');
    expect(await store.listPayoutRuns(org)).toEqual([]);
    expect((await store.createPayoutRun(org, draft())).id).toBe('HF-2026-10-0001');
  });

  it('are listed newest first, each with its own lines, and only to their organisation', async () => {
    const { store, org, addOrg } = await setup();
    const other = await addOrg();
    const first = await store.createPayoutRun(org, draft(OCTOBER));
    const second = await store.createPayoutRun(org, draft(OCTOBER + 1_000, [line(7n)]));
    await store.createPayoutRun(other, draft());

    expect(await store.listPayoutRuns(org)).toEqual([second, first]);
    expect(await store.findPayoutRun(other, second.id)).toBeNull();
    expect((await store.findPayoutRun(other, first.id))?.orgId).toBe(other);
  });

  it('say what they were before they are sent, and stay paid once paid', async () => {
    const { store, org } = await setup();
    const run = await store.createPayoutRun(org, draft());
    expect(await store.beginPayoutRun(org, run.id)).toBe('draft');
    expect(await store.findPayoutRun(org, run.id)).toMatchObject({ status: 'sending' });
    expect(await store.beginPayoutRun(org, run.id)).toBe('sending');

    const paid = await store.settlePayoutRun(org, run.id, {
      status: 'paid',
      tx: '0xpaid',
      error: null,
      executedAt: OCTOBER + 60_000,
      lines: [
        { lineNo: 1, tx: '0xpaid', logIndex: 3, reconciled: true },
        { lineNo: 2, tx: '0xpaid', logIndex: 5, reconciled: true },
      ],
    });
    expect(paid).toMatchObject({
      status: 'paid',
      tx: '0xpaid',
      error: null,
      executedAt: OCTOBER + 60_000,
      lines: [
        { lineNo: 1, tx: '0xpaid', logIndex: 3, reconciled: true },
        { lineNo: 2, tx: '0xpaid', logIndex: 5, reconciled: true },
      ],
    });

    expect(await store.beginPayoutRun(org, run.id)).toBe('paid');
    expect(await store.settlePayoutRun(org, run.id, { status: 'sending', tx: '0xlate', error: 'the outcome is unknown', executedAt: null })).toEqual(paid);
    expect(await store.settlePayoutRun(org, run.id, { status: 'refused', tx: null, error: 'exceeds the allowance', executedAt: null })).toEqual(paid);
  });

  it('keep the reason an attempt did not pay, and can be attempted again', async () => {
    const { store, org } = await setup();
    const run = await store.createPayoutRun(org, draft());
    await store.beginPayoutRun(org, run.id);
    expect(await store.settlePayoutRun(org, run.id, { status: 'refused', tx: null, error: 'the key may only spend 1.00 more', executedAt: null })).toMatchObject({
      status: 'refused',
      tx: null,
      error: 'the key may only spend 1.00 more',
      executedAt: null,
    });
    expect(await store.beginPayoutRun(org, run.id)).toBe('refused');
    expect(await store.settlePayoutRun(org, run.id, { status: 'paid', tx: '0xpaid', error: null, executedAt: OCTOBER })).toMatchObject({ status: 'paid', error: null });
  });

  it('are null to begin or settle when the organisation has no such run', async () => {
    const { store, org, addOrg } = await setup();
    const other = await addOrg();
    const run = await store.createPayoutRun(org, draft());
    expect(await store.beginPayoutRun(other, run.id)).toBeNull();
    expect(await store.settlePayoutRun(other, run.id, { status: 'paid', tx: '0xpaid', error: null, executedAt: OCTOBER })).toBeNull();
    expect(await store.findPayoutRun(org, run.id)).toMatchObject({ status: 'draft', tx: null });
  });

  it('are recorded as paid when they were paid before the database knew of them, once', async () => {
    const { store, org } = await setup();
    const paid = {
      id: 'HF-2026-10-0004',
      chain: 'tempo' as const,
      token: '0xtoken',
      tokenSymbol: 'USDC.e',
      tokenDecimals: 6,
      account: '0xAccount',
      notBefore: null,
      tx: '0xhistoric',
      createdAt: OCTOBER - 86_400_000,
      executedAt: OCTOBER - 86_000_000,
      lines: [{ ...line(5_000_000n, { memo: 'HF-2026-10-0004/1' }), tx: '0xhistoric', logIndex: 2 }],
    };
    expect(await store.importPaidRun(org, paid)).toBe(true);
    expect(await store.importPaidRun(org, { ...paid, tx: '0xother' })).toBe(false);

    const stored = await store.findPayoutRun(org, paid.id);
    expect(stored).toMatchObject({
      status: 'paid',
      total: 5_000_000n,
      tx: '0xhistoric',
      createdAt: paid.createdAt,
      executedAt: paid.executedAt,
      lines: [{ lineNo: 1, memo: 'HF-2026-10-0004/1', tx: '0xhistoric', logIndex: 2, reconciled: true }],
    });
    expect(stored?.lines[0]?.receiptToken).toMatch(/^[A-Za-z0-9_-]{43}$/);

    // The numbering goes on from the highest id the month holds.
    expect((await store.createPayoutRun(org, draft())).id).toBe('HF-2026-10-0005');
    await expect(store.importPaidRun(org, { ...paid, id: 'october-payroll' })).rejects.toThrow('is not a run id of the form HF-YYYY-MM-NNNN');
  });

  it('are found line by line through a receipt token, and through nothing else', async () => {
    const { store, org } = await setup();
    const run = await store.createPayoutRun(org, draft());
    const [, second] = run.lines;
    const { lines: _lines, ...header } = run;
    expect(await store.findReceipt(second?.receiptToken ?? '')).toEqual({ run: header, line: second });
    expect(await store.findReceipt('no-such-token')).toBeNull();
    expect(await store.findReceipt('')).toBeNull();
  });
});

describe('refusals', () => {
  const refusal = (tx: string | null) => ({
    chain: 'tempo',
    kind: 'over_limit',
    attempted: 'transferWithMemo of the largest amount there is',
    outcome: 'SpendingLimitExceeded',
    tx,
    evidence: { reverted: true, gasUsed: 51_234n },
  });

  it('are kept with their evidence and listed newest first', async () => {
    const { store, org, clock } = await setup();
    const first = await store.recordRefusal(org, refusal('0xr1'));
    clock.advance(1_000);
    const second = await store.recordRefusal(org, { ...refusal('0xr2'), kind: 'out_of_scope', outcome: 'CallNotAllowed' });
    expect(first).toEqual({ id: expect.stringMatching(/^[0-9a-f-]{36}$/), ...refusal('0xr1'), createdAt: clock.ms - 1_000 });
    expect(await store.listRefusals(org)).toEqual([second, first]);
  });

  it('are one per transaction', async () => {
    const { store, org, addOrg } = await setup();
    expect(await store.recordRefusal(org, refusal('0xsame'))).not.toBeNull();
    expect(await store.recordRefusal(org, { ...refusal('0xsame'), outcome: 'something else' })).toBeNull();
    expect(await store.listRefusals(org)).toHaveLength(1);

    const other = await addOrg();
    expect(await store.recordRefusal(other, refusal('0xsame'))).not.toBeNull();
  });

  it('may have no transaction at all, any number of times', async () => {
    const { store, org } = await setup();
    expect(await store.recordRefusal(org, { ...refusal(null), chain: 'hyperliquid', kind: 'withdraw3' })).not.toBeNull();
    expect(await store.recordRefusal(org, { ...refusal(null), chain: 'hyperliquid', kind: 'withdraw3' })).not.toBeNull();
    expect(await store.listRefusals(org)).toHaveLength(2);
  });
});

describe('auditor links', () => {
  const scope = { from: null, to: OCTOBER, modules: ['treasury', 'payouts'] };

  it('are kept by the hash of their token and listed newest first', async () => {
    const { store, org, clock } = await setup();
    const first = await store.createAuditLink(org, { tokenHash: 'hash-a', label: 'Q3 audit', scope, expiresAt: null });
    clock.advance(1_000);
    const second = await store.createAuditLink(org, { tokenHash: 'hash-b', label: 'Tax adviser', scope, expiresAt: clock.ms + 86_400_000 });
    expect(first).toEqual({ tokenHash: 'hash-a', orgId: org, label: 'Q3 audit', scope, expiresAt: null, revokedAt: null, createdAt: clock.ms - 1_000 });
    expect(await store.listAuditLinks(org)).toEqual([second, first]);
    expect(await store.liveAuditLink('hash-a')).toEqual(first);
    expect(await store.liveAuditLink('hash-nobody-has')).toBeNull();
    await expect(store.createAuditLink(org, { tokenHash: 'hash-a', label: 'Again', scope, expiresAt: null })).rejects.toThrow();
  });

  it('stop working when they run out, by the clock of the database', async () => {
    const { store, org, clock } = await setup();
    await store.createAuditLink(org, { tokenHash: 'hash-expiring', label: 'Short', scope, expiresAt: clock.ms + 1_000 });
    clock.advance(999);
    expect(await store.liveAuditLink('hash-expiring')).not.toBeNull();
    clock.advance(1);
    expect(await store.liveAuditLink('hash-expiring')).toBeNull();
    expect(await store.listAuditLinks(org)).toHaveLength(1);
  });

  it('stop working when they are revoked, and only their organisation can revoke them', async () => {
    const { store, org, addOrg, clock } = await setup();
    const other = await addOrg();
    await store.createAuditLink(org, { tokenHash: 'hash-revoked', label: 'Former auditor', scope, expiresAt: null });

    expect(await store.revokeAuditLink(other, 'hash-revoked')).toBeNull();
    expect(await store.liveAuditLink('hash-revoked')).not.toBeNull();

    clock.advance(5_000);
    expect(await store.revokeAuditLink(org, 'hash-revoked')).toMatchObject({ revokedAt: clock.ms });
    expect(await store.liveAuditLink('hash-revoked')).toBeNull();

    // Revoking again does not move the moment it was first revoked.
    const revokedAt = clock.ms;
    clock.advance(5_000);
    expect(await store.revokeAuditLink(org, 'hash-revoked')).toMatchObject({ revokedAt });
  });
});

describe('attestations', () => {
  const root = (byte: string): Hex => `0x${byte.repeat(32)}`;
  const opening = (n: number): TreasuryOpening => ({ zat: 5_000_000n + BigInt(n), salt: root(`5${n}`), commitment: root(`c${n}`) });

  let txs = 0;
  const sent = (over: Partial<NewAttestation> = {}): NewAttestation => ({
    series: 0n,
    number: null,
    tx: `0xattest${++txs}`,
    journalCount: 12n,
    journalRoot: root('a1'),
    treasury: opening(1),
    sentAt: OCTOBER,
    status: 'pending',
    detail: null,
    ...over,
  });
  const confirmed = (number: bigint, over: Partial<NewAttestation> = {}) => sent({ number, status: 'confirmed', ...over });
  const refusedBeforeSending = (over: Partial<NewAttestation> = {}) => sent({ tx: null, treasury: null, status: 'refused', detail: 'JournalShrank(40, 12)', ...over });

  it('are kept as they were sent, and listed without the balance and the salt their commitment hides', async () => {
    const { store, org } = await setup();
    const attempt = sent();
    const row = await store.recordAttestation(org, attempt);
    expect(row).toEqual({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      orgId: org,
      series: 0n,
      number: null,
      tx: attempt.tx,
      journalCount: 12n,
      journalRoot: root('a1'),
      commitment: root('c1'),
      sentAt: OCTOBER,
      status: 'pending',
      detail: null,
    });
    expect(await store.listAttestations(org)).toEqual([row]);

    const [kept] = await rowsOf<{ salt_enc: string; treasury_zat: string | number | bigint }>('select salt_enc, treasury_zat from holdfast.attestations where org_id = $1', [org]);
    expect(kept?.salt_enc).toMatch(/^v1\./);
    expect(kept?.salt_enc).not.toContain(opening(1).salt.slice(2));
    expect(BigInt(kept?.treasury_zat ?? 0)).toBe(5_000_001n);
    const listed = JSON.stringify(await store.listAttestations(org), (_key, value: unknown) => (typeof value === 'bigint' ? value.toString() : value));
    expect(listed).not.toContain(opening(1).salt);
    expect(listed).not.toContain('5000001');
  });

  it('are one per transaction, and one per snapshot', async () => {
    const { store, org, addOrg } = await setup();
    const first = confirmed(0n);
    expect(await store.recordAttestation(org, first)).not.toBeNull();
    expect(await store.recordAttestation(org, { ...first, number: 1n })).toBeNull();
    expect(await store.recordAttestation(org, confirmed(0n))).toBeNull();
    expect(await store.recordAttestation(org, confirmed(0n, { series: 1n }))).not.toBeNull();
    expect(await store.listAttestations(org)).toHaveLength(2);

    // Refusals that sent nothing have no transaction to be told apart by.
    expect(await store.recordAttestation(org, refusedBeforeSending())).not.toBeNull();
    expect(await store.recordAttestation(org, refusedBeforeSending())).not.toBeNull();

    const other = await addOrg();
    expect(await store.recordAttestation(other, first)).not.toBeNull();
  });

  it('go from pending to how they ended, and then stay there', async () => {
    const { store, org, addOrg } = await setup();
    const pending = await store.recordAttestation(org, sent());
    if (pending === null) throw new Error('the attestation was not stored');
    const other = await addOrg();

    expect(await store.settleAttestation(other, pending.id, { status: 'lost', detail: 'never seen' })).toBeNull();
    expect(await store.settleAttestation(org, 'not-a-uuid', { status: 'lost', detail: 'never seen' })).toBeNull();
    expect(await store.pendingAttestation(org)).toEqual(pending);

    // The chain says where the snapshot went: the series may have moved on since it was sent.
    const landed = await store.settleAttestation(org, pending.id, { status: 'confirmed', series: 1n, number: 4n });
    expect(landed).toEqual({ ...pending, status: 'confirmed', series: 1n, number: 4n });
    expect(await store.settleAttestation(org, pending.id, { status: 'lost', detail: 'never seen' })).toEqual(landed);
    expect(await store.pendingAttestation(org)).toBeNull();

    const dropped = await store.recordAttestation(org, sent());
    if (dropped === null) throw new Error('the attestation was not stored');
    const gone = await store.settleAttestation(org, dropped.id, { status: 'lost', detail: 'no receipt after 30 minutes' });
    expect(gone).toEqual({ ...dropped, status: 'lost', detail: 'no receipt after 30 minutes' });
    expect(await store.settleAttestation(org, dropped.id, { status: 'confirmed', series: 0n, number: 9n })).toEqual(gone);
  });

  it('are pending one at a time for an organisation: a second cannot be written down until the first has ended', async () => {
    const { store, org, addOrg } = await setup();
    const first = await store.recordAttestation(org, sent());
    if (first === null) throw new Error('the attestation was not stored');
    expect(await store.recordAttestation(org, sent())).toBeNull();
    expect(await store.listAttestations(org)).toEqual([first]);

    // What has ended is no bar, nor is what another organisation has pending.
    expect(await store.recordAttestation(org, refusedBeforeSending())).not.toBeNull();
    expect(await store.recordAttestation(await addOrg(), sent())).not.toBeNull();
    await store.settleAttestation(org, first.id, { status: 'reverted', detail: 'reverted' });
    const second = await store.recordAttestation(org, sent());
    expect(await store.pendingAttestation(org)).toEqual(second);

    // Not even two at the same moment: the database itself lets one through.
    await store.settleAttestation(org, second?.id ?? '', { status: 'lost', detail: 'never seen' });
    const raced = await Promise.all([store.recordAttestation(org, sent()), store.recordAttestation(org, sent()), store.recordAttestation(org, sent())]);
    expect(raced.filter((row) => row !== null)).toHaveLength(1);
  });

  it('are listed newest first', async () => {
    const { store, org } = await setup();
    const first = await store.recordAttestation(org, confirmed(0n, { sentAt: OCTOBER }));
    const second = await store.recordAttestation(org, confirmed(1n, { sentAt: OCTOBER + 60_000 }));
    const third = await store.recordAttestation(org, sent({ sentAt: OCTOBER + 120_000 }));
    expect(await store.listAttestations(org)).toEqual([third, second, first]);
    expect(await store.listAttestations(org, 2)).toEqual([third, second]);
    expect(await store.pendingAttestation(org)).toEqual(third);
  });

  it('remember the refusal that stopped a series, for that series and no other', async () => {
    const { store, org, addOrg } = await setup();
    expect(await store.refusedAttestation(org, 0n)).toBeNull();
    await store.recordAttestation(org, confirmed(0n));
    const refusal = await store.recordAttestation(org, refusedBeforeSending({ sentAt: OCTOBER + 60_000 }));
    expect(refusal).toMatchObject({ status: 'refused', tx: null, commitment: null, number: null, detail: 'JournalShrank(40, 12)' });
    const later = await store.recordAttestation(org, refusedBeforeSending({ sentAt: OCTOBER + 120_000, detail: 'JournalRewritten' }));

    expect(await store.refusedAttestation(org, 0n)).toEqual(later);
    expect(await store.refusedAttestation(org, 1n)).toBeNull();
    expect(await store.refusedAttestation(await addOrg(), 0n)).toBeNull();
  });

  it('are found by the snapshots they are behind', async () => {
    const { store, org } = await setup();
    const zero = await store.recordAttestation(org, confirmed(0n));
    const one = await store.recordAttestation(org, confirmed(1n));
    await store.recordAttestation(org, confirmed(1n, { series: 1n }));
    await store.recordAttestation(org, sent());

    expect(await store.snapshotAttestations(org, 0n, [0n, 1n, 7n])).toEqual([one, zero]);
    expect(await store.snapshotAttestations(org, 0n, [7n])).toEqual([]);
    expect(await store.snapshotAttestations(org, 0n, [])).toEqual([]);
  });

  it('open their commitment from their own row and under the master key, and from nowhere else', async () => {
    const { store, org, addOrg } = await setup();
    await store.recordAttestation(org, confirmed(0n, { treasury: opening(2) }));
    await store.recordAttestation(org, sent({ treasury: opening(3) }));
    await store.recordAttestation(org, refusedBeforeSending());

    expect(await store.openAttestation(org, 0n, 0n)).toEqual(opening(2));
    expect(await store.openAttestation(org, 0n, 1n)).toBeNull();
    expect(await store.openAttestation(org, 1n, 0n)).toBeNull();
    const other = await addOrg();
    expect(await store.openAttestation(other, 0n, 0n)).toBeNull();

    const stranger = pgStore(connection.db, { masterKey: new Uint8Array(32).fill(9) });
    await expect(stranger.openAttestation(org, 0n, 0n)).rejects.toThrow('the secret could not be decrypted');

    // An envelope copied under another organisation, or beside another commitment, does not open there.
    const [row] = await rowsOf<{ salt_enc: string }>('select salt_enc from holdfast.attestations where org_id = $1 and number = 0', [org]);
    const copy = "insert into holdfast.attestations (org_id, series, number, tx, journal_count, journal_root, treasury_zat, salt_enc, commitment, sent_at, status) values ($1, $2, 0, '0xcopied', 1, '0x11', 1, $3, $4, now(), 'confirmed')";
    await connection.client.query(copy, [other, 0, row?.salt_enc, opening(2).commitment]);
    await expect(store.openAttestation(other, 0n, 0n)).rejects.toThrow('the secret could not be decrypted');
    await connection.client.query(copy, [org, 5, row?.salt_enc, opening(3).commitment]);
    await expect(store.openAttestation(org, 5n, 0n)).rejects.toThrow('the secret could not be decrypted');
  });

  it('are refused when they contradict themselves, or belong to nobody', async () => {
    const { store, org } = await setup();
    await expect(store.recordAttestation(org, sent({ number: 0n }))).rejects.toThrow('a snapshot has a number once the chain holds it');
    await expect(store.recordAttestation(org, sent({ status: 'confirmed' }))).rejects.toThrow('a snapshot has a number once the chain holds it');
    await expect(store.recordAttestation(org, sent({ treasury: null }))).rejects.toThrow('an attestation that was sent carries a treasury commitment');
    await expect(store.recordAttestation('nobody', sent())).rejects.toThrow();
    expect(await store.listAttestations(org)).toEqual([]);
  });
});
