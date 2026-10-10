import {
  generateKeyPairSigner,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  type Address,
  type KeyPairSigner,
} from '@solana/kit';
import { getAddMemoInstruction } from '@solana-program/memo';
import { getTransferCheckedInstruction } from '@solana-program/token';
import { beforeEach, describe, expect, it } from 'vitest';
import { associatedTokenAddress } from '../src/accounts';
import { PAYOUT_MEMO_PROGRAM_ADDRESS, payoutInstructions, type PayoutPlan } from '../src/payout';
import { readRun } from '../src/reconcile';
import { addressOf } from './fake-node';
import { createWorld, decodeWire, MINT, OWNER, payee, signedWire, type World } from './world';

const RUN_ID = 'HF-2026-10-0001';
const MEMO_FIELD = '[15] HF-2026-10-0001; [8] INV-1041; [8] INV-1042';

let world: World;
beforeEach(async () => {
  world = await createWorld();
});

async function planFor(lines: { line: number; amount: bigint; memo: string }[], lineMemos = true): Promise<PayoutPlan> {
  return {
    delegate: world.delegate,
    source: world.source,
    mint: MINT,
    decimals: 6,
    runId: RUN_ID,
    lineMemos,
    transfers: await Promise.all(
      lines.map(async ({ line, amount, memo }) => ({
        payee: payee(line),
        tokenAccount: await associatedTokenAddress(payee(line), MINT),
        amount,
        memo,
        createTokenAccount: true,
      })),
    ),
  };
}

/** A `getTransaction` answer for a wire transaction, with the token balance records a node attaches. */
function recorded(wire: string, wallets: Record<Address, Address>, err: unknown = null) {
  const message = getCompiledTransactionMessageDecoder().decode(
    getTransactionDecoder().decode(getBase64Encoder().encode(wire)).messageBytes,
  );
  const accounts = 'staticAccounts' in message ? message.staticAccounts : [];
  return {
    slot: 77,
    blockTime: 1_791_637_091,
    version: 0,
    transaction: [wire, 'base64'],
    meta: {
      err,
      fee: 5_000,
      postTokenBalances: Object.entries(wallets).map(([tokenAccount, owner]) => ({
        accountIndex: accounts.indexOf(tokenAccount as Address),
        mint: MINT,
        owner,
        uiTokenAmount: { amount: '0', decimals: 6, uiAmountString: '0' },
      })),
    },
  };
}

async function paidRun(lineMemos = true) {
  const plan = await planFor(
    [
      { line: 0, amount: 1_000_000n, memo: 'INV-1041' },
      { line: 1, amount: 2_500_000n, memo: 'INV-1042' },
    ],
    lineMemos,
  );
  const { wire, signature } = await signedWire(world.delegate, payoutInstructions(plan));
  const wallets = Object.fromEntries(plan.transfers.map(transfer => [transfer.tokenAccount, transfer.payee]));
  return { plan, signature, answer: recorded(wire, wallets) };
}

const entry = (signature: string, memo: string | null, err: unknown = null) => ({
  signature,
  memo,
  err,
  slot: 77,
  blockTime: 1_791_637_091,
  confirmationStatus: 'finalized',
});

