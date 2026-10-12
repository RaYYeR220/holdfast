import { commitTreasury } from '@holdfast/attest';
import type { OutgoingPayment } from '@holdfast/core';
import type { PgliteConnection } from '@holdfast/db';
import { ASSETS } from '@holdfast/intents';
import { lineMemo } from '@holdfast/tempo';
import { type Hex, getAddress } from 'viem';
import { generatePrivateKey, privateKeyToAddress } from 'viem/accounts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { holdfast, statuses } from '../../cli/test/harness';
import { getExport, getReconciliation, getStatement } from '../src/server/api/books';
import { getDemoAttestations, getDemoPayouts, getDemoSafety } from '../src/server/api/public';
import { SOLANA_USDC } from '../src/server/config';
import { describeReport, parseSeed, seedDemo } from '../src/server/seed/demo';
import { SOLANA_OWNER, SOLANA_PAYEES, depositAddress } from './support/fakes';
import { BIRTHDAY, PAYEES, ROOT, RPC_URL, STARTUP_TIMEOUT_MS, UFVK, type World, call, migratedPglite, newAccount, note, sessionOf, tickOnce, world } from './support/world';

let connection: PgliteConnection;
let w: World;
let orgs = 0;

beforeAll(async () => {
  connection = await migratedPglite();
}, STARTUP_TIMEOUT_MS);

afterAll(() => connection.close());

beforeEach(() => {
  w = world(connection);
});

const TEMPO_RUN = 'HF-2026-10-0001';
const SOLANA_RUN = 'HF-2026-10-0002';
const SOLANA_SECRET = 'c4'.repeat(32);
const SOLANA_DELEGATE = 'De1egateSeeded11111111111111111111111111111';
const SOLANA_TX = '5sigSeededRunPaidOnDevnet1111111111111111111111111111111111111';
const SOLANA_REFUSAL = '5sigSeededRefusalOnDevnet111111111111111111111111111111111111';

/**
 * An organisation that has been living on its chains before the application
 * heard of it: a run paid on Tempo and one on Solana, and a refusal on each.
 * Returns the seed file that describes it.
 */
async function existingOnChain() {
  const owner = newAccount();
  const agentKey = generatePrivateKey();
  const access = w.deps.tempo.newAccessKey();
  const chain = w.tempoChain(access.address);
  const rail = w.deps.tempo.rail(access.privateKey);

  const tempoLines = [
    { to: PAYEES[0], amount: 1_000_000n, memo: lineMemo(TEMPO_RUN, 1) },
    { to: PAYEES[1], amount: 2_500_000n, memo: lineMemo(TEMPO_RUN, 2) },
  ];
  const paid = await rail.pay({ account: ROOT, lines: tempoLines, runId: TEMPO_RUN });
  const refused = await rail.probeOverLimit({ account: ROOT, to: PAYEES[0] });

  w.solana.know(SOLANA_SECRET, SOLANA_DELEGATE);
  w.solana.paid.set(SOLANA_RUN, {
    runId: SOLANA_RUN,
    signature: SOLANA_TX,
    slot: 412_000_500n,
    time: Date.parse('2026-10-10T09:00:00Z'),
    total: 4_000_000n,
    transfers: [{ to: SOLANA_PAYEES[0] ?? '', tokenAccount: 'ata', amount: 4_000_000n, memo: 'INV-7' }],
  });
  w.solana.outcomes.set(SOLANA_REFUSAL, { failed: true, error: '{"InstructionError":[1,{"Custom":1}]}' });

  const seed = {
    org: { id: `seeded-${++orgs}`, name: 'Holdfast Demo', owner: owner.address, ufvk: UFVK, birthday: 3_512_000, monthlyBurnUsd: 42_000, tempoAccount: ROOT.toLowerCase(), solanaOwner: SOLANA_OWNER },
    keys: { hyperliquidAgent: agentKey, tempoAccessKey: access.privateKey, solanaDelegate: SOLANA_SECRET },
    payoutRuns: [
      {
        id: TEMPO_RUN,
        chain: 'tempo',
        tx: paid.tx,
        createdAt: '2026-10-09T14:00:00Z',
        paidAt: '2026-10-09T14:03:00Z',
        lines: [
          { payeeName: 'Ada Lovelace', to: PAYEES[0], amount: '1000000', reference: 'INV-1041' },
          { payeeName: 'Grace Hopper', to: PAYEES[1].toLowerCase(), amount: '2500000' },
        ],
      },
      { id: SOLANA_RUN, chain: 'solana', tx: SOLANA_TX, createdAt: '2026-10-10T08:59:00Z', paidAt: '2026-10-10T09:00:00Z', notBefore: '412000000', lines: [{ payeeName: 'Linus Torvalds', to: SOLANA_PAYEES[0], amount: '4000000', reference: 'INV-7' }] },
    ],
    refusals: [
      { chain: 'tempo', kind: 'over_limit', tx: refused.tx, attempted: 'transferWithMemo of the largest amount there is' },
      { chain: 'solana', kind: 'over_allowance', tx: SOLANA_REFUSAL, attempted: 'a transfer of one base unit more than the allowance' },
    ],
  };
  return { seed, owner, agentKey, access, chain, paidTx: paid.tx as Hex, refusedTx: refused.tx as Hex };
}

const results = (report: { items: { what: string; result: string }[] }) => report.items.map((item) => `${item.result} ${item.what}`);

