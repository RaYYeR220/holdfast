import type { PayoutLine } from '@holdfast/core';
import { isInstructionWithAccounts, isInstructionWithData } from '@solana/kit';
import { getMemosFromInstructions } from '@solana-program/memo';
import { SYSTEM_PROGRAM_ADDRESS } from '@solana-program/system';
import {
  ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
  parseTransferCheckedInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from '@solana-program/token';
import { beforeEach, describe, expect, it } from 'vitest';
import { associatedTokenAddress } from '../src/accounts';
import { PAYOUT_MEMO_PROGRAM_ADDRESS } from '../src/payout';
import { accountInfo, addressOf, NodeError } from './fake-node';
import { CONFIRMED, createWorld, decodeWire, MINT, OWNER, payee, TOKEN_ACCOUNT_RENT, type World } from './world';

const RUN_ID = 'HF-2026-10-0001';
const line = (index: number, amount: bigint, memo = ''): PayoutLine => ({ to: payee(index), amount, memo });

let world: World;
beforeEach(async () => {
  world = await createWorld();
});

const pay = (lines: PayoutLine[], runId = RUN_ID) => world.rail.pay({ account: OWNER, lines, runId });
const broadcasts = (): number => world.node.methods().filter(method => method === 'sendTransaction').length;
const costOf = (newTokenAccounts: number) => ({
  newTokenAccounts,
  rentLamports: BigInt(newTokenAccounts * TOKEN_ACCOUNT_RENT),
  feeLamports: 5_000n,
});

/** Answer with each value once, then keep repeating the last. */
function inTurn<T>(values: readonly T[]): () => T | undefined {
  let next = 0;
  return () => values[Math.min(next++, values.length - 1)];
}

describe('remaining', () => {
  it('is the delegated amount when the delegate is the service key', async () => {
    world.fund({ amount: 100_000_000n, delegate: world.delegate.address, delegatedAmount: 10_000_000n });
    expect(await world.rail.remaining(OWNER)).toEqual({ remaining: 10_000_000n, limit: null, resetsAt: null });
  });

  it('is zero when someone else is the delegate', async () => {
    world.fund({ amount: 100_000_000n, delegate: addressOf(99), delegatedAmount: 10_000_000n });
    expect((await world.rail.remaining(OWNER)).remaining).toBe(0n);
  });

  it('is zero when nothing is delegated', async () => {
    world.fund({ amount: 100_000_000n });
    expect((await world.rail.remaining(OWNER)).remaining).toBe(0n);
  });

  it('is zero when the owner has no token account for the mint', async () => {
    expect((await world.rail.remaining(OWNER)).remaining).toBe(0n);
  });

  it('is zero when the address holds something that is not a token account', async () => {
    world.accounts.set(world.source, accountInfo(SYSTEM_PROGRAM_ADDRESS));
    expect((await world.rail.remaining(OWNER)).remaining).toBe(0n);
  });

  it('reads the associated token account of the owner for the configured mint', async () => {
    await world.rail.remaining(OWNER);
    expect(world.node.calls[0]?.params[0]).toBe(await associatedTokenAddress(OWNER, MINT));
  });

  it('exposes the delegate address the team has to approve', async () => {
    expect(await world.rail.delegate()).toBe(world.delegate.address);
    expect(world.rail.chain).toBe('solana');
  });
});

describe('pay: checks before anything is sent', () => {
  beforeEach(() => {
    world.fund({ amount: 100_000_000n, delegate: world.delegate.address, delegatedAmount: 5_750_000n });
  });

  it('refuses a run that exceeds the delegated allowance', async () => {
    const result = await pay([line(0, 5_000_000n), line(1, 750_001n)]);
    expect(result).toEqual({
      ok: false,
      outcome: 'refused',
      tx: null,
      error: 'exceeds delegated allowance: run needs 5.750001, 5.75 remaining',
      replayed: false,
      lineMemos: false,
      cost: null,
    });
    expect(world.node.methods()).toEqual(['getSignaturesForAddress', 'getAccountInfo']);
  });

  it('refuses every run once the delegation is gone', async () => {
    world.fund({ amount: 100_000_000n });
    const result = await pay([line(0, 1n)]);
    expect(result.error).toBe('exceeds delegated allowance: run needs 0.000001, 0 remaining');
    expect(broadcasts()).toBe(0);
  });

  it('refuses a run the token balance cannot cover even though the allowance could', async () => {
    world.fund({ amount: 1_000_000n, delegate: world.delegate.address, delegatedAmount: 5_750_000n });
    const result = await pay([line(0, 2_000_000n)]);
    expect(result.error).toBe('insufficient token balance: run needs 2, account holds 1');
    expect(broadcasts()).toBe(0);
  });

  it('refuses to pay out of a frozen account', async () => {
    world.fund({ amount: 100_000_000n, delegate: world.delegate.address, delegatedAmount: 5_750_000n, frozen: true });
    expect((await pay([line(0, 1n)])).error).toMatch(/frozen/);
    expect(broadcasts()).toBe(0);
  });

  it('refuses malformed runs without asking the node anything', async () => {
    expect((await pay([])).error).toBe('run has no lines');
    expect((await pay([line(0, 0n)])).error).toMatch(/line 1: invalid amount 0/);
    expect((await pay([line(0, 1n), line(1, -5n)])).error).toMatch(/line 2: invalid amount -5/);
    expect((await pay([line(0, 1n, 'Zahlung für Oktober')])).error).toMatch(/line 1: memo must be printable ASCII/);
    expect((await pay([line(0, 1n)], '')).error).toMatch(/run id: memo is empty/);
    expect((await pay([line(0, 1n)], 'x'.repeat(65))).error).toMatch(/run id: memo is longer/);
    expect(world.node.calls).toEqual([]);
  });

  it('refuses a payee that is not an address', async () => {
    const result = await pay([{ to: 'alice.sol', amount: 1n, memo: '' }]);
    expect(result.error).toBe('line 1: "alice.sol" is not a Solana address');
    expect(broadcasts()).toBe(0);
  });

  it('refuses a payee address that is itself a token account', async () => {
    const tokenAccount = await world.openTokenAccount(payee(0));
    const result = await pay([{ to: tokenAccount, amount: 1n, memo: '' }]);
    expect(result.error).toMatch(/line 1: .* is a token account or mint, not a wallet/);
    expect(broadcasts()).toBe(0);
  });

  it('refuses to pay the team account from itself', async () => {
    const result = await pay([{ to: OWNER, amount: 1n, memo: '' }]);
    expect(result.error).toBe('line 1: the payee is the paying account itself');
    expect(broadcasts()).toBe(0);
  });

  it('refuses a run too large for one transaction instead of splitting it', async () => {
    world.fund({ amount: 100_000_000n, delegate: world.delegate.address, delegatedAmount: 100_000_000n });
    const lines = Array.from({ length: 20 }, (_, index) => line(index, 1_000n));
    for (let index = 0; index < lines.length; index++) await world.openTokenAccount(payee(index));
    const result = await pay(lines);
    expect(result).toMatchObject({ ok: false, outcome: 'refused', tx: null });
    expect(result.error).toMatch(/^run does not fit in one transaction: 20 lines need about 1262 bytes/);
    expect(broadcasts()).toBe(0);
  });

  it('refuses a run far beyond what any transaction holds', async () => {
    world = await createWorld({ maxNewTokenAccountsPerRun: 100 });
    world.fund({ amount: 100_000_000n, delegate: world.delegate.address, delegatedAmount: 100_000_000n });
    const lines = Array.from({ length: 70 }, (_, index) => line(index, 1_000n, `INV-${index}`));
    expect((await pay(lines)).error).toMatch(/^run does not fit in one transaction: 70 lines/);
    expect(broadcasts()).toBe(0);
  });

  it('reports an unreachable node instead of throwing', async () => {
    world.node.unreachable.add('getAccountInfo');
    expect(await pay([line(0, 1n)])).toMatchObject({ ok: false, outcome: 'refused', tx: null, error: 'connect ECONNREFUSED' });
    await expect(world.rail.remaining(OWNER)).rejects.toThrow('connect ECONNREFUSED');
  });

  it('reports a paying account that is not an address instead of throwing', async () => {
    const result = await world.rail.pay({ account: 'treasury', lines: [line(0, 1n)], runId: RUN_ID });
    expect(result).toMatchObject({ ok: false, tx: null });
    expect(world.node.calls).toEqual([]);
  });
});

describe('pay: the transaction it sends', () => {
  beforeEach(() => {
    world.fund({ amount: 100_000_000n, delegate: world.delegate.address, delegatedAmount: 10_000_000n });
  });

  it('pays every line in one transaction signed by the delegate alone', async () => {
    await world.openTokenAccount(payee(1));
    const result = await pay([
      line(0, 1_000_000n, 'INV-1041'),
      line(1, 2_500_000n, 'INV-1042'),
      line(2, 750_000n, 'INV-1043'),
    ]);
    expect(world.sent).toHaveLength(1);
    const sent = world.sent[0];
    if (!sent) throw new Error('nothing was sent');
    const { instructions, signers, accounts } = decodeWire(sent.wire);

    expect(result).toEqual({
      ok: true,
      outcome: 'paid',
      tx: decodeWire(sent.wire).signature,
      error: null,
      replayed: false,
      lineMemos: true,
      cost: costOf(2),
    });
    expect(signers).toEqual([world.delegate.address]);
    expect(accounts).not.toContain(OWNER);
    expect(sent.config.skipPreflight).toBe(false);

    expect(instructions.map(instruction => instruction.programAddress)).toEqual([
      PAYOUT_MEMO_PROGRAM_ADDRESS,
      ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
      TOKEN_PROGRAM_ADDRESS,
      PAYOUT_MEMO_PROGRAM_ADDRESS,
      TOKEN_PROGRAM_ADDRESS,
      PAYOUT_MEMO_PROGRAM_ADDRESS,
      ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
      TOKEN_PROGRAM_ADDRESS,
      PAYOUT_MEMO_PROGRAM_ADDRESS,
    ]);
    expect(getMemosFromInstructions(instructions).map(({ memo }) => memo)).toEqual([
      RUN_ID,
      'INV-1041',
      'INV-1042',
      'INV-1043',
    ]);

    const transfers = instructions.flatMap(instruction =>
      instruction.programAddress === TOKEN_PROGRAM_ADDRESS &&
      isInstructionWithAccounts(instruction) &&
      isInstructionWithData(instruction)
        ? [parseTransferCheckedInstruction(instruction)]
        : [],
    );
    expect(transfers.map(({ data }) => data.amount)).toEqual([1_000_000n, 2_500_000n, 750_000n]);
    for (const [index, { accounts: transferAccounts }] of transfers.entries()) {
      expect(transferAccounts.source.address).toBe(world.source);
      expect(transferAccounts.mint.address).toBe(MINT);
      expect(transferAccounts.destination.address).toBe(await associatedTokenAddress(payee(index), MINT));
      expect(transferAccounts.authority.address).toBe(world.delegate.address);
    }
  });

  it('returns the signature of the transaction it sent', async () => {
    const result = await pay([line(0, 1_000_000n)]);
    expect(result.tx).toBe(decodeWire(world.sent[0]?.wire ?? '').signature);
    expect(result.lineMemos).toBe(false);
  });

  it('creates the token account of a payee paid twice only once', async () => {
    await pay([line(0, 1_000_000n, 'INV-1'), line(0, 2_000_000n, 'INV-2')]);
    const { instructions } = decodeWire(world.sent[0]?.wire ?? '');
    expect(instructions.map(instruction => instruction.programAddress)).toEqual([
      PAYOUT_MEMO_PROGRAM_ADDRESS,
      ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
      TOKEN_PROGRAM_ADDRESS,
      PAYOUT_MEMO_PROGRAM_ADDRESS,
      TOKEN_PROGRAM_ADDRESS,
      PAYOUT_MEMO_PROGRAM_ADDRESS,
    ]);
  });

  it('recreates a payee token account whose address only holds stray lamports', async () => {
    world.accounts.set(await associatedTokenAddress(payee(0), MINT), accountInfo(SYSTEM_PROGRAM_ADDRESS));
    await pay([line(0, 1_000_000n)]);
    const { instructions } = decodeWire(world.sent[0]?.wire ?? '');
    expect(instructions[1]?.programAddress).toBe(ASSOCIATED_TOKEN_PROGRAM_ADDRESS);
  });

  it('drops the line memos, all of them, when the run only fits without', async () => {
    const lines: PayoutLine[] = [];
    for (let index = 0; index < 12; index++) {
      await world.openTokenAccount(payee(index));
      lines.push(line(index, 1_000n, `INV-${1000 + index} ${'x'.repeat(31)}`));
    }
    const result = await pay(lines);
    const { instructions } = decodeWire(world.sent[0]?.wire ?? '');
    expect(result).toMatchObject({ ok: true, outcome: 'paid', lineMemos: false });
    expect(getMemosFromInstructions(instructions).map(({ memo }) => memo)).toEqual([RUN_ID]);
    expect(instructions).toHaveLength(13);
  });
});

describe('pay: what the chain answers', () => {
  beforeEach(() => {
    world.fund({ amount: 100_000_000n, delegate: world.delegate.address, delegatedAmount: 10_000_000n });
  });

  it('reports a transaction that landed and failed, with its signature', async () => {
    world.answers.status = () => ({ ...CONFIRMED, err: { InstructionError: [2, { Custom: 1 }] } });
    const result = await pay([line(0, 1_000_000n)]);
    expect(result).toEqual({
      ok: false,
      outcome: 'failed',
      tx: decodeWire(world.sent[0]?.wire ?? '').signature,
      error: 'instruction 2 failed: custom program error 0x1 (Token program: InsufficientFunds)',
      replayed: false,
      lineMemos: false,
      cost: costOf(1),
    });
  });

  it('reports a failed preflight simulation as not sent', async () => {
    world.answers.send = () => {
      throw new NodeError(-32002, 'Transaction simulation failed', {
        err: { InstructionError: [2, { Custom: 17 }] },
        logs: [],
      });
    };
    const result = await pay([line(0, 1_000_000n)]);
    expect(result).toEqual({
      ok: false,
      outcome: 'refused',
      tx: null,
      error: 'simulation failed: instruction 2 failed: custom program error 0x11 (Token program: AccountFrozen)',
      replayed: false,
      lineMemos: false,
      cost: costOf(1),
    });
    expect(world.node.methods()).not.toContain('getSignatureStatuses');
  });

  it('waits for the commitment level before calling a run paid', async () => {
    world.answers.status = inTurn([null, { ...CONFIRMED, confirmationStatus: 'processed' }, CONFIRMED]);
    const result = await pay([line(0, 1_000_000n)]);
    expect(result.ok).toBe(true);
    expect(world.node.methods().filter(method => method === 'getSignatureStatuses')).toHaveLength(3);
  });

  it('reports a transaction whose blockhash provably expired as failed, never as unknown', async () => {
    world.answers.status = () => null;
    world.answers.blockHeight = () => 1_001;
    const result = await pay([line(0, 1_000_000n)]);
    expect(result).toMatchObject({ ok: false, outcome: 'failed', tx: null });
    expect(result.error).toMatch(/expired without landing; nothing was paid$/);
  });

  it('keeps waiting while the blockhash is still valid, rebroadcasting now and then', async () => {
    world.answers.status = inTurn([null, null, null, null, CONFIRMED]);
    world.answers.blockHeight = () => 999;
    const result = await pay([line(0, 1_000_000n)]);
    expect(result.ok).toBe(true);
    expect(broadcasts()).toBe(2);
    expect(world.sent[1]?.config.skipPreflight).toBe(true);
    expect(world.sent[1]?.wire).toBe(world.sent[0]?.wire);
  });
});
