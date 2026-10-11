import type { PayoutLine } from '@holdfast/core';
import { SYSTEM_PROGRAM_ADDRESS } from '@solana-program/system';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { lamportsShort, payoutCost, totalLamports } from '../src/cost';
import { createSolanaPayoutRail } from '../src/rail';
import { accountInfo } from './fake-node';
import {
  createWorld,
  DELEGATE_SEED,
  MARKER_RENT,
  MINT,
  OWNER,
  payee,
  TOKEN_ACCOUNT_RENT,
  WALLET_RENT,
  type World,
} from './world';

const RUN_ID = 'HF-2026-10-0001';
const FEE = 5_000;
const line = (index: number, amount = 1_000n, memo = ''): PayoutLine => ({ to: payee(index), amount, memo });
const lines = (count: number): PayoutLine[] => Array.from({ length: count }, (_, index) => line(index));
const costOf = (newTokenAccounts: number) => ({
  newTokenAccounts,
  rentLamports: BigInt(newTokenAccounts * TOKEN_ACCOUNT_RENT),
  markerLamports: BigInt(MARKER_RENT),
  feeLamports: BigInt(FEE),
});

let world: World;
async function setUp(overrides: Parameters<typeof createWorld>[0] = {}) {
  world = await createWorld(overrides);
  world.fund({ amount: 100_000_000n, delegate: world.delegate.address, delegatedAmount: 10_000_000n });
}
beforeEach(() => setUp());

const pay = (run: PayoutLine[]) => world.rail.pay({ account: OWNER, lines: run, runId: RUN_ID });
const preview = (run: PayoutLine[]) => world.rail.preview({ account: OWNER, lines: run, runId: RUN_ID });

describe('the limit on token accounts a run may create', () => {
  it('defaults to three', async () => {
    expect(await pay(lines(3))).toMatchObject({ ok: true, outcome: 'paid', cost: costOf(3) });
  });

  it('refuses a run above it before anything is sent, naming the count and the rent', async () => {
    expect(await pay(lines(4))).toEqual({
      ok: false,
      outcome: 'refused',
      tx: null,
      error:
        "run would create 4 payee token accounts at the service key's expense " +
        '(8157120 lamports of rent), the limit is 3 per run',
      replayed: false,
      lineMemos: false,
      cost: costOf(4),
      historyError: null,
    });
    expect(world.sent).toEqual([]);
  });

  it('does not count payees that already have a token account', async () => {
    await world.openTokenAccount(payee(0));
    await world.openTokenAccount(payee(1));
    expect(await pay(lines(5))).toMatchObject({ ok: true, cost: costOf(3) });
  });

  it('counts a payee that is paid twice once', async () => {
    const twice = [line(0), line(0), line(1), line(1), line(2), line(2)];
    expect(await pay(twice)).toMatchObject({ ok: true, cost: costOf(3) });
  });

  it('can be raised, or set to zero to never pay rent for a payee', async () => {
    await setUp({ maxNewTokenAccountsPerRun: 5 });
    expect(await pay(lines(5))).toMatchObject({ ok: true, cost: costOf(5) });

    await setUp({ maxNewTokenAccountsPerRun: 0 });
    expect((await pay(lines(1))).error).toMatch(/^run would create 1 payee token accounts .* the limit is 0 per run$/);
    await world.openTokenAccount(payee(0));
    expect(await pay(lines(1))).toMatchObject({ ok: true, cost: costOf(0) });
  });

  it('must be a whole number that is not negative', () => {
    const config = { rpcUrl: 'http://fake', mint: MINT, decimals: 6, delegateSecretKey: DELEGATE_SEED };
    expect(() => createSolanaPayoutRail({ ...config, maxNewTokenAccountsPerRun: -1 })).toThrow(RangeError);
    expect(() => createSolanaPayoutRail({ ...config, maxNewTokenAccountsPerRun: 1.5 })).toThrow(RangeError);
  });
});

