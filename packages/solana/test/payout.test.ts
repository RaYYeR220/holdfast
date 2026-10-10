import {
  AccountRole,
  compileTransactionMessage,
  getInstructionsFromCompiledTransactionMessage,
  isInstructionWithAccounts,
  isInstructionWithData,
  type ResolvedInstruction,
} from '@solana/kit';
import { getMemosFromInstructions } from '@solana-program/memo';
import {
  ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
  parseCreateAssociatedTokenIdempotentInstruction,
  parseTransferCheckedInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from '@solana-program/token';
import { describe, expect, it } from 'vitest';
import { fitsOneTransaction, PAYOUT_MEMO_PROGRAM_ADDRESS, payoutInstructions, payoutMessage } from '../src/payout';
import { DELEGATE, MINT, payeeOf, planOf, RUN_ID, SOURCE, tokenAccountOf } from './fixtures';

/** The instructions as a node would read them back from the wire. */
function compiled(plan: ReturnType<typeof planOf>): ResolvedInstruction[] {
  return getInstructionsFromCompiledTransactionMessage(compileTransactionMessage(payoutMessage(plan)));
}

function parts(instruction: ResolvedInstruction | undefined) {
  if (!instruction || !isInstructionWithAccounts(instruction) || !isInstructionWithData(instruction)) {
    throw new Error('expected an instruction with accounts and data');
  }
  return instruction;
}

const programs = (instructions: readonly ResolvedInstruction[]): string[] =>
  instructions.map(instruction => instruction.programAddress);

describe('payoutInstructions', () => {
  const plan = planOf([
    { memo: 'INV-1041', create: true, amount: 1_000_000n },
    { memo: 'INV-1042', create: false, amount: 2_500_000n },
    { memo: 'INV-1043', create: true, amount: 750_000n },
  ]);

  it('puts the run memo first, then create / transfer / memo for each line in order', () => {
    const instructions = compiled(plan);
    expect(programs(instructions)).toEqual([
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
    expect(getMemosFromInstructions(instructions).map(({ index, memo }) => [index, memo])).toEqual([
      [0, RUN_ID],
      [3, 'INV-1041'],
      [5, 'INV-1042'],
      [8, 'INV-1043'],
    ]);
  });

  it('writes memos with the Memo program every RPC node indexes', () => {
    expect(PAYOUT_MEMO_PROGRAM_ADDRESS).toBe('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
  });

  it('transfers from the team account under the authority of the delegate', () => {
    const instructions = compiled(plan);
    const transfers = [2, 4, 7].map(index => parseTransferCheckedInstruction(parts(instructions[index])));
    expect(transfers.map(({ data }) => data.amount)).toEqual([1_000_000n, 2_500_000n, 750_000n]);
    for (const [line, { accounts, data }] of transfers.entries()) {
      expect(accounts.source).toEqual({ address: SOURCE, role: AccountRole.WRITABLE });
      expect(accounts.mint).toEqual({ address: MINT, role: AccountRole.READONLY });
      expect(accounts.destination).toEqual({ address: tokenAccountOf(line), role: AccountRole.WRITABLE });
      expect(accounts.authority).toEqual({ address: DELEGATE, role: AccountRole.WRITABLE_SIGNER });
      expect(data.decimals).toBe(6);
    }
  });

  it('creates a missing payee token account idempotently, paid for by the delegate', () => {
    const instructions = compiled(plan);
    for (const [index, line] of [
      [1, 0],
      [6, 2],
    ] as const) {
      const { accounts, data } = parseCreateAssociatedTokenIdempotentInstruction(parts(instructions[index]));
      expect(data.discriminator).toBe(1);
      expect(accounts.payer.address).toBe(DELEGATE);
      expect(accounts.ata.address).toBe(tokenAccountOf(line));
      expect(accounts.owner.address).toBe(payeeOf(line));
      expect(accounts.mint.address).toBe(MINT);
      expect(accounts.tokenProgram.address).toBe(TOKEN_PROGRAM_ADDRESS);
    }
  });

  it('carries only the run memo when line memos are left out', () => {
    const instructions = compiled({ ...plan, lineMemos: false });
    expect(getMemosFromInstructions(instructions).map(({ memo }) => memo)).toEqual([RUN_ID]);
    expect(programs(instructions).filter(program => program === TOKEN_PROGRAM_ADDRESS)).toHaveLength(3);
  });

  it('adds no memo instruction for a line without a memo', () => {
    const instructions = payoutInstructions(planOf([{ memo: '' }, { memo: 'INV-7' }]));
    expect(instructions.map(instruction => instruction.programAddress)).toEqual([
      PAYOUT_MEMO_PROGRAM_ADDRESS,
      TOKEN_PROGRAM_ADDRESS,
      TOKEN_PROGRAM_ADDRESS,
      PAYOUT_MEMO_PROGRAM_ADDRESS,
    ]);
  });
});

describe('payoutMessage', () => {
  it('is a v0 message that only the delegate has to sign', () => {
    const message = compileTransactionMessage(payoutMessage(planOf([{ create: true }, { create: false }])));
    expect(message.version).toBe(0);
    expect(message.staticAccounts[0]).toBe(DELEGATE);
    expect(message.header.numSignerAccounts).toBe(1);
    expect('addressTableLookups' in message ? message.addressTableLookups : []).toEqual([]);
  });
});

describe('fitsOneTransaction', () => {
  const run = (lines: number, create: boolean) => planOf(Array.from({ length: lines }, () => ({ create })));

  it('accepts a run up to the byte limit and rejects the first one over it', () => {
    expect(fitsOneTransaction(run(19, false))).toBe(true);
    expect(fitsOneTransaction(run(20, false))).toBe(false);
    expect(fitsOneTransaction(run(9, true))).toBe(true);
    expect(fitsOneTransaction(run(10, true))).toBe(false);
  });

  it('rejects, rather than throws on, a run with more instructions than a transaction may have', () => {
    expect(fitsOneTransaction(run(70, true))).toBe(false);
  });

  it('counts a payee that is paid twice only once', () => {
    const twenty = run(20, false);
    const [first] = twenty.transfers;
    if (!first) throw new Error('fixture has lines');
    const transfers = twenty.transfers.map(transfer => ({ ...transfer, tokenAccount: first.tokenAccount }));
    const repeated = { ...twenty, transfers };
    expect(fitsOneTransaction(repeated)).toBe(true);
  });
});
