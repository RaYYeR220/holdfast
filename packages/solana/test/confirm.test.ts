import { assertIsSendableTransaction, getBase64Encoder, getTransactionDecoder } from '@solana/kit';
import { beforeEach, describe, expect, it } from 'vitest';
import { sendAndConfirm, type SendOptions } from '../src/confirm';
import { connect } from '../src/connection';
import { describeTransactionError } from '../src/errors';
import { payoutInstructions } from '../src/payout';
import { NodeError } from './fake-node';
import { planOf } from './fixtures';
import { CONFIRMED, createWorld, signedWire, type World } from './world';

let world: World;
beforeEach(async () => {
  world = await createWorld();
});

async function send(options: Partial<SendOptions> = {}) {
  const plan = planOf([{}], { delegate: world.delegate });
  const { wire, signature } = await signedWire(world.delegate, payoutInstructions(plan));
  const transaction = getTransactionDecoder().decode(getBase64Encoder().encode(wire));
  assertIsSendableTransaction(transaction);
  const rpc = connect({ rpcUrl: 'http://fake', transport: world.node.transport });
  const outcome = await sendAndConfirm(rpc, transaction, {
    commitment: 'confirmed',
    lastValidBlockHeight: 1_000n,
    pollIntervalMs: 0,
    ...options,
  });
  return { outcome, signature };
}

describe('sendAndConfirm', () => {
  it('reports a landed transaction with the verdict of the chain', async () => {
    const ok = await send();
    expect(ok.outcome).toEqual({ status: 'landed', signature: ok.signature, err: null });

    world.answers.status = () => ({ ...CONFIRMED, err: { InstructionError: [0, 'InvalidAccountData'] } });
    const { outcome } = await send();
    if (outcome.status !== 'landed' || outcome.err === null) throw new Error('expected a landed failure');
    expect(describeTransactionError(outcome.err)).toBe('instruction 0 failed: InvalidAccountData');
  });

  it('holds out for finality when asked to', async () => {
    let polls = 0;
    world.answers.status = () => ({ ...CONFIRMED, confirmationStatus: ++polls < 4 ? 'confirmed' : 'finalized' });
    expect((await send({ commitment: 'finalized' })).outcome.status).toBe('landed');
    expect(polls).toBe(4);
  });

  it('throws when the node refuses the transaction, since nothing was broadcast', async () => {
    world.answers.send = () => {
      throw new NodeError(-32002, 'Transaction simulation failed', { err: 'BlockhashNotFound', logs: [] });
    };
    await expect(send()).rejects.toThrow();
    expect(world.node.methods()).toEqual(['sendTransaction']);
  });

  it('keeps following a transaction whose send request was cut off', async () => {
    world.node.unreachable.add('sendTransaction');
    setTimeout(() => world.node.unreachable.clear(), 5);
    const { outcome } = await send({ pollIntervalMs: 10 });
    expect(outcome.status).toBe('landed');
  });

  it('reports expiry only after a last look through the transaction history', async () => {
    world.answers.status = () => null;
    world.answers.blockHeight = () => 1_001;
    const { outcome, signature } = await send();
    expect(outcome).toEqual({ status: 'expired', signature });
    const statusCalls = world.node.calls.filter(call => call.method === 'getSignatureStatuses');
    expect(statusCalls.map(call => call.params[1])).toEqual([
      { searchTransactionHistory: false },
      { searchTransactionHistory: true },
    ]);
  });

  it('does not call a transaction expired when it turns up in that last look', async () => {
    const statuses = [null, CONFIRMED, CONFIRMED];
    world.answers.status = () => statuses.shift();
    world.answers.blockHeight = () => 1_001;
    expect((await send()).outcome.status).toBe('landed');
  });

  it('admits it does not know when the node goes silent after the send', async () => {
    world.node.unreachable.add('getSignatureStatuses');
    const { outcome, signature } = await send({ deadlineMs: 30, pollIntervalMs: 5 });
    expect(outcome).toEqual({ status: 'unknown', signature, reason: 'connect ECONNREFUSED' });
  });
});