describe('what one run can take from the service key', () => {
  it('includes the rent of its run marker, which a run that creates no token account pays as well', async () => {
    await world.openTokenAccount(payee(0));
    const result = await pay(lines(1));
    expect(result.cost).toEqual({ newTokenAccounts: 0, rentLamports: 0n, markerLamports: 897_840n, feeLamports: 5_000n });
  });

  it('is at most the limit in token account rents, one marker rent and one fee', async () => {
    const { cost } = await pay(lines(3));
    if (!cost) throw new Error('a paid run has a cost');
    expect(totalLamports(cost)).toBe(BigInt(3 * TOKEN_ACCOUNT_RENT + MARKER_RENT + FEE));
    expect(totalLamports(cost)).toBe(7_020_680n);
  });

  it('is only the marker rent and the fee when the limit is zero', async () => {
    await setUp({ maxNewTokenAccountsPerRun: 0 });
    await world.openTokenAccount(payee(0));
    const { cost } = await pay(lines(1));
    if (!cost) throw new Error('a paid run has a cost');
    expect(totalLamports(cost)).toBe(902_840n);
  });
});

describe('the SOL of the service key', () => {
  const needed = (newTokenAccounts: number): number =>
    newTokenAccounts * TOKEN_ACCOUNT_RENT + MARKER_RENT + FEE + WALLET_RENT;

  it('must cover the rent, the marker and the fee of a run while the key keeps its own rent-exempt minimum', async () => {
    world.answers.balance = () => needed(2) - 1;
    const result = await pay(lines(2));
    expect(result).toMatchObject({ ok: false, outcome: 'refused', tx: null, cost: costOf(2) });
    expect(result.error).toBe(
      `the service key ${world.delegate.address} is 1 lamports short: the run needs 4078560 for token account rent, ` +
        `897840 for its run marker and 5000 for the fee on top of the 890880 the key must keep, and it holds ${needed(2) - 1}`,
    );
    expect(world.sent).toEqual([]);
  });

  it('is enough when it covers exactly that', async () => {
    world.answers.balance = () => needed(2);
    expect(await pay(lines(2))).toMatchObject({ ok: true, outcome: 'paid' });
  });

  it('is checked for a run that creates nothing as well', async () => {
    await world.openTokenAccount(payee(0));
    world.answers.balance = () => 0;
    expect((await pay(lines(1))).error).toMatch(/is 1793720 lamports short/);
    expect(world.sent).toEqual([]);
  });

  it('is asked for at the commitment the rail works at', async () => {
    await pay(lines(1));
    const call = world.node.calls.find(({ method }) => method === 'getBalance');
    expect(call?.params).toEqual([world.delegate.address, { commitment: 'confirmed' }]);
  });
});

describe('the rent rates of the cluster', () => {
  const asked = (): number =>
    world.node.methods().filter(method => method === 'getMinimumBalanceForRentExemption').length;
  const payRun = (runId: string) => world.rail.pay({ account: OWNER, lines: lines(1), runId });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('are read once for runs that follow one another closely: a token account, a marker, an empty account', async () => {
    await payRun('HF-2026-10-0001');
    await payRun('HF-2026-10-0002');
    expect(asked()).toBe(3);
  });

  it('are read again after ten minutes, so that a marker is funded at the rate in force', async () => {
    const started = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(started);
    await payRun('HF-2026-10-0001');
    clock.mockReturnValue(started + 600_000);
    await payRun('HF-2026-10-0002');
    expect(asked()).toBe(3);

    clock.mockReturnValue(started + 600_001);
    expect(await payRun('HF-2026-10-0003')).toMatchObject({ ok: true, outcome: 'paid' });
    expect(asked()).toBe(6);
  });

  it('are asked for again after a read that failed', async () => {
    world.node.unreachable.add('getMinimumBalanceForRentExemption');
    expect(await payRun('HF-2026-10-0001')).toMatchObject({ outcome: 'refused', error: 'connect ECONNREFUSED' });
    expect(world.sent).toEqual([]);

    world.node.unreachable.clear();
    expect(await payRun('HF-2026-10-0001')).toMatchObject({ ok: true, outcome: 'paid' });
  });
});

