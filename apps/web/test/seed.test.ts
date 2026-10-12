import { commitTreasury } from '@holdfast/attest';
import type { PgliteConnection } from '@holdfast/db';
import { lineMemo } from '@holdfast/tempo';
import { type Hex, getAddress } from 'viem';
import { generatePrivateKey, privateKeyToAddress } from 'viem/accounts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getDemoAttestations, getDemoPayouts, getDemoSafety } from '../src/server/api/public';
import { describeReport, parseSeed, seedDemo } from '../src/server/seed/demo';
import { SOLANA_OWNER, SOLANA_PAYEES } from './support/fakes';
import { PAYEES, ROOT, RPC_URL, STARTUP_TIMEOUT_MS, UFVK, type World, call, migratedPglite, newAccount, world } from './support/world';

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
    expect(parseSeed(JSON.stringify(valid))).toMatchObject({ payoutRuns: [], refusals: [], attestations: [], org: { tempoAccount: null, monthlyBurnUsd: null } });
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
