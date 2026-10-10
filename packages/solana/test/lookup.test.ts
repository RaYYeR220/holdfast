import type { PayoutLine } from '@holdfast/core';
import { address, generateKeyPairSigner, type Instruction } from '@solana/kit';
import { getAddMemoInstruction } from '@solana-program/memo';
import { getTransferCheckedInstruction, getTransferInstruction } from '@solana-program/token';
import { beforeEach, describe, expect, it } from 'vitest';
import { associatedTokenAddress } from '../src/accounts';
import { PAYOUT_MEMO_PROGRAM_ADDRESS, payoutInstructions } from '../src/payout';
import type { SolanaPayoutRail } from '../src/rail';
import { addressOf } from './fake-node';
import {
  CONFIRMED,
  createWorld,
  CREATION_SLOT,
  FIRST_LANDING_SLOT,
  historyEntry,
  MINT,
  OWNER,
  payee,
  recorded,
  signedWire,
  type HistoryEntry,
  type World,
} from './world';

/**
 * pay() may only send when the history proves the run unpaid. Each test here
 * is a way that proof can be missing, and the run must then be refused.
 */

const RUN_ID = 'HF-2026-10-0001';
const LINES: PayoutLine[] = [
  { to: payee(0), amount: 1_000_000n, memo: 'INV-1041' },
  { to: payee(1), amount: 2_500_000n, memo: 'INV-1042' },
];

let world: World;
beforeEach(async () => {
  world = await createWorld();
  world.fund({ amount: 100_000_000n, delegate: world.delegate.address, delegatedAmount: 10_000_000n });
});

type Extras = { notBefore?: bigint };
const pay = (extras: Extras = {}, rail: SolanaPayoutRail = world.rail) =>
  rail.pay({ account: OWNER, lines: LINES, runId: RUN_ID, ...extras });
const fetched = (): unknown[] =>
  world.node.calls.filter(call => call.method === 'getTransaction').map(call => call.params[0]);

async function expectRefused(extras: Extras, reason: RegExp, rail: SolanaPayoutRail = world.rail): Promise<void> {
  const result = await pay(extras, rail);
  expect(result).toMatchObject({ ok: false, outcome: 'refused', tx: null });
  expect(result.error).toMatch(/^could not rule out that run HF-2026-10-0001 was already paid: /);
  expect(result.error).toMatch(reason);
  expect(result.error).toMatch(/; nothing was sent$/);
  expect(world.sent).toEqual([]);
  await expect(rail.findRun(OWNER, RUN_ID, extras)).rejects.toThrow(reason);
}

async function payoutWire(lines: readonly PayoutLine[] = LINES, runId = RUN_ID): Promise<string> {
  const transfers = await Promise.all(
    lines.map(async line => ({
      payee: address(line.to),
      tokenAccount: await associatedTokenAddress(line.to, MINT),
      amount: line.amount,
      memo: line.memo,
      createTokenAccount: true,
    })),
  );
  const plan = { delegate: world.delegate, source: world.source, mint: MINT, decimals: 6, runId, lineMemos: true, transfers };
  return (await signedWire(world.delegate, payoutInstructions(plan))).wire;
}

/** Put a payment of the run into the history, as an earlier process would have left it. */
async function landPayment(entry: Partial<HistoryEntry> = {}) {
  return world.land(await payoutWire(), LINES, entry);
}

/** A transaction a stranger can send: tokens into the team account, with whatever memo they like. */
async function depositWire(memo?: string): Promise<string> {
  const stranger = await generateKeyPairSigner();
  const instructions: Instruction[] = [
    ...(memo === undefined ? [] : [getAddMemoInstruction({ memo }, { programAddress: PAYOUT_MEMO_PROGRAM_ADDRESS })]),
    getTransferCheckedInstruction({
      source: addressOf(500),
      mint: MINT,
      destination: world.source,
      authority: stranger,
      amount: 250_000n,
      decimals: 6,
    }),
  ];
  return (await signedWire(stranger, instructions)).wire;
}

