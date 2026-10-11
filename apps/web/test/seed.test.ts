import type { PgliteConnection } from '@holdfast/db';
import { lineMemo } from '@holdfast/tempo';
import type { Hex } from 'viem';
import { generatePrivateKey, privateKeyToAddress } from 'viem/accounts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getDemoPayouts, getDemoSafety } from '../src/server/api/public';
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
    expect(parseSeed(JSON.stringify(valid))).toMatchObject({ payoutRuns: [], refusals: [], org: { tempoAccount: null, monthlyBurnUsd: null } });
    expect(() => parseSeed('{')).toThrow('the seed file is not valid JSON');
    const cases: [unknown, string][] = [
      [{ ...valid, org: { ...valid.org, owner: 'nobody' } }, 'org.owner: is not an account address'],
      [{ ...valid, keys: { hyperliquidAgent: '0x1234' } }, 'keys.hyperliquidAgent'],
      [{ ...valid, keys: { solanaDelegate: [1, 2, 3] } }, 'keys.solanaDelegate'],
      [{ ...valid, payoutRuns: [{ id: 'october', chain: 'tempo', tx: '0x1', createdAt: '2026-10-09T14:00:00Z', paidAt: '2026-10-09T14:03:00Z', lines: [] }] }, 'payoutRuns.0.id: is not a run id of the form HF-YYYY-MM-NNNN'],
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
    }
  });

  it('refuses a key that is not a viewing key before it writes anything', async () => {
    const { seed } = await existingOnChain();
    const spending = parseSeed(JSON.stringify({ ...seed, org: { ...seed.org, ufvk: 'secret-extended-key-main1qqqqqqqq' } }));
    await expect(seedDemo(w.deps, spending)).rejects.toThrow('the viewing key was not accepted');
    expect(await w.store.findOrg(seed.org.id)).toBeNull();
  });
});
