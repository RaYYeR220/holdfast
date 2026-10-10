import type { PayoutLine } from '@holdfast/core';
import { generateKeyPairSigner } from '@solana/kit';
import { getAddMemoInstruction } from '@solana-program/memo';
import { getTransferCheckedInstruction } from '@solana-program/token';
import { beforeEach, describe, expect, it } from 'vitest';
import { PAYOUT_MEMO_PROGRAM_ADDRESS } from '../src/payout';
import type { SolanaPayoutRail } from '../src/rail';
import { addressOf } from './fake-node';
import {
  CONFIRMED,
  createWorld,
  decodeWire,
  historyEntry,
  LATER_BLOCKHASH,
  MINT,
  OWNER,
  payee,
  recorded,
  signedWire,
  type World,
} from './world';

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

const pay = (lines: PayoutLine[] = LINES, rail: SolanaPayoutRail = world.rail) =>
  rail.pay({ account: OWNER, lines, runId: RUN_ID });
const wires = (): string[] => [...new Set(world.sent.map(sent => sent.wire))];
const firstSignature = (): string => decodeWire(world.sent[0]?.wire ?? '').signature;

/** Pay the run and let the node's history show it. */
async function payAndLand(lines: PayoutLine[] = LINES) {
  const result = await pay(lines);
  await world.land(world.sent[0]?.wire ?? '', lines);
  return result;
}

const COST = { newTokenAccounts: 2, rentLamports: 4_078_560n, feeLamports: 5_000n };

describe.each([
  { asked: 'the rail that paid it', rail: () => world.rail, cost: COST },
  { asked: 'a restarted rail, which has only the chain to go by', rail: () => world.restart(), cost: null },
])('a run that is already paid, asked of $asked', ({ rail, cost }) => {
  it('is answered with the transaction that paid it, and nothing is sent', async () => {
    const first = await payAndLand();
    const second = await pay(LINES, rail());
    expect(first).toMatchObject({ ok: true, outcome: 'paid', replayed: false });
    expect(second).toEqual({
      ok: true,
      outcome: 'paid',
      tx: first.tx,
      error: null,
      replayed: true,
      lineMemos: true,
      cost,
    });
    expect(world.sent).toHaveLength(1);
  });

  it('is recognised even when the allowance it used up is gone', async () => {
    const first = await payAndLand();
    world.fund({ amount: 96_500_000n });
    expect(await pay(LINES, rail())).toMatchObject({ ok: true, outcome: 'paid', tx: first.tx, replayed: true });
    expect(world.sent).toHaveLength(1);
  });

  it('is refused, not paid again, when the lines asked for differ from the lines paid', async () => {
    const first = await payAndLand();
    const again = rail();
    const [one, two] = LINES;
    if (!one || !two) throw new Error('fixture has two lines');
    const variants: PayoutLine[][] = [
      [{ ...one, amount: 1_000_001n }, two],
      [{ ...one, to: payee(5) }, two],
      [{ ...one, memo: 'INV-9999' }, two],
      [two, one],
      [one],
      [one, two, { to: payee(2), amount: 1n, memo: '' }],
    ];
    for (const lines of variants) {
      expect(await pay(lines, again)).toEqual({
        ok: false,
        outcome: 'refused',
        tx: null,
        error: `run ${RUN_ID} was already paid by ${first.tx} with different lines; nothing was sent`,
        replayed: false,
        lineMemos: false,
        cost: null,
      });
    }
    expect(world.sent).toHaveLength(1);
  });

  it('matches on payees and amounts alone when its line memos did not fit on chain', async () => {
    const lines: PayoutLine[] = [];
    for (let index = 0; index < 12; index++) {
      await world.openTokenAccount(payee(index));
      lines.push({ to: payee(index), amount: 1_000n, memo: `INV-${1000 + index} ${'x'.repeat(31)}` });
    }
    const first = await payAndLand(lines);
    const again = rail();
    const reworded = lines.map(line => ({ ...line, memo: 'a different memo' }));
    expect(first).toMatchObject({ ok: true, lineMemos: false });
    expect(await pay(lines, again)).toMatchObject({ ok: true, tx: first.tx, replayed: true, lineMemos: false });
    expect(await pay(reworded, again)).toMatchObject({ ok: true, tx: first.tx, replayed: true });
    expect(world.sent).toHaveLength(1);
  });
});