describe('a history that was not read to its end', () => {
  it('refuses when the account has more transactions than the search will list', async () => {
    const filler = historyEntry('filler', '[5] other');
    for (let index = 0; index < 10_000; index++) {
      world.history.unshift({ entry: { ...filler, signature: `filler-${index}`, slot: 1_000 + index }, transaction: null });
    }
    await expectRefused({}, /has more than 10000 transactions; run HF-2026-10-0001 cannot be ruled out/);
    expect(world.node.methods().filter(method => method === 'getSignaturesForAddress')).toHaveLength(20);
  });

  it('pays once a lower bound makes the same history finite', async () => {
    const filler = historyEntry('filler', '[5] other');
    for (let index = 0; index < 10_000; index++) {
      world.history.unshift({ entry: { ...filler, signature: `filler-${index}`, slot: 1_000 + index }, transaction: null });
    }
    expect(await pay({ notBefore: 10_500n })).toMatchObject({ ok: true, outcome: 'paid' });
    expect(world.node.methods().filter(method => method === 'getSignaturesForAddress')).toHaveLength(1);
  });

  it('refuses when a page of the history fails part-way', async () => {
    const filler = historyEntry('filler', '[5] other');
    for (let index = 0; index < 1_500; index++) {
      world.history.unshift({ entry: { ...filler, signature: `filler-${index}`, slot: 1_000 + index }, transaction: null });
    }
    const pages = world.answers.signatures;
    world.answers.signatures = config => {
      if (config.before) throw new Error('socket hang up');
      return pages(config);
    };
    await expectRefused({}, /socket hang up/);
  });

  it('refuses when the listing ends above the creation of the account, as on a node that prunes', async () => {
    await landPayment({ err: { InstructionError: [2, { Custom: 1 }] } });
    world.history.pop();
    await expectRefused({}, /does not reach back to its creation; pass notBefore to bound the search/);
  });

  it('refuses when the node has no history for the account at all', async () => {
    world.history.length = 0;
    await expectRefused({}, /the node has no history for /);
  });

  it('pays on a pruning node when the lower bound lies within what the node still has', async () => {
    world.history.pop();
    world.answers.firstAvailableBlock = () => 40;
    expect(await pay({ notBefore: 45n })).toMatchObject({ ok: true, outcome: 'paid' });
  });

  it('refuses when the history of the node begins above the lower bound', async () => {
    world.history.pop();
    world.answers.firstAvailableBlock = () => 46;
    await expectRefused({ notBefore: 45n }, /the node's history begins at slot 46, after slot 45/);
  });

  it('refuses when the node cannot say where its history begins', async () => {
    world.history.pop();
    world.node.unreachable.add('getFirstAvailableBlock');
    await expectRefused({ notBefore: 45n }, /connect ECONNREFUSED/);
  });

  it('refuses a lower bound that is not a slot', async () => {
    expect(await pay({ notBefore: -1n })).toMatchObject({ ok: false, outcome: 'refused', error: 'invalid notBefore -1' });
    expect(world.sent).toEqual([]);
  });

  it('reads no more than fifty transactions per search, and picks up where it left off', async () => {
    const deposit = await depositWire();
    for (let index = 0; index < 51; index++) {
      const slot = FIRST_LANDING_SLOT + index;
      world.history.unshift({
        entry: historyEntry(`deposit-${index}`, null, { slot }),
        transaction: recorded(deposit, { [world.source]: OWNER }, { slot }),
      });
    }
    const first = await pay();
    expect(first).toMatchObject({ ok: false, outcome: 'refused', tx: null });
    expect(first.error).toMatch(/more than 50 transactions of .* would have to be read to rule run .* out; pass notBefore/);
    expect(fetched()).toHaveLength(50);
    expect(world.sent).toEqual([]);

    expect(await pay()).toMatchObject({ ok: true, outcome: 'paid' });
    expect(fetched()).toHaveLength(52);
  });
});

describe('a transaction that might be the payment but cannot be read', () => {
  it('refuses when the node lists it and returns null for it', async () => {
    const { entry } = await landPayment();
    world.answers.transaction = () => null;
    await expectRefused({}, new RegExp(`the node lists transaction ${entry.signature} for .* but does not return it`));
  });

  it('refuses when the node returns it without its execution record', async () => {
    const { transaction } = await landPayment();
    world.answers.transaction = () => ({ ...(transaction as object), meta: null });
    await expectRefused({}, /but does not return it/);
  });

  it('refuses when it cannot be fetched', async () => {
    await landPayment();
    world.node.unreachable.add('getTransaction');
    await expectRefused({}, /connect ECONNREFUSED/);
  });

  it('refuses when it cannot be decoded', async () => {
    const { transaction } = await landPayment();
    world.answers.transaction = () => ({ ...(transaction as object), transaction: ['AAAA', 'base64'] });
    await expectRefused({}, /could not be decoded/);
  });

  it('refuses when it took tokens out of the account in a way its instructions do not show', async () => {
    const memoOnly = await signedWire(world.delegate, [
      getAddMemoInstruction({ memo: RUN_ID }, { programAddress: PAYOUT_MEMO_PROGRAM_ADDRESS }),
      getTransferCheckedInstruction({
        source: addressOf(500),
        mint: MINT,
        destination: world.source,
        authority: world.delegate,
        amount: 0n,
        decimals: 6,
      }),
    ]);
    const item = world.record(memoOnly.wire);
    const answer = item.transaction as ReturnType<typeof recorded>;
    const drained = answer.meta.postTokenBalances.map(balance => ({
      ...balance,
      uiTokenAmount: { ...balance.uiTokenAmount, amount: '996500000' },
    }));
    item.transaction = { ...answer, meta: { ...answer.meta, postTokenBalances: drained } };
    await expectRefused({}, /carries run HF-2026-10-0001 as its memo, but what it moved out of .* cannot be read/);
  });

  it('refuses when the node kept no token balances for it', async () => {
    const item = await landPayment();
    const answer = item.transaction as ReturnType<typeof recorded>;
    const { preTokenBalances: _pre, postTokenBalances: _post, ...meta } = answer.meta;
    item.transaction = { ...answer, meta };
    await expectRefused({}, /cannot be read from its instructions/);
  });

  it('is not held up by a deposit that a stranger labels with the run id', async () => {
    world.record(await depositWire(RUN_ID));
    expect(await pay()).toMatchObject({ ok: true, outcome: 'paid', replayed: false });
    expect(world.sent).toHaveLength(1);
  });
});

describe('what the node says about a transaction without being asked for it', () => {
  it('finds a payment the node lists with a null memo, as a node does that does not index the Memo program', async () => {
    const { entry } = await landPayment({ memo: null });
    expect(await pay()).toMatchObject({ ok: true, outcome: 'paid', tx: entry.signature, replayed: true });
    expect(world.sent).toEqual([]);
  });

  it('finds a payment whose memo the node reports in a format of its own', async () => {
    const { entry } = await landPayment({ memo: RUN_ID });
    expect(await pay()).toMatchObject({ ok: true, outcome: 'paid', tx: entry.signature, replayed: true });
    expect(world.sent).toEqual([]);
  });

  it('reads every successful transaction it is told nothing usable about', async () => {
    const deposit = world.record(await depositWire());
    const creation = world.history.at(-1);
    expect(await pay()).toMatchObject({ ok: true, outcome: 'paid' });
    expect(fetched()).toEqual([deposit.entry.signature, creation?.entry.signature]);
  });

  it('takes a well-formed memo that leads with something else at its word', async () => {
    const other = world.record(await depositWire('thanks'));
    expect(other.entry.memo).toBe('[6] thanks');
    expect(await pay()).toMatchObject({ ok: true, outcome: 'paid' });
    expect(fetched()).not.toContain(other.entry.signature);
  });

  it('does not take a missing error field for a failure', async () => {
    const item = await landPayment();
    delete (item.entry as Partial<HistoryEntry>).err;
    expect(await pay()).toMatchObject({ ok: true, outcome: 'paid', tx: item.entry.signature, replayed: true });
    expect(world.sent).toEqual([]);
  });

  it('skips a transaction the node reports as failed without fetching it', async () => {
    const failed = await landPayment({ err: { InstructionError: [2, { Custom: 1 }] } });
    expect(await pay()).toMatchObject({ ok: true, outcome: 'paid', replayed: false });
    expect(fetched()).not.toContain(failed.entry.signature);
  });

  it('finds a payment the owner made by hand under the run id, whoever signed it', async () => {
    const owner = await generateKeyPairSigner();
    const [first, second] = await Promise.all(LINES.map(line => associatedTokenAddress(line.to, MINT)));
    if (!first || !second) throw new Error('fixture has two lines');
    const manual = await signedWire(owner, [
      getAddMemoInstruction({ memo: RUN_ID }, { programAddress: PAYOUT_MEMO_PROGRAM_ADDRESS }),
      getTransferInstruction({ source: world.source, destination: first, authority: owner, amount: 1_000_000n }),
      getTransferInstruction({ source: world.source, destination: second, authority: owner, amount: 2_500_000n }),
    ]);
    const { entry } = await world.land(manual.wire, LINES);
    expect(await pay()).toMatchObject({ ok: true, outcome: 'paid', tx: entry.signature, replayed: true });
    expect(world.sent).toEqual([]);
  });
});

describe('commitment', () => {
  let finalizing: SolanaPayoutRail;
  beforeEach(() => {
    finalizing = world.restart({ commitment: 'finalized', confirmTimeoutMs: 20, pollIntervalMs: 5 });
  });

  it('looks for a payment at confirmed even when the rail settles at finalized', async () => {
    world.answers.status = () => ({ ...CONFIRMED, confirmationStatus: 'finalized' });
    await pay({}, finalizing);
    const history = world.node.calls.find(call => call.method === 'getSignaturesForAddress');
    const fetches = world.node.calls.filter(call => call.method === 'getTransaction');
    expect(history?.params[1]).toMatchObject({ commitment: 'confirmed' });
    expect(fetches.map(call => (call.params[1] as { commitment: string }).commitment)).toEqual(['confirmed']);
  });

  it('reports a payment that is confirmed but not finalized as unknown, and sends nothing', async () => {
    const { entry } = await landPayment({ confirmationStatus: 'confirmed' });
    expect(await pay({}, finalizing)).toEqual({
      ok: false,
      outcome: 'unknown',
      tx: entry.signature,
      error: `run ${RUN_ID} is on chain as ${entry.signature} but has not reached finalized yet`,
      replayed: true,
      lineMemos: true,
      cost: null,
    });
    expect(world.sent).toEqual([]);
    await expect(finalizing.findRun(OWNER, RUN_ID)).rejects.toThrow(/has not reached finalized yet/);
  });

  it('reports it as paid once it is finalized', async () => {
    const { entry } = await landPayment({ confirmationStatus: 'confirmed' });
    expect(await pay({}, finalizing)).toMatchObject({ outcome: 'unknown' });
    world.answers.status = () => ({ ...CONFIRMED, confirmationStatus: 'finalized' });
    expect(await pay({}, finalizing)).toMatchObject({ ok: true, outcome: 'paid', tx: entry.signature, replayed: true });
    expect(world.sent).toEqual([]);
  });

  it('refuses when it cannot find out whether the payment is finalized', async () => {
    await landPayment({ confirmationStatus: 'confirmed' });
    world.node.unreachable.add('getSignatureStatuses');
    await expectRefused({}, /connect ECONNREFUSED/, finalizing);
  });

  it('refuses the same run id with different lines while that payment is still settling', async () => {
    const { entry } = await landPayment({ confirmationStatus: 'confirmed' });
    const other = await finalizing.pay({ account: OWNER, lines: [{ to: payee(7), amount: 5n, memo: '' }], runId: RUN_ID });
    expect(other).toMatchObject({ ok: false, outcome: 'refused', tx: null });
    expect(other.error).toBe(`run ${RUN_ID} is already on chain as ${entry.signature} with different lines; nothing was sent for these`);
  });
});

describe('a bound on the search', () => {
  it('finds a payment at or above the bound', async () => {
    const { entry } = await landPayment({ slot: 60 });
    expect(await pay({ notBefore: 60n })).toMatchObject({ ok: true, outcome: 'paid', tx: entry.signature, replayed: true });
  });

  it('stops at the bound without reading what lies below it', async () => {
    world.record(await depositWire(), { slot: 40 });
    expect(await pay({ notBefore: 45n })).toMatchObject({ ok: true, outcome: 'paid', replayed: false });
    expect(fetched()).toEqual([]);
    expect(CREATION_SLOT).toBeLessThan(45);
  });
});