describe('the demo seed', () => {
  it('registers the organisation, its keys, and every run and refusal the chains confirm', async () => {
    const { seed, owner, agentKey, access, paidTx, refusedTx } = await existingOnChain();
    const report = await seedDemo(w.deps, parseSeed(JSON.stringify(seed)));
    const id = seed.org.id;

    expect(report.complete).toBe(true);
    expect(results(report)).toEqual([
      `recorded organisation ${id}`,
      'recorded hl_agent key',
      'recorded tempo_access key',
      'recorded solana_delegate key',
      `recorded payout run ${TEMPO_RUN}`,
      `recorded payout run ${SOLANA_RUN}`,
      `recorded tempo refusal ${refusedTx}`,
      `recorded solana refusal ${SOLANA_REFUSAL}`,
    ]);

    expect(await w.store.findOrg(id)).toMatchObject({ name: 'Holdfast Demo', hlUser: owner.address.toLowerCase(), publicDemo: true, lockEnabled: false, monthlyBurnUsd: 42_000, tempoAccount: ROOT, solanaOwner: SOLANA_OWNER });
    expect((await w.store.loadOrg(id)).ufvk).toBe(UFVK);
    expect(await w.store.activeKey(id, 'hl_agent')).toEqual({ address: privateKeyToAddress(agentKey).toLowerCase(), secret: agentKey });
    expect(await w.store.activeKey(id, 'tempo_access')).toEqual({ address: access.address, secret: access.privateKey });
    expect(await w.store.activeKey(id, 'solana_delegate')).toEqual({ address: SOLANA_DELEGATE, secret: SOLANA_SECRET });

    expect(await w.store.findPayoutRun(id, TEMPO_RUN)).toMatchObject({
      status: 'paid',
      chain: 'tempo',
      account: ROOT,
      tx: paidTx,
      total: 3_500_000n,
      createdAt: Date.parse('2026-10-09T14:00:00Z'),
      executedAt: Date.parse('2026-10-09T14:03:00Z'),
      lines: [
        { lineNo: 1, payeeName: 'Ada Lovelace', toAddress: PAYEES[0], amount: 1_000_000n, memo: `${TEMPO_RUN}/1`, reference: 'INV-1041', tx: paidTx, reconciled: true },
        { lineNo: 2, payeeName: 'Grace Hopper', toAddress: PAYEES[1], amount: 2_500_000n, memo: `${TEMPO_RUN}/2`, reference: '', tx: paidTx, reconciled: true },
      ],
    });
    expect(await w.store.findPayoutRun(id, SOLANA_RUN)).toMatchObject({ status: 'paid', chain: 'solana', account: SOLANA_OWNER, notBefore: 412_000_000n, tx: SOLANA_TX, lines: [{ memo: 'INV-7', toAddress: SOLANA_PAYEES[0], amount: 4_000_000n }] });
    expect((await w.store.listRefusals(id)).map((r) => [r.chain, r.kind, r.outcome, r.tx]).sort()).toEqual([
      ['solana', 'over_allowance', '{"InstructionError":[1,{"Custom":1}]}', SOLANA_REFUSAL],
      ['tempo', 'over_limit', 'SpendingLimitExceeded', refusedTx],
    ]);

    // What was seeded is what the public demo then shows.
    const payouts = await call(w, getDemoPayouts, 'GET', { params: { orgId: id } });
    expect(payouts.body.payouts.value.map((run: { id: string }) => run.id).sort()).toEqual([TEMPO_RUN, SOLANA_RUN]);
    expect((await call(w, getDemoSafety, 'GET', { params: { orgId: id } })).body.refusals.value).toHaveLength(2);
  });

  it('records nothing a second time', async () => {
    const { seed } = await existingOnChain();
    const parsed = parseSeed(JSON.stringify(seed));
    await seedDemo(w.deps, parsed);
    const tokens = (await w.store.findPayoutRun(seed.org.id, TEMPO_RUN))?.lines.map((line) => line.receiptToken);

    const again = await seedDemo(w.deps, parsed);
    expect(again.complete).toBe(true);
    expect(again.items.map((item) => item.result)).toEqual(Array.from({ length: 8 }, () => 'kept'));
    expect(await w.store.listPayoutRuns(seed.org.id)).toHaveLength(2);
    expect(await w.store.listRefusals(seed.org.id)).toHaveLength(2);
    expect(await w.store.listKeys(seed.org.id)).toHaveLength(3);
    expect((await w.store.findPayoutRun(seed.org.id, TEMPO_RUN))?.lines.map((line) => line.receiptToken)).toEqual(tokens);
  });

  it('leaves out what the chain does not confirm, says so, and still records the rest', async () => {
    const { seed, paidTx } = await existingOnChain();
    const [tempoRun, solanaRun] = seed.payoutRuns;
    const [tempoRefusal, solanaRefusal] = seed.refusals;
    const doubtful = {
      ...seed,
      payoutRuns: [
        { ...tempoRun, id: 'HF-2026-10-0007' },
        { ...tempoRun, tx: `0x${'ee'.repeat(32)}` },
        { ...solanaRun, lines: [{ payeeName: 'Linus Torvalds', to: SOLANA_PAYEES[0], amount: '9000000', reference: 'INV-7' }] },
      ],
      refusals: [{ ...tempoRefusal, tx: paidTx }, { ...tempoRefusal, tx: `0x${'dd'.repeat(32)}` }, { ...solanaRefusal, tx: 'no-such-signature' }, solanaRefusal],
    };
    const report = await seedDemo(w.deps, parseSeed(JSON.stringify(doubtful)));
    expect(report.complete).toBe(false);
    const skipped = report.items.filter((item) => item.result === 'skipped').map((item) => item.detail);
    expect(skipped).toEqual([
      'the chain holds no run under this id',
      expect.stringContaining('not in the transaction the file names'),
      'line 1 is not what the chain shows',
      'the transaction succeeded on chain, so it is not a refusal',
      'the chain has no such transaction',
      'the chain has no such transaction',
    ]);
    expect(await w.store.listPayoutRuns(seed.org.id)).toEqual([]);
    expect((await w.store.listRefusals(seed.org.id)).map((r) => r.tx)).toEqual([SOLANA_REFUSAL]);
    expect(describeReport(report).at(-1)).toBe('Some of what the file names was left out; see the lines marked "!".');
  });

  it('records nothing it could not read the chain for, and no key or endpoint in what it prints', async () => {
    const { seed, chain, agentKey, access } = await existingOnChain();
    chain.failing.add('memoLogs');
    chain.failing.add('receipt');
    w.solana.down = `POST ${RPC_URL} timed out`;
    const report = await seedDemo(w.deps, parseSeed(JSON.stringify(seed)));
    expect(report.complete).toBe(false);
    expect(report.items.filter((item) => item.result === 'skipped')).toHaveLength(4);
    expect(await w.store.listPayoutRuns(seed.org.id)).toEqual([]);
    expect(await w.store.listRefusals(seed.org.id)).toEqual([]);

    const printed = describeReport(report).join('\n');
    expect(printed).toContain('it could not be confirmed on chain: memoLogs failed: fetch failed');
    expect(printed).toContain('it could not be confirmed on chain: POST [redacted] timed out');
    for (const secret of [UFVK, agentKey, access.privateKey, SOLANA_SECRET, RPC_URL]) expect(printed).not.toContain(secret);

    // Once the chains answer, the same file completes the record.
    chain.failing.clear();
    w.solana.down = null;
    const later = await seedDemo(w.deps, parseSeed(JSON.stringify(seed)));
    expect(later.complete).toBe(true);
    expect(await w.store.listPayoutRuns(seed.org.id)).toHaveLength(2);
  });

  it('never hands an organisation to another owner or another treasury', async () => {
    const { seed } = await existingOnChain();
    const parsed = parseSeed(JSON.stringify(seed));
    await seedDemo(w.deps, parsed);
    const before = await w.store.findOrg(seed.org.id);

    const stranger = parseSeed(JSON.stringify({ ...seed, org: { ...seed.org, owner: newAccount().address, name: 'Taken Over' } }));
    await expect(seedDemo(w.deps, stranger)).rejects.toThrow('is owned by another address than the file names; nothing was changed');
    expect(await w.store.findOrg(seed.org.id)).toEqual(before);
  });

  it('refuses a file that is not a seed, without repeating what is in it', () => {
    const valid = { org: { id: 'x', name: 'X', owner: newAccount().address, ufvk: UFVK, birthday: 1 }, keys: {} };
    expect(parseSeed(JSON.stringify(valid))).toMatchObject({ payoutRuns: [], refusals: [], attestations: [], swaps: [], org: { tempoAccount: null, monthlyBurnUsd: null } });
    expect(() => parseSeed('{')).toThrow('the seed file is not valid JSON');
    const salt = `0x${'5e'.repeat(32)}`;
    const attestation = { series: 0, number: 0, tx: `0x${'a7'.repeat(32)}`, journalCount: 3, root: `0x${'a1'.repeat(32)}`, treasuryZat: '5000000', salt };
    expect(parseSeed(JSON.stringify({ ...valid, attestations: [attestation] })).attestations).toEqual([{ ...attestation, series: 0n, number: 0n, journalCount: 3n, treasuryZat: 5_000_000n }]);
    const cases: [unknown, string][] = [
      [{ ...valid, org: { ...valid.org, owner: 'nobody' } }, 'org.owner: is not an account address'],
      [{ ...valid, keys: { hyperliquidAgent: '0x1234' } }, 'keys.hyperliquidAgent'],
      [{ ...valid, keys: { solanaDelegate: [1, 2, 3] } }, 'keys.solanaDelegate'],
      [{ ...valid, keys: { hedgeAttester: `${salt}00` } }, 'keys.hedgeAttester'],
      [{ ...valid, payoutRuns: [{ id: 'october', chain: 'tempo', tx: '0x1', createdAt: '2026-10-09T14:00:00Z', paidAt: '2026-10-09T14:03:00Z', lines: [] }] }, 'payoutRuns.0.id: is not a run id of the form HF-YYYY-MM-NNNN'],
      [{ ...valid, attestations: [{ ...attestation, salt: `${salt}5e` }] }, 'attestations.0.salt'],
      [{ ...valid, attestations: [{ ...attestation, series: -1 }] }, 'attestations.0.series'],
      [{ ...valid, attestations: [{ ...attestation, treasuryZat: 5_000_000 }] }, 'attestations.0.treasuryZat'],
      [{ ...valid, attestations: [{ ...attestation, root: '0xa1' }] }, 'attestations.0.root'],
      [{ ...valid, attestations: [{ ...attestation, balance: '1' }] }, 'attestations.0'],
      [{ ...valid, extra: true }, 'the file'],
    ];
    for (const [file, where] of cases) {
      let message = '';
      try {
        parseSeed(JSON.stringify(file));
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toContain(where);
      expect(message).not.toContain(UFVK);
      expect(message).not.toContain(salt);
    }
  });

  it('refuses a key that is not a viewing key before it writes anything', async () => {
    const { seed } = await existingOnChain();
    const spending = parseSeed(JSON.stringify({ ...seed, org: { ...seed.org, ufvk: 'secret-extended-key-main1qqqqqqqq' } }));
    await expect(seedDemo(w.deps, spending)).rejects.toThrow('the viewing key was not accepted');
    expect(await w.store.findOrg(seed.org.id)).toBeNull();
  });
});

describe('the demo seed, for an account whose hedge is already attested', () => {
  const HOUR = 60 * 60_000;
  const SALTS: [Hex, Hex] = [`0x${'51'.repeat(32)}`, `0x${'52'.repeat(32)}`];
  const ROOTS: [Hex, Hex] = [`0x${'a1'.repeat(32)}`, `0x${'a2'.repeat(32)}`];

  /**
   * An account that named an attester and had two snapshots recorded, an hour
   * apart, before the application heard of it. Returns the seed file that
   * describes it.
   */
  async function attestedOnChain() {
    const owner = newAccount();
    const attesterKey = generatePrivateKey();
    const attester = privateKeyToAddress(attesterKey);
    const user = getAddress(owner.address);
    w.attestor.name(user, attester);

    const recordedAt = w.clock.ms;
    const first = await w.attestor.send(attesterKey, { user, journalRoot: ROOTS[0], journalCount: 3n, treasuryCommitment: commitTreasury(5_000_000n, SALTS[0]) });
    w.clock.advance(HOUR);
    const second = await w.attestor.send(attesterKey, { user, journalRoot: ROOTS[1], journalCount: 7n, treasuryCommitment: commitTreasury(7_250_000n, SALTS[1]) });
    w.clock.advance(HOUR);
    // A transaction the contract turned away: sent by a key the account never named.
    const reverted = await w.attestor.send(generatePrivateKey(), { user, journalRoot: ROOTS[1], journalCount: 9n, treasuryCommitment: commitTreasury(1n, SALTS[1]) });

    const attestations = [
      { series: 0, number: 0, tx: first, journalCount: 3, root: ROOTS[0], treasuryZat: '5000000', salt: SALTS[0] },
      { series: 0, number: 1, tx: second, journalCount: 7, root: ROOTS[1].toUpperCase().replace('0X', '0x'), treasuryZat: '7250000', salt: SALTS[1] },
    ] as const;
    const seed = { org: { id: `attested-${++orgs}`, name: 'Holdfast Demo', owner: owner.address, ufvk: UFVK, birthday: 3_512_000 }, keys: { hedgeAttester: attesterKey }, attestations: [...attestations] };
    return { seed, attestations, owner, attesterKey, attester, txs: [first, second] as const, reverted, recordedAt };
  }

  it('registers the attester key and every snapshot the chain confirms, with what opens its commitment', async () => {
    const { seed, attesterKey, attester, txs, recordedAt } = await attestedOnChain();
    const report = await seedDemo(w.deps, parseSeed(JSON.stringify(seed)));
    const id = seed.org.id;

    expect(report.complete).toBe(true);
    expect(results(report)).toEqual([`recorded organisation ${id}`, 'recorded hl_attester key', 'recorded attestation 0 of series 0', 'recorded attestation 1 of series 0']);
    expect(await w.store.activeKey(id, 'hl_attester')).toEqual({ address: attester.toLowerCase(), secret: attesterKey });

    // The time on record is the chain's own for each snapshot, not the moment the file was read.
    expect(await w.store.listAttestations(id)).toEqual([
      { id: expect.any(String), orgId: id, series: 0n, number: 1n, tx: txs[1], journalCount: 7n, journalRoot: ROOTS[1], commitment: commitTreasury(7_250_000n, SALTS[1]), sentAt: recordedAt + HOUR, status: 'confirmed', detail: null },
      { id: expect.any(String), orgId: id, series: 0n, number: 0n, tx: txs[0], journalCount: 3n, journalRoot: ROOTS[0], commitment: commitTreasury(5_000_000n, SALTS[0]), sentAt: recordedAt, status: 'confirmed', detail: null },
    ]);
    expect(await w.store.openAttestation(id, 0n, 1n)).toEqual({ zat: 7_250_000n, salt: SALTS[1], commitment: commitTreasury(7_250_000n, SALTS[1]) });

    // What was seeded is what the public demo then shows, each snapshot with its transaction.
    const { body } = await call(w, getDemoAttestations, 'GET', { params: { orgId: id } });
    expect(body).toMatchObject({ attester: attester.toLowerCase(), snapshots: { status: 'ok', value: { series: '0', snapshotCount: '2', items: [{ number: '1', tx: txs[1], journalCount: '7' }, { number: '0', tx: txs[0], journalCount: '3' }] } } });
  });

  it('records nothing a second time, and adds to an organisation that is already registered', async () => {
    const { seed } = await attestedOnChain();
    const { attestations: _later, keys: _keys, ...rest } = seed;
    const before = await seedDemo(w.deps, parseSeed(JSON.stringify({ ...rest, keys: {} })));
    expect(results(before)).toEqual([`recorded organisation ${seed.org.id}`]);

    const parsed = parseSeed(JSON.stringify(seed));
    expect(results(await seedDemo(w.deps, parsed))).toEqual([`kept organisation ${seed.org.id}`, 'recorded hl_attester key', 'recorded attestation 0 of series 0', 'recorded attestation 1 of series 0']);
    const again = await seedDemo(w.deps, parsed);
    expect(again.complete).toBe(true);
    expect(again.items.map((item) => item.result)).toEqual(['kept', 'kept', 'kept', 'kept']);
    expect(await w.store.listAttestations(seed.org.id)).toHaveLength(2);
    expect(await w.store.listKeys(seed.org.id)).toHaveLength(1);
  });

  it('leaves out every snapshot the chain does not confirm exactly, and says what is wrong with each', async () => {
    const { seed, attestations, txs, reverted } = await attestedOnChain();
    const [first, second] = attestations;
    const doubtful = {
      ...seed,
      attestations: [
        { ...first, salt: SALTS[1] },
        { ...first, treasuryZat: '5000001' },
        { ...first, root: ROOTS[1] },
        { ...first, journalCount: 4 },
        { ...first, tx: txs[1] },
        { ...first, tx: reverted },
        { ...first, tx: `0x${'dd'.repeat(32)}` },
        { ...second, number: 5 },
        { ...second, series: 2 },
      ],
    };
    const report = await seedDemo(w.deps, parseSeed(JSON.stringify(doubtful)));
    expect(report.complete).toBe(false);
    expect(report.items.filter((item) => item.result === 'skipped').map((item) => item.detail)).toEqual([
      'the balance and the salt do not open the treasury commitment the chain holds',
      'the balance and the salt do not open the treasury commitment the chain holds',
      'the journal root is not the one the chain holds',
      'the chain holds a snapshot of 3 journal entries, the file one of 4',
      'the transaction recorded another snapshot than the one the file names',
      'the transaction recorded no snapshot',
      'the chain has no such transaction',
      'series 0 holds 2 snapshot(s) on chain, so none with this number',
      'the chain holds no series 2 for this account',
    ]);
    expect(await w.store.listAttestations(seed.org.id)).toEqual([]);
    expect(describeReport(report)).toContain('! attestation 5 of series 0: NOT recorded, series 0 holds 2 snapshot(s) on chain, so none with this number');
  });

  it('records none while the chain cannot be read or where no attestations are recorded, and prints no key, salt or endpoint', async () => {
    const { seed, attesterKey } = await attestedOnChain();
    const parsed = parseSeed(JSON.stringify(seed));
    w.attestor.down = `POST ${RPC_URL} timed out`;
    const blind = await seedDemo(w.deps, parsed);
    expect(blind.complete).toBe(false);
    expect(await w.store.listAttestations(seed.org.id)).toEqual([]);
    const printed = describeReport(blind).join('\n');
    expect(printed).toContain('! attestation 0 of series 0: NOT recorded, it could not be confirmed on chain: POST [redacted] timed out');
    for (const secret of [UFVK, attesterKey, ...SALTS, RPC_URL]) expect(printed).not.toContain(secret);

    w.attestor.down = null;
    w.deps.attestor = null;
    const off = await seedDemo(w.deps, parsed);
    expect(off.items.filter((item) => item.result === 'skipped').map((item) => item.detail)).toEqual(Array.from({ length: 2 }, () => 'this deployment records no attestations: it names no HedgeAttestor contract, or its network is not mainnet'));
    // The key is the organisation's whether or not anything is attested here.
    expect(await w.store.activeKey(seed.org.id, 'hl_attester')).toMatchObject({ secret: attesterKey });

    w.deps.attestor = w.attestor;
    const later = await seedDemo(w.deps, parsed);
    expect(later.complete).toBe(true);
    expect(await w.store.listAttestations(seed.org.id)).toHaveLength(2);
  });
});

describe('the demo seed, for a treasury that funded its own account before the application heard of it', () => {
  const SPEND_TX = '2b'.repeat(32);
  const ARRIVAL_TX = `0x${'a5'.repeat(32)}`;
  const SOLANA_ARRIVAL = '5sigSwapDeliveredOnMainnet11111111111111111111111111111111111';
  const MINUTE = 60_000;
  const HEIGHT = BIRTHDAY + 50;
  let deposits = 0;
  const iso = (ms: number) => new Date(ms).toISOString();
  const kinds = (ledger: { kind: string }[]) => [...new Set(ledger.map((entry) => entry.kind))].sort();
  const skipped = (report: { items: { result: string; detail: string }[] }) => report.items.filter((item) => item.result === 'skipped').map((item) => item.detail);

  interface Answer {
    status?: string;
    updatedAt?: string;
    details?: Record<string, unknown>;
    request?: Record<string, unknown>;
    quote?: Record<string, unknown>;
    /** Whether the answer repeats the quote the swap was made on, as the service does. */
    quoted?: boolean;
    timestamp?: string;
  }

  /**
   * A treasury that was paid a grant and sent 0.0093 ZEC of it to the deposit
   * address of a swap whose recipient was the organisation's own Hyperliquid
   * account, where 11.020977 USDC arrived. None of it is in the database.
   * Returns the seed file that names the swap, the swap service's answer
   * about its deposit address, and what puts the treasury's history on the
   * chain the scanner reads.
   */
  function fundedBefore(over: { payment?: Partial<OutgoingPayment> } = {}) {
    const owner = newAccount();
    const deposit = depositAddress(++deposits);
    const grant = note(BIRTHDAY + 10, 1_975_000n, { memo: 'ZCG grant, milestone 2 of 4' });
    const change = note(HEIGHT, 1_030_000n, { kind: 'change', txid: SPEND_TX, id: `${SPEND_TX}:ironwood:change` });
    const payment: OutgoingPayment = { id: `${SPEND_TX}:transparent`, txid: SPEND_TX, height: HEIGHT, time: change.time, zat: 930_000n, memo: '', pool: 'transparent', ...over.payment };
    const quotedAt = change.time - 75_000;
    const settledAt = change.time + 5 * MINUTE;

    /** What the swap service says of the deposit address: as it answers for a swap that completed, naming no origin transaction. */
    const answer = (a: Answer = {}) => ({
      status: a.status ?? 'SUCCESS',
      updatedAt: a.updatedAt ?? iso(settledAt),
      swapDetails: { amountIn: '930000', amountOut: '1102097700', originChainTxHashes: [], destinationChainTxHashes: [{ hash: ARRIVAL_TX, explorerUrl: '' }], ...a.details },
      ...(a.quoted === false
        ? {}
        : {
            quoteResponse: {
              timestamp: a.timestamp ?? iso(quotedAt),
              signature: 'ed25519:2srDWTRBz8WW',
              quoteRequest: {
                originAsset: ASSETS.ZEC,
                destinationAsset: ASSETS.USDC_HYPERCORE,
                amount: '930000',
                refundTo: 't1Hsc1LR8yKnbbe3twRp88p6vFfC5t7DLbs',
                // The treasurer's wallet wrote the account with its checksum; the application keeps it in lower case.
                recipient: getAddress(owner.address),
                deadline: iso(quotedAt + 60 * MINUTE),
                ...a.request,
              },
              quote: { amountIn: '930000', amountOut: '1105139900', minAmountOut: '1093778500', depositAddress: deposit, deadline: iso(quotedAt + 3 * 24 * 60 * MINUTE), timeEstimate: 465, ...a.quote },
            },
          }),
    });
    const says = (a: Answer = {}) => void w.oneClick.swaps.set(deposit, answer(a));
    says();

    /** The treasury's history as the chain holds it: the grant, and the transaction that paid the deposit out of it. */
    const onChain = () => {
      w.chain.notes = [grant, change];
      w.chain.spends = [{ height: HEIGHT, nullifier: grant.nullifier ?? '' }];
      const scan = w.chain.scan.bind(w.chain);
      w.chain.scan = async (i) => {
        const found = await scan(i);
        return i.fromHeight <= HEIGHT && HEIGHT <= i.toHeight ? { ...found, outgoing: [payment], fees: [{ txid: SPEND_TX, zat: 15_000n }] } : found;
      };
    };

    const swap = { purpose: 'margin', depositAddress: deposit, amountInZat: '930000', originTx: SPEND_TX };
    const id = `funded-${++orgs}`;
    const seed = { org: { id, name: 'Holdfast Demo', owner: owner.address, ufvk: UFVK, birthday: BIRTHDAY }, keys: {}, swaps: [swap] };
    /** The row a swap made through the application would have ended up with. */
    const row = {
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      orgId: id,
      purpose: 'margin',
      originAsset: ASSETS.ZEC,
      destinationAsset: ASSETS.USDC_HYPERCORE,
      amountIn: 930_000n,
      minAmountOut: 1_093_778_500n,
      amountOut: 1_102_097_700n,
      depositAddress: deposit,
      recipient: owner.address.toLowerCase(),
      state: 'SUCCESS',
      originTxs: [] as string[],
      destinationTxs: [ARRIVAL_TX],
      createdAt: quotedAt,
      updatedAt: settledAt,
    };
    return { seed, swap, id, owner, deposit, quotedAt, settledAt, row, answer, says, onChain };
  }

  /** Register the organisation and have a tick scan its treasury, as a deployment has done by the time its swaps are seeded. */
  async function scanned(f: ReturnType<typeof fundedBefore>) {
    await seedDemo(w.deps, parseSeed(JSON.stringify({ ...f.seed, swaps: [] })));
    f.onChain();
    await tickOnce(w, f.id);
  }

  it('records a swap the swap service names no origin transaction for, once the treasury’s own history holds the payment', async () => {
    const f = fundedBefore();
    const parsed = parseSeed(JSON.stringify(f.seed));

    // Nothing has scanned the treasury yet: the payment is not there to be found, and the file's word is not taken for it.
    const early = await seedDemo(w.deps, parsed);
    expect(early.complete).toBe(false);
    expect(results(early)).toEqual([`recorded organisation ${f.id}`, `skipped swap at ${f.deposit}`]);
    expect(describeReport(early)).toContain(
      `! swap at ${f.deposit}: NOT recorded, the swap service names no origin transaction for it, and the treasury's scanned history holds no payment in ${SPEND_TX}: the treasury has not been scanned yet, and a tick has to scan past that transaction first`,
    );

    // A scan that has not reached the payment's block yet is no better, and says how far it got.
    f.onChain();
    w.chain.height = BIRTHDAY + 20;
    await tickOnce(w, f.id);
    expect(skipped(await seedDemo(w.deps, parsed))).toEqual([expect.stringContaining(`the treasury is scanned to block ${BIRTHDAY + 20}, and a tick has to scan past that transaction first`)]);
    expect(await w.store.listSwaps(f.id)).toEqual([]);

    w.chain.height = BIRTHDAY + 100;
    await tickOnce(w, f.id);
    const report = await seedDemo(w.deps, parsed);
    expect(report.complete).toBe(true);
    expect(results(report)).toEqual([`kept organisation ${f.id}`, `recorded swap at ${f.deposit}`]);
    // The line says which of the two ways confirmed the origin transaction.
    expect(describeReport(report)).toContain(`+ swap at ${f.deposit}: 930000 zat in, 1102097700 out in ${ARRIVAL_TX}; the swap service names no origin transaction, and the treasury's own history holds the payment`);

    // What is on record is the swap service's answer, under the times the swap ran at; the origin transactions are the ones it names, which is none.
    expect(await w.store.listSwaps(f.id)).toEqual([f.row]);
    const kept = await connection.client.query<{ quote: Record<string, unknown> }>('select quote from holdfast.swaps where deposit_address = $1', [f.deposit]);
    expect(kept.rows[0]?.quote).toMatchObject({ recipient: getAddress(f.owner.address), depositAddress: f.deposit, signature: 'ed25519:2srDWTRBz8WW', quotedAt: f.quotedAt });
  });

  it('records a swap whose origin transaction the swap service names, with no scan of the treasury', async () => {
    const f = fundedBefore();
    f.says({ details: { originChainTxHashes: [{ hash: SPEND_TX, explorerUrl: '' }] } });
    // The file may say what it expects was delivered; both are held against the answer. Hex is the same in either case.
    const claimed = { ...f.swap, originTx: SPEND_TX.toUpperCase(), amountOut: '1102097700', destinationTx: ARRIVAL_TX.toUpperCase().replace('0X', '0x') };
    const report = await seedDemo(w.deps, parseSeed(JSON.stringify({ ...f.seed, swaps: [claimed] })));
    expect(report.complete).toBe(true);
    expect(describeReport(report)).toContain(`+ swap at ${f.deposit}: 930000 zat in, 1102097700 out in ${ARRIVAL_TX}; the swap service names its origin transaction`);
    expect(await w.store.listSwaps(f.id)).toEqual([{ ...f.row, originTxs: [SPEND_TX] }]);
  });

  it('records nothing a second time, and does not ask about a swap that is on record', async () => {
    const f = fundedBefore();
    await scanned(f);
    const parsed = parseSeed(JSON.stringify(f.seed));
    expect((await seedDemo(w.deps, parsed)).complete).toBe(true);
    const asked = w.oneClick.statusCalls.length;

    // Whatever the swap service would say now, the swap that is on record stays as it was recorded.
    f.says({ details: { amountOut: '1' } });
    const again = await seedDemo(w.deps, parsed);
    expect(again.complete).toBe(true);
    expect(again.items.map((item) => item.result)).toEqual(['kept', 'kept']);
    expect(describeReport(again)).toContain(`= swap at ${f.deposit}: already on record`);
    expect(w.oneClick.statusCalls).toHaveLength(asked);
    expect(await w.store.listSwaps(f.id)).toEqual([f.row]);
  });

  it('leaves out a swap the swap service does not show as the file describes it, and says what differs', async () => {
    const stranger = newAccount().address;
    const other = 'ee'.repeat(32);
    type Funded = ReturnType<typeof fundedBefore>;
    const cases: [string, (f: Funded) => Record<string, unknown> | void, (f: Funded) => string][] = [
      ['another recipient', (f) => f.says({ request: { recipient: stranger } }), (f) => `its recipient is ${stranger}, not the organisation's own account ${f.owner.address.toLowerCase()}`],
      ['another amount in the file', () => ({ amountInZat: '930001' }), () => 'it took in 930000 zat, the file names 930001'],
      ['another amount at the swap service', (f) => f.says({ details: { amountIn: '929999' } }), () => 'it took in 929999 zat, the file names 930000'],
      ['another amount in the quote it repeats', (f) => f.says({ quote: { amountIn: '929999' } }), () => 'it took in 930000 zat, the file names 930000'],
      ['another origin transaction, named by the swap service', (f) => f.says({ details: { originChainTxHashes: [{ hash: other }] } }), () => `the swap service names ${other} as its origin transaction, not the one the file names`],
      ['a swap that was refunded', (f) => f.says({ status: 'REFUNDED', details: { amountOut: undefined, destinationChainTxHashes: [] } }), () => 'the swap service reports it as REFUNDED, not as completed'],
      ['a swap that is still under way', (f) => f.says({ status: 'PROCESSING' }), () => 'the swap service reports it as PROCESSING, not as completed'],
      ['dollars delivered somewhere else than margin goes', (f) => f.says({ request: { destinationAsset: ASSETS.USDC_SOLANA } }), () => `it delivered ${ASSETS.USDC_SOLANA}, and margin is funded in ${ASSETS.USDC_HYPERCORE}`],
      ['a swap that was not paid in ZEC', (f) => f.says({ request: { originAsset: ASSETS.USDC_BASE } }), () => `it was paid in ${ASSETS.USDC_BASE}, not in ZEC`],
      ['an answer that repeats no quote', (f) => f.says({ quoted: false }), () => 'the swap service does not repeat the quote the swap was made on, so what it was for cannot be checked'],
      ['an answer about another deposit address', (f) => f.says({ quote: { depositAddress: depositAddress(3_000) } }), () => 'the swap service answered about another deposit address'],
      ['nothing delivered', (f) => f.says({ details: { amountOut: undefined } }), () => 'the swap service does not say what it delivered, or in which transaction'],
      ['no destination transaction', (f) => f.says({ details: { destinationChainTxHashes: [] } }), () => 'the swap service does not say what it delivered, or in which transaction'],
      ['no time it settled at', (f) => f.says({ updatedAt: 'recently' }), () => 'the swap service does not say when it settled'],
      ['another amount delivered than the file expects', () => ({ amountOut: '1102097701' }), () => 'it delivered 1102097700, the file expects 1102097701'],
      ['another destination transaction than the file expects', () => ({ destinationTx: `0x${'dd'.repeat(32)}` }), () => `it delivered in ${ARRIVAL_TX}, not in the transaction the file names`],
      ['a deposit address the swap service does not know', (f) => void w.oneClick.swaps.delete(f.deposit), () => 'it could not be confirmed with the swap service: unknown deposit address'],
      ['float on Solana, which this deployment does not pay out in on mainnet', () => ({ purpose: 'payout_float' }), () => 'the swap service delivers USDC on Solana mainnet, and this deployment pays out in another token or on another cluster'],
    ];
    for (const [what, arrange, expected] of cases) {
      const f = fundedBefore();
      await scanned(f);
      const changed = arrange(f) ?? {};
      const report = await seedDemo(w.deps, parseSeed(JSON.stringify({ ...f.seed, swaps: [{ ...f.swap, ...changed }] })));
      expect(report.complete, what).toBe(false);
      expect(skipped(report), what).toEqual([expected(f)]);
      expect(await w.store.listSwaps(f.id), what).toEqual([]);
    }
  });

  it('leaves out a swap whose payment the treasury’s own history does not hold as the file describes it', async () => {
    // The file names a transaction the treasury never made.
    const elsewhere = fundedBefore();
    await scanned(elsewhere);
    const unknown = await seedDemo(w.deps, parseSeed(JSON.stringify({ ...elsewhere.seed, swaps: [{ ...elsewhere.swap, originTx: 'dd'.repeat(32) }] })));
    expect(skipped(unknown)).toEqual([
      `the swap service names no origin transaction for it, and the treasury's scanned history holds no payment in ${'dd'.repeat(32)}: the treasury is scanned to block ${BIRTHDAY + 100}, and a tick has to scan past that transaction first`,
    ]);

    // The transaction is the treasury's, but what it paid out is another amount, or was not paid transparently.
    for (const payment of [{ zat: 920_000n }, { pool: 'orchard' as const }]) {
      const f = fundedBefore({ payment });
      await scanned(f);
      expect(skipped(await seedDemo(w.deps, parseSeed(JSON.stringify(f.seed))))).toEqual([`the treasury's scanned history holds no transparent payment of 930000 zat in ${SPEND_TX}`]);
      expect(await w.store.listSwaps(f.id)).toEqual([]);
    }

    // The payment is of the right amount, but it was made hours before the swap was quoted, or hours after it settled.
    const before = fundedBefore();
    await scanned(before);
    before.says({ timestamp: iso(before.quotedAt + 3 * 60 * MINUTE), updatedAt: iso(before.settledAt + 3 * 60 * MINUTE) });
    expect(skipped(await seedDemo(w.deps, parseSeed(JSON.stringify(before.seed))))).toEqual([expect.stringMatching(new RegExp(`^the payment in ${SPEND_TX} was made at .*, not while the swap lasted, from .* to .*$`))]);
    const after = fundedBefore();
    await scanned(after);
    after.says({ timestamp: iso(after.quotedAt - 6 * 60 * MINUTE), updatedAt: iso(after.settledAt - 3 * 60 * MINUTE) });
    expect(skipped(await seedDemo(w.deps, parseSeed(JSON.stringify(after.seed))))).toEqual([expect.stringContaining('not while the swap lasted')]);

    // A block's clock may be off by as much as the books allow when they tie a payment to a swap.
    const skewed = fundedBefore();
    await scanned(skewed);
    skewed.says({ timestamp: iso(skewed.quotedAt + 100 * MINUTE), updatedAt: iso(skewed.settledAt + 100 * MINUTE) });
    expect((await seedDemo(w.deps, parseSeed(JSON.stringify(skewed.seed)))).complete).toBe(true);
    for (const f of [elsewhere, before, after]) expect(await w.store.listSwaps(f.id)).toEqual([]);
  });

  it('lets one payment confirm one swap: a second swap of the same amount cannot name it too', async () => {
    const f = fundedBefore();
    await scanned(f);
    // Another swap of the organisation's, as real and as successful, of exactly the same amount at the same time.
    const second = depositAddress(++deposits);
    w.oneClick.swaps.set(second, f.answer({ quote: { depositAddress: second } }));
    const both = { ...f.seed, swaps: [f.swap, { ...f.swap, depositAddress: second }] };

    const report = await seedDemo(w.deps, parseSeed(JSON.stringify(both)));
    expect(report.complete).toBe(false);
    expect(results(report)).toEqual([`kept organisation ${f.id}`, `recorded swap at ${f.deposit}`, `skipped swap at ${second}`]);
    expect(skipped(report)).toEqual([`the payment in ${SPEND_TX} already funds another swap on record`]);
    expect(await w.store.listSwaps(f.id)).toEqual([f.row]);
  });

  it('records nothing while the swap service cannot be asked, and prints no endpoint', async () => {
    const f = fundedBefore();
    await scanned(f);
    const parsed = parseSeed(JSON.stringify(f.seed));
    w.oneClick.down = `connect to ${RPC_URL} timed out`;
    const blind = await seedDemo(w.deps, parsed);
    expect(blind.complete).toBe(false);
    const printed = describeReport(blind).join('\n');
    expect(printed).toContain(`! swap at ${f.deposit}: NOT recorded, it could not be confirmed with the swap service: 1Click is unreachable: connect to [redacted] timed out`);
    for (const secret of [UFVK, RPC_URL]) expect(printed).not.toContain(secret);
    expect(await w.store.listSwaps(f.id)).toEqual([]);

    // Once it answers, the same file completes the record.
    w.oneClick.down = null;
    expect((await seedDemo(w.deps, parsed)).complete).toBe(true);
    expect(await w.store.listSwaps(f.id)).toEqual([f.row]);
  });

  it('records float delivered to the organisation’s own Solana wallet, where the deployment pays out in what the swap delivers', async () => {
    w.solana.cluster = 'mainnet-beta';
    w.solana.mint = SOLANA_USDC['mainnet-beta'];
    const f = fundedBefore();
    const float = { request: { destinationAsset: ASSETS.USDC_SOLANA, recipient: SOLANA_OWNER }, details: { amountOut: '11020977', originChainTxHashes: [{ hash: SPEND_TX }], destinationChainTxHashes: [{ hash: SOLANA_ARRIVAL }] }, quote: { minAmountOut: '10937785' } };
    f.says(float);
    const seed = { ...f.seed, org: { ...f.seed.org, solanaOwner: SOLANA_OWNER }, swaps: [{ ...f.swap, purpose: 'payout_float', destinationTx: SOLANA_ARRIVAL }] };

    // An organisation that names no wallet has no account of its own for float to arrive on.
    expect(skipped(await seedDemo(w.deps, parseSeed(JSON.stringify({ ...seed, org: f.seed.org }))))).toEqual(['the organisation has no Solana wallet yet; set one in its profile first']);
    // A Solana address is its exact text: one that differs in the case of a letter is another wallet.
    f.says({ ...float, request: { ...float.request, recipient: SOLANA_OWNER.toLowerCase() } });
    expect(skipped(await seedDemo(w.deps, parseSeed(JSON.stringify(seed))))).toEqual([`its recipient is ${SOLANA_OWNER.toLowerCase()}, not the organisation's own account ${SOLANA_OWNER}`]);

    f.says(float);
    expect((await seedDemo(w.deps, parseSeed(JSON.stringify(seed)))).complete).toBe(true);
    expect(await w.store.listSwaps(f.id)).toEqual([
      { ...f.row, purpose: 'payout_float', destinationAsset: ASSETS.USDC_SOLANA, minAmountOut: 10_937_785n, amountOut: 11_020_977n, recipient: SOLANA_OWNER, originTxs: [SPEND_TX], destinationTxs: [SOLANA_ARRIVAL] },
    ]);
  });

  it('puts the swap into the books: the payment becomes its input, the dollars its output, and the two reconcile', async () => {
    const f = fundedBefore();
    await scanned(f);
    const cookie = await sessionOf(w, f.owner.address);
    const params = { orgId: f.id };

    // With no swap on record the books show a payment to nobody in particular, and no dollars arriving anywhere.
    const before = (await call(w, getStatement, 'GET', { cookie, params })).body;
    expect(kinds(before.ledger)).toEqual(['change', 'network_fee', 'payment', 'receipt']);
    expect(before.statement.swapped).toMatchObject({ zat: '0', count: 0 });

    expect((await seedDemo(w.deps, parseSeed(JSON.stringify(f.seed)))).complete).toBe(true);
    const [swap] = await w.store.listSwaps(f.id);
    if (swap === undefined) throw new Error('the swap was not recorded');

    const after = (await call(w, getStatement, 'GET', { cookie, params })).body;
    expect(kinds(after.ledger)).toEqual(['change', 'network_fee', 'receipt', 'swap_in', 'swap_out']);
    const input = after.ledger.find((entry: { kind: string }) => entry.kind === 'swap_out');
    const output = after.ledger.find((entry: { kind: string }) => entry.kind === 'swap_in');
    // The treasury's own payment, now booked as what it was: the swap's input, sent to the swap's deposit address.
    expect(input).toMatchObject({ id: `zcash:${SPEND_TX}:transparent`, source: 'zcash', asset: 'ZEC', amount: '-930000', ref: swap.id, counterparty: { name: null, address: f.deposit }, proof: { chain: 'zcash', tx: SPEND_TX, block: HEIGHT } });
    expect(input.linked).toContain(output.id);
    // And what arrived for it on the organisation's own Hyperliquid account, dated when the swap settled.
    expect(output).toMatchObject({ id: `swap:${swap.id}:in`, ts: f.settledAt, source: 'swap', asset: 'USDC', decimals: 8, amount: '1102097700', usd: 11.020977, ref: swap.id, counterparty: { name: null, address: f.owner.address.toLowerCase() }, proof: { chain: 'hyperliquid', tx: ARRIVAL_TX }, linked: [input.id] });
    expect(after.statement.swapped).toMatchObject({ zat: '930000', count: 1 });
    expect(after.statement.payments).toMatchObject({ zat: '0', count: 0 });

    const reconciliation = (await call(w, getReconciliation, 'GET', { cookie, params })).body;
    expect(reconciliation.problems.filter((problem: { severity: string }) => problem.severity === 'error')).toEqual([]);
    expect(reconciliation.matched.filter((match: { kind: string }) => match.kind === 'swap')).toEqual([{ kind: 'swap', refs: [`swap:${swap.id}`, input.id, output.id] }]);

    // The published statement with the swap in it holds together for a reader who checks it with no network.
    const published = (await call(w, getExport, 'GET', { cookie, params })).text;
    expect(JSON.parse(published).swaps).toHaveLength(1);
    const outcome = await holdfast(['verify', 'statement.json', '--json', '--offline'], { 'statement.json': published }, undefined, { now: () => w.clock.now() + 5 * MINUTE });
    expect(statuses(outcome)).toEqual({ journal: 'PASS', zcash: 'SKIPPED', hyperliquid: 'SKIPPED', reconciliation: 'PASS', arithmetic: 'PASS' });
  });

  it('refuses a swap section that is not one, saying where', () => {
    const valid = { org: { id: 'x', name: 'X', owner: newAccount().address, ufvk: UFVK, birthday: 1 }, keys: {} };
    const swap = { purpose: 'margin', depositAddress: depositAddress(1), amountInZat: '930000', originTx: SPEND_TX };
    expect(parseSeed(JSON.stringify({ ...valid, swaps: [{ ...swap, originTx: SPEND_TX.toUpperCase(), amountOut: '1102097700', destinationTx: ARRIVAL_TX }] })).swaps).toEqual([
      { ...swap, amountInZat: 930_000n, amountOut: 1_102_097_700n, destinationTx: ARRIVAL_TX },
    ]);
    const cases: [Record<string, unknown>, string][] = [
      [{ ...swap, purpose: 'unlock' }, 'swaps.0.purpose'],
      [{ ...swap, amountInZat: 930_000 }, 'swaps.0.amountInZat'],
      [{ ...swap, amountInZat: '0' }, 'swaps.0.amountInZat'],
      [{ ...swap, originTx: `0x${SPEND_TX}` }, 'swaps.0.originTx'],
      [{ ...swap, originTx: undefined }, 'swaps.0.originTx'],
      [{ ...swap, depositAddress: '' }, 'swaps.0.depositAddress'],
      [{ ...swap, amountOut: 11.020977 }, 'swaps.0.amountOut'],
      [{ ...swap, recipient: newAccount().address }, 'swaps.0'],
    ];
    for (const [entry, where] of cases) expect(() => parseSeed(JSON.stringify({ ...valid, swaps: [entry] })), where).toThrow(where);
  });
});