describe('findRun', () => {
  it('rebuilds a run from the history of the team token account', async () => {
    const run = await paidRun();
    world.answers.signatures = () => [entry(run.signature, MEMO_FIELD)];
    world.answers.transaction = () => run.answer;

    expect(await world.rail.findRun(OWNER, RUN_ID)).toEqual({
      runId: RUN_ID,
      signature: run.signature,
      slot: 77n,
      time: 1_791_637_091_000,
      total: 3_500_000n,
      transfers: [
        { to: payee(0), tokenAccount: await associatedTokenAddress(payee(0), MINT), amount: 1_000_000n, memo: 'INV-1041' },
        { to: payee(1), tokenAccount: await associatedTokenAddress(payee(1), MINT), amount: 2_500_000n, memo: 'INV-1042' },
      ],
    });
    expect(world.node.calls[0]).toEqual({
      method: 'getSignaturesForAddress',
      params: [world.source, { commitment: 'confirmed', limit: 1_000 }],
    });
  });

  it('reports transfers without memos when the run carried only its run memo', async () => {
    const run = await paidRun(false);
    world.answers.signatures = () => [entry(run.signature, '[15] HF-2026-10-0001')];
    world.answers.transaction = () => run.answer;
    const found = await world.rail.findRun(OWNER, RUN_ID);
    expect(found?.transfers.map(transfer => transfer.memo)).toEqual([null, null]);
    expect(found?.total).toBe(3_500_000n);
  });

  it('returns null when no transaction carries the run id', async () => {
    world.answers.signatures = () => [entry('other', '[15] HF-2026-10-0002'), entry('plain', null)];
    expect(await world.rail.findRun(OWNER, RUN_ID)).toBeNull();
    expect(world.node.methods()).not.toContain('getTransaction');
  });

  it('only matches the leading memo, not a line memo that quotes a run id', async () => {
    world.answers.signatures = () => [entry('quoting', '[15] HF-2026-10-0002; [15] HF-2026-10-0001')];
    expect(await world.rail.findRun(OWNER, RUN_ID)).toBeNull();
  });

  it('skips a failed attempt, which keeps its memo in the history', async () => {
    const run = await paidRun();
    world.answers.signatures = () => [
      entry('failed', MEMO_FIELD, { InstructionError: [2, { Custom: 1 }] }),
      entry(run.signature, MEMO_FIELD),
    ];
    world.answers.transaction = signature => (signature === run.signature ? run.answer : null);
    expect((await world.rail.findRun(OWNER, RUN_ID))?.signature).toBe(run.signature);
    expect(world.node.calls.filter(call => call.method === 'getTransaction')).toHaveLength(1);
  });

  it('is not fooled by a stranger who sends the run id as a memo to the team account', async () => {
    const stranger = await generateKeyPairSigner();
    const forged = await signedWire(stranger, [
      getAddMemoInstruction({ memo: RUN_ID }, { programAddress: PAYOUT_MEMO_PROGRAM_ADDRESS }),
      getTransferCheckedInstruction({
        source: addressOf(500),
        mint: MINT,
        destination: world.source,
        authority: stranger,
        amount: 4_250_000n,
        decimals: 6,
      }),
    ]);
    const run = await paidRun();
    world.answers.signatures = () => [entry(forged.signature, '[15] HF-2026-10-0001'), entry(run.signature, MEMO_FIELD)];
    world.answers.transaction = signature =>
      signature === forged.signature ? recorded(forged.wire, { [world.source]: OWNER }) : run.answer;

    expect((await world.rail.findRun(OWNER, RUN_ID))?.signature).toBe(run.signature);

    world.answers.signatures = () => [entry(forged.signature, '[15] HF-2026-10-0001')];
    expect(await world.rail.findRun(OWNER, RUN_ID)).toBeNull();
  });

  it('pages back through a long history', async () => {
    const run = await paidRun();
    const firstPage = Array.from({ length: 1_000 }, (_, index) => entry(`unrelated-${index}`, null));
    world.answers.signatures = ({ before }) => (before ? [entry(run.signature, MEMO_FIELD)] : firstPage);
    world.answers.transaction = () => run.answer;
    expect((await world.rail.findRun(OWNER, RUN_ID))?.signature).toBe(run.signature);
    const pages = world.node.calls.filter(call => call.method === 'getSignaturesForAddress');
    expect(pages).toHaveLength(2);
    expect(pages[1]?.params[1]).toMatchObject({ before: 'unrelated-999', limit: 1_000 });
  });

  it('lets a node failure surface rather than report the run as unpaid', async () => {
    world.node.unreachable.add('getSignaturesForAddress');
    await expect(world.rail.findRun(OWNER, RUN_ID)).rejects.toThrow('connect ECONNREFUSED');
  });
});

describe('readRun', () => {
  let delegate: KeyPairSigner;
  let identity: Parameters<typeof readRun>[1];
  beforeEach(() => {
    delegate = world.delegate;
    identity = { runId: RUN_ID, source: world.source, mint: MINT, delegate: delegate.address };
  });

  const instructionsOf = async (plan: PayoutPlan) =>
    decodeWire((await signedWire(world.delegate, payoutInstructions(plan))).wire).instructions;

  it('pairs each transfer with the memo that directly follows it', async () => {
    const plan = await planFor([
      { line: 0, amount: 1n, memo: 'first' },
      { line: 1, amount: 2n, memo: '' },
      { line: 2, amount: 3n, memo: 'third' },
    ]);
    expect(readRun(await instructionsOf(plan), identity)?.map(({ amount, memo }) => [amount, memo])).toEqual([
      [1n, 'first'],
      [2n, null],
      [3n, 'third'],
    ]);
  });

  it('ignores a run of another delegate, another mint or another team account', async () => {
    const instructions = await instructionsOf(await planFor([{ line: 0, amount: 1n, memo: 'x' }]));
    expect(readRun(instructions, identity)).toHaveLength(1);
    expect(readRun(instructions, { ...identity, delegate: addressOf(600) })).toBeNull();
    expect(readRun(instructions, { ...identity, mint: addressOf(601) })).toBeNull();
    expect(readRun(instructions, { ...identity, source: addressOf(602) })).toBeNull();
    expect(readRun(instructions, { ...identity, runId: 'HF-2026-10-0002' })).toBeNull();
  });
});
