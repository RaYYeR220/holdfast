import { assertIsSendableTransaction, getBase64Encoder, getTransactionDecoder } from '@solana/kit';
import { beforeEach, describe, expect, it } from 'vitest';
import { broadcastOf, follow, sendAndConfirm, type SendOptions } from '../src/confirm';
import { connect } from '../src/connection';
import { describeTransactionError } from '../src/errors';
import { memoInstruction } from '../src/payout';
import { NodeError } from './fake-node';
import { CHAIN_SLOT, CONFIRMED, createWorld, signedWire, type World } from './world';

let world: World;
beforeEach(async () => {
  world = await createWorld();
});

const rpc = () => connect({ rpcUrl: 'http://fake', transport: world.node.transport });
const statusQueries = () => world.node.calls.filter(call => call.method === 'getSignatureStatuses');

async function broadcast() {
  const { wire } = await signedWire(world.delegate, [memoInstruction('a transaction to follow')]);
  const transaction = getTransactionDecoder().decode(getBase64Encoder().encode(wire));
  assertIsSendableTransaction(transaction);
  return broadcastOf(transaction, 1_000n);
}

async function send(options: Partial<SendOptions> = {}) {
  const sending = await broadcast();
  const outcome = await sendAndConfirm(rpc(), sending, { commitment: 'confirmed', pollIntervalMs: 0, ...options });
  return { outcome, signature: sending.signature };
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

  it('gets a transaction through by sending it again when the first send was cut off', async () => {
    world.node.unreachable.add('sendTransaction');
    setTimeout(() => world.node.unreachable.clear(), 10);
    const { outcome, signature } = await send({ pollIntervalMs: 5 });
    expect(outcome).toEqual({ status: 'landed', signature, err: null });
    expect(world.landed.has(signature)).toBe(true);
  });
});

describe('expiry', () => {
  beforeEach(() => {
    world.answers.status = () => null;
  });

  it('is declared once the blockhash is past and a caught-up node has no record of the transaction', async () => {
    world.answers.blockHeight = () => 1_001;
    const { outcome, signature } = await send();
    expect(outcome).toEqual({ status: 'expired', signature });
    expect(statusQueries().map(call => call.params[1])).toEqual([
      { searchTransactionHistory: false },
      { searchTransactionHistory: true },
    ]);
  });

  it('is not declared while the blockhash is still valid', async () => {
    world.answers.blockHeight = () => 1_000;
    const { outcome } = await send({ deadlineMs: 20, pollIntervalMs: 5 });
    expect(outcome.status).toBe('unknown');
  });

  it('is not declared on the word of a node that lags behind the chain', async () => {
    world.answers.blockHeight = () => 1_001;
    world.answers.statusSlot = () => CHAIN_SLOT - 1;
    const { outcome } = await send({ deadlineMs: 20, pollIntervalMs: 5 });
    expect(outcome.status).toBe('unknown');
  });

  it('is not declared for a transaction that turns up in the history after all', async () => {
    world.answers.blockHeight = () => 1_001;
    const statuses = [null, CONFIRMED, CONFIRMED];
    world.answers.status = () => statuses.shift();
    expect((await send()).outcome.status).toBe('landed');
  });
});

describe('an outcome that cannot be established', () => {
  it('is reported as unknown, with the signature, when the node goes silent after the send', async () => {
    world.node.unreachable.add('getSignatureStatuses');
    const { outcome, signature } = await send({ deadlineMs: 30, pollIntervalMs: 5 });
    expect(outcome).toEqual({ status: 'unknown', signature, reason: 'connect ECONNREFUSED' });
  });

  it('is settled by following the same transaction again later', async () => {
    const sending = await broadcast();
    world.node.unreachable.add('getSignatureStatuses');
    const options = { commitment: 'confirmed', pollIntervalMs: 0, deadlineMs: 10 } as const;
    expect((await sendAndConfirm(rpc(), sending, options)).status).toBe('unknown');

    world.node.unreachable.clear();
    expect(await follow(rpc(), sending, options)).toEqual({ status: 'landed', signature: sending.signature, err: null });
    expect(world.sent).toHaveLength(1);
  });

  it('rebroadcasts while it waits for a transaction that can still land', async () => {
    const statuses = [null, null, null, null, CONFIRMED];
    let next = 0;
    world.answers.status = () => statuses[Math.min(next++, statuses.length - 1)];
    world.answers.blockHeight = () => 999;
    expect((await send()).outcome.status).toBe('landed');
    expect(world.sent).toHaveLength(2);
    expect(world.sent[1]?.config.skipPreflight).toBe(true);
    expect(world.sent[1]?.wire).toBe(world.sent[0]?.wire);
  });
});
