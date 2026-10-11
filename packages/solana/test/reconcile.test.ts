import type { PayoutLine } from '@holdfast/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { associatedTokenAddress } from '../src/accounts';
import { payoutInstructions, type PayoutPlan } from '../src/payout';
import { readRun } from '../src/reconcile';
import { addressOf } from './fake-node';
import { createWorld, decodeWire, FIRST_LANDING_SLOT, MINT, OWNER, payee, signedWire, type World } from './world';

const RUN_ID = 'HF-2026-10-0001';
const LINES: PayoutLine[] = [
  { to: payee(0), amount: 1_000_000n, memo: 'INV-1041' },
  { to: payee(1), amount: 2_500_000n, memo: 'INV-1042' },
];

let world: World;
beforeEach(async () => {
  world = await createWorld();
});

const planFor = (lines: readonly PayoutLine[], lineMemos = true, runId = RUN_ID): Promise<PayoutPlan> =>
  world.planFor(lines, { runId, lineMemos });

/** Let a payout of `lines` land, as if some rail had paid it. */
async function landRun(lines: readonly PayoutLine[] = LINES, lineMemos = true, runId = RUN_ID) {
  const { wire } = await signedWire(world.delegate, payoutInstructions(await planFor(lines, lineMemos, runId)));
  return world.record(wire);
}

const fetched = (): unknown[] =>
  world.node.calls.filter(call => call.method === 'getTransaction').map(call => call.params[0]);

describe('findRun', () => {
  it('rebuilds a run from the history of the team token account', async () => {
    const { entry } = await landRun();
    expect(entry.memo).toBe('[15] HF-2026-10-0001; [8] INV-1041; [8] INV-1042');

    expect(await world.rail.findRun(OWNER, RUN_ID)).toEqual({
      runId: RUN_ID,
      signature: entry.signature,
      slot: BigInt(FIRST_LANDING_SLOT),
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
    await landRun(LINES, false);
    const found = await world.rail.findRun(OWNER, RUN_ID);
    expect(found?.transfers.map(transfer => transfer.memo)).toEqual([null, null]);
    expect(found?.total).toBe(3_500_000n);
  });

  it('returns null once the whole history is accounted for and no transaction carries the run id', async () => {
    const other = await landRun(LINES, true, 'HF-2026-10-0002');
    expect(await world.rail.findRun(OWNER, RUN_ID)).toBeNull();
    expect(fetched()).not.toContain(other.entry.signature);
  });

  it('only matches the leading memo, not a line memo that quotes a run id', async () => {
    await landRun([{ to: payee(0), amount: 1n, memo: RUN_ID }], true, 'HF-2026-10-0002');
    expect(await world.rail.findRun(OWNER, RUN_ID)).toBeNull();
  });

  it('skips a failed attempt, which keeps its memo in the history', async () => {
    const { wire } = await signedWire(world.delegate, payoutInstructions(await planFor([LINES[0] as PayoutLine])));
    const failed = await world.record(wire, { err: { InstructionError: [4, { Custom: 1 }] } });
    const paid = await landRun();
    expect((await world.rail.findRun(OWNER, RUN_ID))?.signature).toBe(paid.entry.signature);
    expect(fetched()).not.toContain(failed.entry.signature);
  });

  it('pages back through a long history', async () => {
    const paid = await landRun();
    for (let index = 0; index < 1_000; index++) {
      world.history.unshift({
        entry: { ...paid.entry, signature: `unrelated-${index}`, memo: '[5] other', slot: 1_000 + index },
        transaction: null,
      });
    }
    expect((await world.rail.findRun(OWNER, RUN_ID))?.signature).toBe(paid.entry.signature);
    const pages = world.node.calls.filter(call => call.method === 'getSignaturesForAddress');
    expect(pages).toHaveLength(2);
    expect(pages[1]?.params[1]).toMatchObject({ before: 'unrelated-0', limit: 1_000 });
  });

  it('stops at notBefore instead of reading on to the creation of the account', async () => {
    await landRun(LINES, true, 'HF-2026-10-0002');
    expect(await world.rail.findRun(OWNER, RUN_ID, { notBefore: BigInt(FIRST_LANDING_SLOT) })).toBeNull();
    expect(fetched()).toEqual([]);
  });

  it('lets a node failure surface rather than report the run as unpaid', async () => {
    world.node.unreachable.add('getSignaturesForAddress');
    await expect(world.rail.findRun(OWNER, RUN_ID)).rejects.toThrow('connect ECONNREFUSED');
  });
});

describe('checkpoint', () => {
  it('is the slot the chain has finalized, which nothing sent later can precede', async () => {
    world.answers.finalizedSlot = () => 4_242;
    expect(await world.rail.checkpoint()).toBe(4_242n);
    // Kit leaves `finalized` out of a request: it is what a node assumes when no commitment is given.
    expect(world.node.calls.at(-1)).toEqual({ method: 'getSlot', params: [] });
  });
});

describe('readRun', () => {
  const identity = () => ({ runId: RUN_ID, source: world.source });
  const instructionsOf = async (plan: PayoutPlan) =>
    decodeWire((await signedWire(world.delegate, payoutInstructions(plan))).wire).instructions;

  it('pairs each transfer with the memo that directly follows it', async () => {
    const plan = await planFor([
      { to: payee(0), amount: 1n, memo: 'first' },
      { to: payee(1), amount: 2n, memo: '' },
      { to: payee(2), amount: 3n, memo: 'third' },
    ]);
    expect(readRun(await instructionsOf(plan), identity())?.map(({ amount, memo }) => [amount, memo])).toEqual([
      [1n, 'first'],
      [2n, null],
      [3n, 'third'],
    ]);
  });

  it('is null for another run id, and empty for transfers out of another account', async () => {
    const instructions = await instructionsOf(await planFor([{ to: payee(0), amount: 1n, memo: 'x' }]));
    expect(readRun(instructions, identity())).toHaveLength(1);
    expect(readRun(instructions, { ...identity(), runId: 'HF-2026-10-0002' })).toBeNull();
    expect(readRun(instructions, { ...identity(), source: addressOf(602) })).toEqual([]);
  });
});