describe('preview', () => {
  const unpaid = { alreadyPaid: false, paidBy: null, historyError: null };

  it('reports what a run would cost without sending it', async () => {
    await world.openTokenAccount(payee(0));
    expect(await preview([line(0, 1_000n, 'INV-1'), line(1), line(2)])).toEqual({
      ...unpaid,
      ok: true,
      error: null,
      lineMemos: true,
      cost: costOf(2),
    });
    expect(world.sent).toEqual([]);
    expect(await world.isMarked(RUN_ID)).toBe(false);
  });

  it('reports the refusal pay would give, with the cost where it is known', async () => {
    expect(await preview(lines(4))).toMatchObject({ ok: false, cost: costOf(4) });
    expect((await preview(lines(4))).error).toMatch(/^run would create 4 payee token accounts/);
    expect(await preview([line(0, 10_000_001n)])).toEqual({
      ...unpaid,
      ok: false,
      error: 'exceeds delegated allowance: run needs 10.000001, 10 remaining',
      lineMemos: false,
      cost: null,
    });
    expect(await preview([])).toMatchObject({ ok: false, error: 'run has no lines' });
  });

  it('points at the transaction that already paid the run', async () => {
    const run = [line(0, 1_000n, 'INV-1')];
    const paid = await pay(run);
    const already = { ok: true, error: null, alreadyPaid: true, paidBy: paid.tx, lineMemos: true, historyError: null };
    expect(await preview(run)).toEqual({ ...already, cost: costOf(1) });
    expect(await world.restart().preview({ account: OWNER, lines: run, runId: RUN_ID })).toEqual({ ...already, cost: null });
    expect(await preview([line(0, 2_000n, 'INV-1')])).toMatchObject({
      ok: false,
      alreadyPaid: true,
      paidBy: paid.tx,
      error: `run ${RUN_ID} was already paid by ${paid.tx} with different lines`,
    });
  });

  it('says a run is paid on the word of its marker when the payment cannot be read', async () => {
    const run = lines(1);
    await pay(run);
    world.node.unreachable.add('getSignaturesForAddress');
    expect(await world.restart().preview({ account: OWNER, lines: run, runId: RUN_ID })).toEqual({
      ok: true,
      error: null,
      alreadyPaid: true,
      paidBy: null,
      lineMemos: false,
      cost: null,
      historyError: `run ${RUN_ID} is marked paid on chain, but its payment could not be read: connect ECONNREFUSED`,
    });
  });

  it('goes ahead when the history cannot be read, and says that it was not', async () => {
    world.node.unreachable.add('getSignaturesForAddress');
    expect(await preview(lines(1))).toEqual({
      ok: true,
      error: null,
      alreadyPaid: false,
      paidBy: null,
      lineMemos: false,
      cost: costOf(1),
      historyError: 'connect ECONNREFUSED',
    });
  });

  it('charges only what the marker address still lacks when somebody has sent lamports there', async () => {
    world.accounts.set(await world.markerOf(RUN_ID), accountInfo(SYSTEM_PROGRAM_ADDRESS, [], WALLET_RENT));
    expect((await preview(lines(1))).cost?.markerLamports).toBe(BigInt(MARKER_RENT - WALLET_RENT));
  });

  it('reports an unreachable node instead of throwing', async () => {
    world.node.unreachable.add('getMultipleAccounts');
    expect(await preview(lines(1))).toEqual({
      ...unpaid,
      ok: false,
      error: 'connect ECONNREFUSED',
      lineMemos: false,
      cost: null,
    });
  });
});

describe('payoutCost and lamportsShort', () => {
  const rates = { tokenAccount: 2_039_280n, marker: 897_840n, wallet: 890_880n };

  it('charges rent per new token account, what the marker takes, and one signature fee', () => {
    expect(payoutCost(0, 897_840n, rates)).toEqual({
      newTokenAccounts: 0,
      rentLamports: 0n,
      markerLamports: 897_840n,
      feeLamports: 5_000n,
    });
    expect(payoutCost(3, 1n, rates)).toEqual({
      newTokenAccounts: 3,
      rentLamports: 6_117_840n,
      markerLamports: 1n,
      feeLamports: 5_000n,
    });
  });

  it('measures the shortfall against rent, marker, fee and the minimum the key keeps', () => {
    const cost = payoutCost(1, 897_840n, rates);
    expect(lamportsShort(3_833_000n, cost, rates)).toBe(0n);
    expect(lamportsShort(3_832_999n, cost, rates)).toBe(1n);
    expect(lamportsShort(0n, cost, rates)).toBe(3_833_000n);
  });
});