describe('a rail that has just paid a run', () => {
  it('answers for it from memory, whatever a lagging node says about the history', async () => {
    const first = await pay();
    world.answers.signatures = () => [];
    world.node.calls.length = 0;
    expect(await pay()).toMatchObject({ ok: true, outcome: 'paid', tx: first.tx, replayed: true });
    expect(world.node.calls).toEqual([]);
    expect(world.sent).toHaveLength(1);
  });
});

describe('telling a paid run from something that only looks like one', () => {
  it('pays a run whose id a stranger has sent as a memo to the team account', async () => {
    const stranger = await generateKeyPairSigner();
    const forged = await signedWire(stranger, [
      getAddMemoInstruction({ memo: RUN_ID }, { programAddress: PAYOUT_MEMO_PROGRAM_ADDRESS }),
      getTransferCheckedInstruction({
        source: addressOf(500),
        mint: MINT,
        destination: world.source,
        authority: stranger,
        amount: 3_500_000n,
        decimals: 6,
      }),
    ]);
    world.answers.signatures = () => [historyEntry(forged.signature, `[15] ${RUN_ID}`)];
    world.answers.transaction = () => recorded(forged.wire, { [world.source]: OWNER });

    expect(await pay()).toMatchObject({ ok: true, outcome: 'paid', replayed: false });
    expect(world.sent).toHaveLength(1);
  });

  it('pays a run whose only earlier attempt failed on chain', async () => {
    const failure = { InstructionError: [2, { Custom: 1 }] };
    world.answers.signatures = () => [historyEntry('failed-attempt', `[15] ${RUN_ID}`, failure)];
    expect(await pay()).toMatchObject({ ok: true, outcome: 'paid', replayed: false });
    expect(world.node.methods()).not.toContain('getTransaction');
  });

  it('refuses to pay when the history cannot be read', async () => {
    world.node.unreachable.add('getSignaturesForAddress');
    expect(await pay()).toEqual({
      ok: false,
      outcome: 'refused',
      tx: null,
      error: `could not check whether run ${RUN_ID} was already paid (connect ECONNREFUSED); nothing was sent`,
      replayed: false,
      lineMemos: false,
      cost: null,
    });
    expect(world.sent).toEqual([]);
  });

  it('refuses to pay when a candidate in the history cannot be read', async () => {
    world.answers.signatures = () => [historyEntry('candidate', `[15] ${RUN_ID}`)];
    world.node.unreachable.add('getTransaction');
    expect(await pay()).toMatchObject({ ok: false, outcome: 'refused', tx: null });
    expect(world.sent).toEqual([]);
  });
});

