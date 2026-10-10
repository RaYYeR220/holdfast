import { isInstructionWithAccounts, isInstructionWithData } from '@solana/kit';
import { getMemosFromInstructions } from '@solana-program/memo';
import {
  ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
  parseTransferCheckedInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from '@solana-program/token';
import { beforeEach, describe, expect, it } from 'vitest';
import { MAX_TOKEN_AMOUNT } from '../src/amounts';
import { CONFIRMED, createWorld, decodeWire, OWNER, payee, type World } from './world';

const SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/;
const refused = { slot: 5, blockTime: 1, version: 0, meta: { err: { InstructionError: [1, { Custom: 1 }] } } };

let world: World;
beforeEach(async () => {
  world = await createWorld();
  world.fund({ amount: 100_000_000n, delegate: world.delegate.address, delegatedAmount: 5_750_000n });
  await world.openTokenAccount(payee(0));
});

const probe = () => world.rail.probeOverAllowance({ account: OWNER, to: payee(0) });

function sentTransfer() {
  const { instructions } = decodeWire(world.sent[0]?.wire ?? '');
  const transfer = instructions.find(instruction => instruction.programAddress === TOKEN_PROGRAM_ADDRESS);
  if (!transfer || !isInstructionWithAccounts(transfer) || !isInstructionWithData(transfer)) {
    throw new Error('the probe sent no token instruction');
  }
  return { instructions, transfer: parseTransferCheckedInstruction(transfer) };
}

describe('probeOverAllowance', () => {
  it('sends one base unit more than the allowance, as the delegate, past preflight', async () => {
    world.answers.transaction = () => refused;
    await probe();
    const { instructions, transfer } = sentTransfer();
    expect(world.sent).toHaveLength(1);
    expect(world.sent[0]?.config.skipPreflight).toBe(true);
    expect(transfer.data.amount).toBe(5_750_001n);
    expect(transfer.accounts.source.address).toBe(world.source);
    expect(transfer.accounts.authority.address).toBe(world.delegate.address);
    expect(getMemosFromInstructions(instructions).map(({ memo }) => memo)).toEqual(['holdfast allowance probe']);
  });

  it('reports the refusal the node recorded for the transaction', async () => {
    world.answers.transaction = () => refused;
    expect(await probe()).toEqual({
      signature: decodeWire(world.sent[0]?.wire ?? '').signature,
      failedOnChain: true,
      error: 'instruction 1 failed: custom program error 0x1 (Token program: InsufficientFunds)',
    });
    expect(world.node.calls.find(call => call.method === 'getTransaction')?.params[0]).toMatch(SIGNATURE);
  });

  it('does not claim a refusal when the recorded transaction succeeded', async () => {
    world.answers.transaction = () => ({ ...refused, meta: { err: null } });
    expect(await probe()).toMatchObject({
      failedOnChain: false,
      error: 'the transfer above the allowance was not refused',
    });
  });

  it('does not claim a refusal on the status alone when the transaction cannot be read back', async () => {
    world.answers.status = () => ({ ...CONFIRMED, err: { InstructionError: [1, { Custom: 1 }] } });
    world.answers.transaction = () => null;
    expect(await probe()).toMatchObject({
      signature: expect.stringMatching(SIGNATURE),
      failedOnChain: false,
      error: 'the probe landed but could not be read back',
    });
    expect(world.node.methods().filter(method => method === 'getTransaction')).toHaveLength(10);
  });

  it('does not claim a refusal for a probe that never landed', async () => {
    world.answers.status = () => null;
    world.answers.blockHeight = () => 1_001;
    expect(await probe()).toMatchObject({ failedOnChain: false, error: 'the probe expired before it landed' });
    expect(world.node.methods()).not.toContain('getTransaction');
  });

  it('sends a single base unit when nothing is delegated', async () => {
    world.fund({ amount: 100_000_000n });
    world.answers.transaction = () => ({ ...refused, meta: { err: { InstructionError: [1, { Custom: 4 }] } } });
    const result = await probe();
    expect(sentTransfer().transfer.data.amount).toBe(1n);
    expect(result).toMatchObject({
      failedOnChain: true,
      error: 'instruction 1 failed: custom program error 0x4 (Token program: OwnerMismatch)',
    });
  });

  it('creates the token account of a new payee so the transfer fails for the right reason', async () => {
    world.answers.transaction = () => ({ ...refused, meta: { err: { InstructionError: [2, { Custom: 1 }] } } });
    const result = await world.rail.probeOverAllowance({ account: OWNER, to: payee(5) });
    const { instructions } = decodeWire(world.sent[0]?.wire ?? '');
    expect(instructions[1]?.programAddress).toBe(ASSOCIATED_TOKEN_PROGRAM_ADDRESS);
    expect(result.error).toBe('instruction 2 failed: custom program error 0x1 (Token program: InsufficientFunds)');
  });

  it('can target the team account itself, which no outcome could move tokens out of', async () => {
    world.answers.transaction = () => refused;
    const result = await world.rail.probeOverAllowance({ account: OWNER, to: OWNER });
    const { transfer } = sentTransfer();
    expect(transfer.accounts.destination.address).toBe(world.source);
    expect(result.failedOnChain).toBe(true);
  });

  it('sends nothing when the allowance is already the largest amount there is', async () => {
    world.fund({ amount: 100_000_000n, delegate: world.delegate.address, delegatedAmount: MAX_TOKEN_AMOUNT });
    expect(await probe()).toEqual({
      signature: null,
      failedOnChain: false,
      error: 'the allowance is the largest possible amount',
    });
    expect(world.sent).toEqual([]);
  });

  it('reports an unreachable node instead of throwing', async () => {
    world.node.unreachable.add('getLatestBlockhash');
    expect(await probe()).toEqual({ signature: null, failedOnChain: false, error: 'connect ECONNREFUSED' });
  });
});
