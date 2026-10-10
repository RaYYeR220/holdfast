import type { PayoutLine } from '@holdfast/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { lamportsShort, payoutCost } from '../src/cost';
import { createSolanaPayoutRail } from '../src/rail';
import { createWorld, DELEGATE_SEED, MINT, OWNER, payee, TOKEN_ACCOUNT_RENT, WALLET_RENT, type World } from './world';

const RUN_ID = 'HF-2026-10-0001';
const FEE = 5_000;
const line = (index: number, amount = 1_000n, memo = ''): PayoutLine => ({ to: payee(index), amount, memo });
const lines = (count: number): PayoutLine[] => Array.from({ length: count }, (_, index) => line(index));
const costOf = (newTokenAccounts: number) => ({
  newTokenAccounts,
  rentLamports: BigInt(newTokenAccounts * TOKEN_ACCOUNT_RENT),
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

describe('the SOL of the service key', () => {
  const needed = (newTokenAccounts: number): number => newTokenAccounts * TOKEN_ACCOUNT_RENT + FEE + WALLET_RENT;

  it('must cover the rent and the fee of a run while the key keeps its own rent-exempt minimum', async () => {
    world.answers.balance = () => needed(2) - 1;
    const result = await pay(lines(2));
    expect(result).toMatchObject({ ok: false, outcome: 'refused', tx: null, cost: costOf(2) });
    expect(result.error).toBe(
      `the service key ${world.delegate.address} is 1 lamports short: the run needs 4078560 for rent and 5000 ` +
        `for the fee on top of the 890880 the key must keep, and it holds ${needed(2) - 1}`,
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
    expect((await pay(lines(1))).error).toMatch(/is 895880 lamports short/);
    expect(world.sent).toEqual([]);
  });

  it('is asked for at the commitment the rail works at', async () => {
    await pay(lines(1));
    const call = world.node.calls.find(({ method }) => method === 'getBalance');
    expect(call?.params).toEqual([world.delegate.address, { commitment: 'confirmed' }]);
  });
});

describe('preview', () => {
  it('reports what a run would cost without sending it', async () => {
    await world.openTokenAccount(payee(0));
    expect(await preview([line(0, 1_000n, 'INV-1'), line(1), line(2)])).toEqual({
      ok: true,
      error: null,
      paidBy: null,
      lineMemos: true,
      cost: costOf(2),
    });
    expect(world.sent).toEqual([]);
  });

  it('reports the refusal pay would give, with the cost where it is known', async () => {
    expect(await preview(lines(4))).toMatchObject({ ok: false, cost: costOf(4) });
    expect((await preview(lines(4))).error).toMatch(/^run would create 4 payee token accounts/);
    expect(await preview([line(0, 10_000_001n)])).toEqual({
      ok: false,
      error: 'exceeds delegated allowance: run needs 10.000001, 10 remaining',
      paidBy: null,
      lineMemos: false,
      cost: null,
    });
    expect(await preview([])).toMatchObject({ ok: false, error: 'run has no lines' });
  });

  it('points at the transaction that already paid the run', async () => {
    const run = [line(0, 1_000n, 'INV-1')];
    const paid = await pay(run);
    await world.land(world.sent[0]?.wire ?? '', run);
    expect(await preview(run)).toEqual({ ok: true, error: null, paidBy: paid.tx, lineMemos: true, cost: costOf(1) });
    expect(await world.restart().preview({ account: OWNER, lines: run, runId: RUN_ID })).toEqual({
      ok: true,
      error: null,
      paidBy: paid.tx,
      lineMemos: true,
      cost: null,
    });
    expect(await preview([line(0, 2_000n, 'INV-1')])).toMatchObject({
      ok: false,
      paidBy: paid.tx,
      error: `run ${RUN_ID} was already paid by ${paid.tx} with different lines`,
    });
  });

  it('reports an unreachable node instead of throwing', async () => {
    world.node.unreachable.add('getSignaturesForAddress');
    expect(await preview(lines(1))).toEqual({
      ok: false,
      error: `could not rule out that run ${RUN_ID} was already paid: connect ECONNREFUSED`,
      paidBy: null,
      lineMemos: false,
      cost: null,
    });
  });
});

describe('payoutCost and lamportsShort', () => {
  const rates = { tokenAccount: 2_039_280n, wallet: 890_880n };

  it('charges rent per new token account and one signature fee', () => {
    expect(payoutCost(0, rates)).toEqual({ newTokenAccounts: 0, rentLamports: 0n, feeLamports: 5_000n });
    expect(payoutCost(3, rates)).toEqual({ newTokenAccounts: 3, rentLamports: 6_117_840n, feeLamports: 5_000n });
  });

  it('measures the shortfall against rent, fee and the minimum the key keeps', () => {
    const cost = payoutCost(1, rates);
    expect(lamportsShort(2_935_160n, cost, rates)).toBe(0n);
    expect(lamportsShort(2_935_159n, cost, rates)).toBe(1n);
    expect(lamportsShort(0n, cost, rates)).toBe(2_935_160n);
  });
});