describe('a run whose confirmation timed out', () => {
  beforeEach(async () => {
    world = await createWorld({ confirmTimeoutMs: 20, pollIntervalMs: 5 });
    world.fund({ amount: 100_000_000n, delegate: world.delegate.address, delegatedAmount: 10_000_000n });
    world.node.unreachable.add('getSignatureStatuses');
  });

  it('is reported as unknown with the signature of what was sent', async () => {
    const result = await pay();
    expect(result).toMatchObject({ ok: false, outcome: 'unknown', tx: firstSignature(), replayed: false });
    expect(result.error).toMatch(/was sent and its outcome is unknown \(connect ECONNREFUSED\); it may still pay/);
    expect(result.cost).toEqual({ newTokenAccounts: 2, rentLamports: 4_078_560n, feeLamports: 5_000n });
  });

  it('is found on chain by the next pay, which returns the first signature and sends nothing', async () => {
    const first = await pay();
    await world.land(world.sent[0]?.wire ?? '', LINES);

    const second = await pay();
    expect(first).toMatchObject({ outcome: 'unknown', tx: firstSignature() });
    expect(second).toMatchObject({ ok: true, outcome: 'paid', tx: first.tx, replayed: true, error: null });
    expect(wires()).toHaveLength(1);
  });

  it('is found on chain by the next pay after a restart too', async () => {
    const first = await pay();
    await world.land(world.sent[0]?.wire ?? '', LINES);
    expect(await pay(LINES, world.restart())).toMatchObject({ ok: true, outcome: 'paid', tx: first.tx, replayed: true });
    expect(wires()).toHaveLength(1);
  });

  it('is followed, not sent again, while the first transaction could still land', async () => {
    const first = await pay();
    world.node.unreachable.clear();
    world.answers.status = () => null;
    world.answers.blockHeight = () => 999;
    world.answers.blockhash = () => LATER_BLOCKHASH;

    const second = await pay();
    expect(second).toMatchObject({ ok: false, outcome: 'unknown', tx: first.tx, replayed: true });
    expect(wires()).toHaveLength(1);

    world.answers.status = () => CONFIRMED;
    expect(await pay()).toMatchObject({ ok: true, outcome: 'paid', tx: first.tx, replayed: true });
    expect(wires()).toHaveLength(1);
  });

  it('is sent afresh once the first transaction has provably expired', async () => {
    const first = await pay();
    world.node.unreachable.clear();
    world.answers.status = signature => (signature === first.tx ? null : CONFIRMED);
    world.answers.blockHeight = () => 1_001;
    world.answers.blockhash = () => LATER_BLOCKHASH;

    const second = await pay();
    expect(second).toMatchObject({ ok: true, outcome: 'paid', replayed: false });
    expect(second.tx).not.toBe(first.tx);
    expect(wires()).toHaveLength(2);
  });

  it('is sent afresh once the first transaction has failed on chain', async () => {
    const first = await pay();
    world.node.unreachable.clear();
    const failed = { ...CONFIRMED, err: { InstructionError: [2, { Custom: 1 }] } };
    world.answers.status = signature => (signature === first.tx ? failed : CONFIRMED);
    world.answers.blockhash = () => LATER_BLOCKHASH;

    const second = await pay();
    expect(second).toMatchObject({ ok: true, outcome: 'paid', replayed: false });
    expect(second.tx).not.toBe(first.tx);
  });

  it('is not replaced by different lines under the same run id while it is unsettled', async () => {
    const first = await pay();
    world.node.unreachable.clear();
    world.answers.status = () => null;
    world.answers.blockHeight = () => 999;

    const other = await pay([{ to: payee(7), amount: 5n, memo: '' }]);
    expect(other).toMatchObject({ ok: false, outcome: 'refused', tx: null });
    expect(other.error).toBe(`run ${RUN_ID} was already sent as ${first.tx} with different lines; nothing was sent for these`);
    expect(wires()).toHaveLength(1);
  });
});

describe('two calls for the same run at once', () => {
  it('send one transaction and both report it', async () => {
    const [first, second] = await Promise.all([pay(), pay()]);
    expect(world.sent).toHaveLength(1);
    expect(first).toMatchObject({ ok: true, outcome: 'paid', tx: firstSignature(), replayed: false });
    expect(second).toMatchObject({ ok: true, outcome: 'paid', tx: firstSignature(), replayed: true });
  });

  it('pay one and refuse the other when they ask for different lines', async () => {
    const results = await Promise.all([pay(), pay([{ to: payee(7), amount: 5n, memo: '' }])]);
    const paid = results.filter(result => result.outcome === 'paid');
    const turnedDown = results.filter(result => result.outcome === 'refused');
    expect(paid).toHaveLength(1);
    expect(turnedDown).toHaveLength(1);
    expect(turnedDown[0]?.error).toMatch(/is being paid right now with different lines; nothing was sent for these$/);
    expect(world.sent).toHaveLength(1);
  });

  it('do not get in the way of a different run', async () => {
    const other = world.rail.pay({ account: OWNER, lines: LINES, runId: 'HF-2026-10-0002' });
    const [first, second] = await Promise.all([pay(), other]);
    expect(first).toMatchObject({ ok: true, replayed: false });
    expect(second).toMatchObject({ ok: true, replayed: false });
    expect(wires()).toHaveLength(2);
  });
});
