import type { PayoutLine } from '@holdfast/core';
import { createKeyPairSignerFromPrivateKeyBytes, generateKeyPairSigner, type Address } from '@solana/kit';
import {
  parseAllocateWithSeedInstruction,
  parseTransferSolInstruction,
  SYSTEM_PROGRAM_ADDRESS,
} from '@solana-program/system';
import { getTransferCheckedInstruction, TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import { beforeEach, describe, expect, it } from 'vitest';
import { memoInstruction, PAYOUT_MEMO_PROGRAM_ADDRESS } from '../src/payout';
import { createSolanaPayoutRail, type SolanaPayoutRail } from '../src/rail';
import { accountInfo, addressOf } from './fake-node';
import {
  BLOCKHASH,
  createWorld,
  decodeWire,
  DELEGATE_SEED,
  LATER_BLOCKHASH,
  MARKER_RENT,
  MINT,
  OWNER,
  payee,
  signedWire,
  WALLET_RENT,
  type World,
} from './world';

const RUN_ID = 'HF-2026-10-0001';
const LINES: PayoutLine[] = [
  { to: payee(0), amount: 1_000_000n, memo: 'INV-1041' },
  { to: payee(1), amount: 2_500_000n, memo: 'INV-1042' },
];
const TAKEN = 'instruction 2 failed: custom program error 0x0 (System program: AccountAlreadyInUse)';
const SPENT =
  `run ${RUN_ID} is spent: its marker is set on chain, ` +
  'but the payment could not be read to compare it with these lines';
const FEE_ALONE = { newTokenAccounts: 0, rentLamports: 0n, markerLamports: 0n, feeLamports: 5_000n };

/** The slot from which the service of these tests has set a marker with every payout. */
const MARKERS_FROM = 40n;
/** When the run of these tests was created: after that slot, so a missing marker shows it unpaid. */
const CREATED = 45n;

let world: World;
beforeEach(async () => {
  world = await createWorld({ markersFrom: MARKERS_FROM });
  world.fund({ amount: 100_000_000n, delegate: world.delegate.address, delegatedAmount: 10_000_000n });
});

const pay = (rail: SolanaPayoutRail = world.rail, lines: PayoutLine[] = LINES) =>
  rail.pay({ account: OWNER, lines, runId: RUN_ID, notBefore: CREATED });
const successes = (): number => [...world.landed.values()].filter(outcome => outcome.err === null).length;
const fetched = (): number => world.node.methods().filter(method => method === 'getTransaction').length;

/** The System program instructions of the payout a rail sent. */
function markerInstructionsOf(wire: string) {
  const { instructions } = decodeWire(wire);
  const [, fund, allocate] = instructions;
  if (!fund?.accounts || !fund.data || !allocate?.accounts || !allocate.data) throw new Error('not a payout');
  return {
    fund: parseTransferSolInstruction({ ...fund, accounts: fund.accounts, data: fund.data }),
    allocate: parseAllocateWithSeedInstruction({ ...allocate, accounts: allocate.accounts, data: allocate.data }),
  };
}

describe('the run marker', () => {
  it('is set by the payout itself: one byte in a System-owned account that holds exactly its rent', async () => {
    expect(await world.isMarked(RUN_ID)).toBe(false);
    await pay();
    expect(world.accounts.get(await world.markerOf(RUN_ID))).toMatchObject({
      owner: SYSTEM_PROGRAM_ADDRESS,
      space: 1,
      lamports: MARKER_RENT,
    });
  });

  it('sits at an address derived from the service key, the team wallet, the mint and the run id', async () => {
    await pay();
    const { fund, allocate } = markerInstructionsOf(world.sent[0]?.wire ?? '');
    const marker = await world.markerOf(RUN_ID);
    expect(fund.accounts.destination.address).toBe(marker);
    expect(allocate.accounts.newAccount.address).toBe(marker);
    expect(allocate.data.base).toBe(world.delegate.address);
    expect(await world.markerOf('HF-2026-10-0002')).not.toBe(marker);
    expect(await world.markerOf(RUN_ID, addressOf(77))).not.toBe(marker);
  });

  it('is not set by a payout that fails', async () => {
    world.answers.failsOnChain = () => ({ InstructionError: [4, { Custom: 1 }] });
    expect(await pay()).toMatchObject({ outcome: 'failed' });
    expect(await world.isMarked(RUN_ID)).toBe(false);
  });

  it('shows that the run id is spent and not what was paid: with nothing to compare, the answer is unknown', async () => {
    await pay();
    world.history.length = 0;
    const result = await pay(world.restart());
    expect(result).toMatchObject({ ok: false, outcome: 'unknown', tx: null, replayed: true });
    expect(result.historyError).toBe(`the history of ${world.source} shows no payment under that run id`);
    expect(world.sent).toHaveLength(1);
  });

  it('cannot be read: the run is refused rather than sent blind', async () => {
    world.node.unreachable.add('getMultipleAccounts');
    expect(await pay()).toMatchObject({ ok: false, outcome: 'refused', tx: null, error: 'connect ECONNREFUSED' });
    expect(world.sent).toEqual([]);
  });
});

describe('a stranger who sends lamports to the marker address first', () => {
  it('does not block the run: the payout adds only what is missing for rent', async () => {
    const marker = await world.markerOf(RUN_ID);
    world.accounts.set(marker, accountInfo(SYSTEM_PROGRAM_ADDRESS, [], WALLET_RENT));

    const result = await pay();
    expect(result).toMatchObject({ ok: true, outcome: 'paid' });
    expect(result.cost?.markerLamports).toBe(BigInt(MARKER_RENT - WALLET_RENT));
    expect(markerInstructionsOf(world.sent[0]?.wire ?? '').fund.data.amount).toBe(BigInt(MARKER_RENT - WALLET_RENT));
    expect(world.accounts.get(marker)).toMatchObject({ space: 1, lamports: MARKER_RENT });
  });

  it('does not make the run look paid: lamports alone are not a marker', async () => {
    world.accounts.set(await world.markerOf(RUN_ID), accountInfo(SYSTEM_PROGRAM_ADDRESS, [], 5 * MARKER_RENT));
    expect(await world.isMarked(RUN_ID)).toBe(false);
    expect(await pay()).toMatchObject({ ok: true, outcome: 'paid', replayed: false });
    expect(world.sent).toHaveLength(1);
  });

  it('is still sent one lamport when the address already holds the whole rent', async () => {
    const marker = await world.markerOf(RUN_ID);
    world.accounts.set(marker, accountInfo(SYSTEM_PROGRAM_ADDRESS, [], MARKER_RENT));
    const result = await pay();
    expect(result.cost?.markerLamports).toBe(1n);
    expect(world.accounts.get(marker)).toMatchObject({ space: 1, lamports: MARKER_RENT + 1 });
  });
});

describe('a second payout of a paid run', () => {
  it('is not sent: the marker answers for it', async () => {
    const first = await pay();
    const second = await pay(world.restart());
    expect(second).toMatchObject({ ok: true, outcome: 'paid', tx: first.tx, replayed: true, historyError: null });
    expect(world.sent).toHaveLength(1);
  });

  it('is neither sent again nor called paid when its payment cannot be read to compare', async () => {
    await pay();
    world.node.unreachable.add('getSignaturesForAddress');
    expect(await pay(world.restart())).toEqual({
      ok: false,
      outcome: 'unknown',
      tx: null,
      error: `${SPENT}; nothing was sent`,
      replayed: true,
      lineMemos: false,
      cost: null,
      historyError: 'connect ECONNREFUSED',
    });
    expect(world.sent).toHaveLength(1);
  });

  it('is answered no differently for other lines while its payment cannot be read', async () => {
    await pay();
    world.node.unreachable.add('getSignaturesForAddress');
    const other = await pay(world.restart(), [{ to: payee(5), amount: 9n, memo: '' }]);
    expect(other).toMatchObject({ ok: false, outcome: 'unknown', tx: null, error: `${SPENT}; nothing was sent` });
    expect(world.sent).toHaveLength(1);
  });

  it('is called paid again as soon as its payment can be read and matches', async () => {
    const first = await pay();
    const rail = world.restart();
    world.node.unreachable.add('getSignaturesForAddress');
    expect(await pay(rail)).toMatchObject({ outcome: 'unknown' });
    world.node.unreachable.clear();
    expect(await pay(rail)).toMatchObject({ ok: true, outcome: 'paid', tx: first.tx, replayed: true });
    expect(world.sent).toHaveLength(1);
  });

  it('is refused with other lines when the history shows what was paid', async () => {
    const first = await pay();
    const other = await pay(world.restart(), [{ to: payee(5), amount: 9n, memo: '' }]);
    expect(other).toMatchObject({ ok: false, outcome: 'refused', tx: null });
    expect(other.error).toBe(`run ${RUN_ID} was already paid by ${first.tx} with different lines; nothing was sent`);
    expect(world.sent).toHaveLength(1);
  });
});

describe('two rails that pay the same run at once', () => {
  let other: SolanaPayoutRail;
  beforeEach(() => {
    other = world.restart();
    // Each rail signs over a blockhash of its own, so these are two transactions and not one sent twice.
    let asked = 0;
    world.answers.blockhash = () => (asked++ % 2 === 0 ? BLOCKHASH : LATER_BLOCKHASH);
  });

  it('get one payment between them when both transactions land', async () => {
    world.answers.stalePreflight = () => true;
    const results = await Promise.all([pay(world.rail), pay(other)]);

    expect(new Set(world.sent.map(sent => sent.wire)).size).toBe(2);
    expect(world.landed.size).toBe(2);
    expect(successes()).toBe(1);
    expect([...world.landed.values()].map(outcome => outcome.err)).toContainEqual({
      InstructionError: [2, { Custom: 0 }],
    });
    const [winner] = results.filter(result => !result.replayed);
    const [loser, ...others] = results.filter(result => result.replayed);
    expect(others).toEqual([]);
    for (const result of results) expect(result).toMatchObject({ ok: true, outcome: 'paid', tx: winner?.tx });
    // The loser's transaction failed as a whole: all it cost is its fee.
    expect(loser?.cost).toEqual(FEE_ALONE);
  });

  it('get one payment between them when they ask for different lines, and the loser is told which', async () => {
    world.answers.stalePreflight = () => true;
    const results = await Promise.all([pay(world.rail), pay(other, [{ to: payee(5), amount: 9n, memo: '' }])]);

    expect(successes()).toBe(1);
    const [winner] = results.filter(result => result.outcome === 'paid');
    const [loser] = results.filter(result => result.outcome === 'refused');
    const [failed] = [...world.landed].filter(([, outcome]) => outcome.err !== null).map(([signature]) => signature);
    expect(winner).toMatchObject({ ok: true, replayed: false });
    expect(loser?.error).toBe(
      `run ${RUN_ID} was already paid by ${winner?.tx} with different lines; ` +
        `transaction ${failed} was sent for these, failed, and moved nothing`,
    );
  });

  it('get one payment between them when the second is stopped at preflight', async () => {
    const results = await Promise.all([pay(world.rail), pay(other)]);
    expect(world.landed.size).toBe(1);
    expect(successes()).toBe(1);
    expect(results.filter(result => result.replayed)).toHaveLength(1);
    for (const result of results) expect(result).toMatchObject({ ok: true, outcome: 'paid' });
    expect(new Set(results.map(result => result.tx)).size).toBe(1);
  });

  it('report the loser as unknown, not as paid, when the winner cannot be read to compare', async () => {
    world.answers.stalePreflight = () => true;
    world.node.unreachable.add('getSignaturesForAddress');
    const results = await Promise.all([pay(world.rail), pay(other)]);

    expect(successes()).toBe(1);
    const [failed] = [...world.landed].filter(([, outcome]) => outcome.err !== null).map(([signature]) => signature);
    expect(results.filter(result => result.outcome === 'paid')).toHaveLength(1);
    expect(results.find(result => result.replayed)).toEqual({
      ok: false,
      outcome: 'unknown',
      tx: null,
      error: `${SPENT}; transaction ${failed} was sent for these, failed, and moved nothing`,
      replayed: true,
      lineMemos: false,
      cost: FEE_ALONE,
      historyError: 'connect ECONNREFUSED',
    });
  });
});

describe('a service key that was rotated', () => {
  const laterKey = new Uint8Array(32).fill(9);
  let laterDelegate: Address;
  beforeEach(async () => {
    laterDelegate = (await createKeyPairSignerFromPrivateKeyBytes(laterKey)).address;
    await pay();
    world.fund({ amount: 96_500_000n, delegate: laterDelegate, delegatedAmount: 10_000_000n });
    world.accounts.set(laterDelegate, accountInfo(SYSTEM_PROGRAM_ADDRESS, [], 1_000_000_000));
    world.answers.blockhash = () => LATER_BLOCKHASH;
  });

  it('still sees the runs paid under the earlier key when that key is listed', async () => {
    const rail = world.restart({ delegateSecretKey: laterKey, previousDelegates: [world.delegate.address] });
    world.node.unreachable.add('getSignaturesForAddress');
    expect(await pay(rail)).toMatchObject({ ok: false, outcome: 'unknown', error: `${SPENT}; nothing was sent` });

    world.node.unreachable.clear();
    expect(await pay(rail)).toMatchObject({ ok: true, outcome: 'paid', replayed: true });
    expect(world.sent).toHaveLength(1);
  });

  it('has markers of its own, so an earlier key that is not listed is only covered by history', async () => {
    const rail = world.restart({ delegateSecretKey: laterKey });
    expect(await world.isMarked(RUN_ID, laterDelegate)).toBe(false);
    expect(await pay(rail)).toMatchObject({ ok: true, outcome: 'paid', replayed: true });
    expect(world.sent).toHaveLength(1);
  });

  it('does not pay a run of the earlier, unlisted key again when history cannot be read and nothing bounds the run', async () => {
    world.node.unreachable.add('getSignaturesForAddress');
    const rail = world.restart({ delegateSecretKey: laterKey });
    const blind = await rail.pay({ account: OWNER, lines: LINES, runId: RUN_ID });
    expect(blind).toMatchObject({ ok: false, outcome: 'refused', tx: null });
    expect(blind.error).toBe(
      `could not rule out that run ${RUN_ID} was already paid: connect ECONNREFUSED; nothing was sent`,
    );
    expect(world.sent).toHaveLength(1);
  });
});

describe('a team token account flooded with dust', () => {
  async function flood(count: number, memo?: string): Promise<void> {
    const stranger = await generateKeyPairSigner();
    const transfer = getTransferCheckedInstruction({
      source: addressOf(500),
      mint: MINT,
      destination: world.source,
      authority: stranger,
      amount: 1n,
      decimals: 6,
    });
    const { wire } = await signedWire(stranger, [transfer]);
    const item = await world.record(wire);
    const listedMemo = memo === undefined ? null : `[${memo.length}] ${memo}`;
    for (let index = 0; index < count; index++) {
      const entry = { ...item.entry, signature: `dust-${index}`, memo: listedMemo };
      world.history.unshift({ entry, transaction: item.transaction });
    }
  }

  it('does not hold a run up: the run is paid on its marker and the result says history was not read', async () => {
    await flood(60);
    const result = await pay();
    expect(result).toMatchObject({ ok: true, outcome: 'paid', replayed: false });
    expect(result.historyError).toMatch(/^more than 10 transactions of .* would have to be read to rule run .* out/);
    expect(world.sent).toHaveLength(1);
    expect(fetched()).toBe(10);
  });

  it('does not hold a run up when the dust carries the run id as its memo', async () => {
    await flood(60, RUN_ID);
    expect(await pay()).toMatchObject({ ok: true, outcome: 'paid', replayed: false });
    expect(world.sent).toHaveLength(1);
    expect(fetched()).toBe(10);
  });

  it('does not make a paid run payable again, nor lets it be called paid unread', async () => {
    await pay();
    await flood(60, RUN_ID);
    const again = await pay(world.restart());
    expect(again).toMatchObject({ ok: false, outcome: 'unknown', replayed: true, tx: null });
    expect(again.historyError).toMatch(/^more than 50 transactions of .* would have to be read/);
    expect(world.sent).toHaveLength(1);
  });

  it('does hold up a run that could be older than the markers, which is what naming their slot is for', async () => {
    await flood(60);
    const result = await world.rail.pay({ account: OWNER, lines: LINES, runId: RUN_ID });
    expect(result).toMatchObject({ ok: false, outcome: 'refused', tx: null });
    expect(result.error).toMatch(/^could not rule out that run .* was already paid: more than 50 transactions of /);
    expect(world.sent).toEqual([]);
    expect(fetched()).toBe(50);
  });
});

describe('a missing marker', () => {
  const blind = (rail: SolanaPayoutRail, notBefore?: bigint) => {
    world.node.unreachable.add('getSignaturesForAddress');
    return rail.pay({ account: OWNER, lines: LINES, runId: RUN_ID, ...(notBefore === undefined ? {} : { notBefore }) });
  };
  const UNPROVEN = `could not rule out that run ${RUN_ID} was already paid: connect ECONNREFUSED; nothing was sent`;

  it('is enough to send a run created at the slot the markers start from, whatever history says', async () => {
    const result = await blind(world.rail, MARKERS_FROM);
    expect(result).toMatchObject({ ok: true, outcome: 'paid', replayed: false, historyError: 'connect ECONNREFUSED' });
    expect(world.sent).toHaveLength(1);
  });

  it('is not enough for a run created one slot before that', async () => {
    expect(await blind(world.rail, MARKERS_FROM - 1n)).toEqual({
      ok: false,
      outcome: 'refused',
      tx: null,
      error: UNPROVEN,
      replayed: false,
      lineMemos: false,
      cost: null,
      historyError: 'connect ECONNREFUSED',
    });
    expect(world.sent).toEqual([]);
  });

  it('is not enough for a run that does not say when it was created', async () => {
    expect(await blind(world.rail)).toMatchObject({ ok: false, outcome: 'refused', error: UNPROVEN });
    expect(world.sent).toEqual([]);
  });

  it('is not enough on a rail that names no slot the markers start from', async () => {
    const unnamed = await createWorld();
    unnamed.fund({ amount: 100_000_000n, delegate: unnamed.delegate.address, delegatedAmount: 10_000_000n });
    unnamed.node.unreachable.add('getSignaturesForAddress');
    const result = await unnamed.rail.pay({ account: OWNER, lines: LINES, runId: RUN_ID, notBefore: CREATED });
    expect(result).toMatchObject({ ok: false, outcome: 'refused', error: UNPROVEN });
    expect(unnamed.sent).toEqual([]);
  });

  it('still lets such a run through once history proves it unpaid', async () => {
    const result = await world.rail.pay({ account: OWNER, lines: LINES, runId: RUN_ID });
    expect(result).toMatchObject({ ok: true, outcome: 'paid', replayed: false, historyError: null });
  });

  it('cannot start from a slot that is not one', () => {
    const config = { rpcUrl: 'http://fake', mint: MINT, decimals: 6, delegateSecretKey: DELEGATE_SEED };
    expect(() => createSolanaPayoutRail({ ...config, markersFrom: -1n })).toThrow(RangeError);
  });
});

describe('a run that was paid without a marker', () => {
  it('still counts as paid when the history shows it', async () => {
    const owner = await generateKeyPairSigner();
    const byHand = await signedWire(owner, [
      memoInstruction(RUN_ID),
      ...(await Promise.all(
        LINES.map(async line =>
          getTransferCheckedInstruction({
            source: world.source,
            mint: MINT,
            destination: await world.openTokenAccount(line.to as Address),
            authority: owner,
            amount: line.amount,
            decimals: 6,
          }),
        ),
      )),
    ]);
    const { entry } = await world.record(byHand.wire);

    expect(await world.isMarked(RUN_ID)).toBe(false);
    expect(await pay()).toMatchObject({ ok: true, outcome: 'paid', tx: entry.signature, replayed: true });
    expect(world.sent).toEqual([]);
  });
});

describe('probeRepeatRun', () => {
  const probe = (rail: SolanaPayoutRail = world.rail) =>
    rail.probeRepeatRun({ account: OWNER, lines: LINES, runId: RUN_ID });

  it('sends nothing for a run that is not marked paid, because that repeat would pay', async () => {
    expect(await probe()).toEqual({
      signature: null,
      failedOnChain: false,
      error: `run ${RUN_ID} has no run marker under the service key in use, so a repeat of it could pay; nothing was sent`,
    });
    expect(world.sent).toEqual([]);
  });

  it('sends nothing when the run is only marked under an earlier service key', async () => {
    await pay();
    const laterKey = new Uint8Array(32).fill(9);
    const rail = world.restart({ delegateSecretKey: laterKey, previousDelegates: [world.delegate.address] });
    expect(await probe(rail)).toMatchObject({ signature: null, failedOnChain: false });
    expect(world.sent).toHaveLength(1);
  });

  it('sends the payout again past preflight and reports that the System program refused the marker', async () => {
    await pay();
    world.answers.blockhash = () => LATER_BLOCKHASH;
    const result = await probe();

    const repeat = world.sent[1];
    if (!repeat) throw new Error('the probe sent nothing');
    expect(repeat.config.skipPreflight).toBe(true);
    expect(result).toEqual({ signature: decodeWire(repeat.wire).signature, failedOnChain: true, error: TAKEN });
    expect(world.landed.get(result.signature ?? '')).toEqual({ err: { InstructionError: [2, { Custom: 0 }] } });
    expect(successes()).toBe(1);
  });

  it('carries the transfers of the run and nothing that creates a token account', async () => {
    await pay();
    world.answers.blockhash = () => LATER_BLOCKHASH;
    await probe();
    const programs = decodeWire(world.sent[1]?.wire ?? '').instructions.map(instruction => instruction.programAddress);
    expect(programs).toEqual([
      PAYOUT_MEMO_PROGRAM_ADDRESS,
      SYSTEM_PROGRAM_ADDRESS,
      SYSTEM_PROGRAM_ADDRESS,
      TOKEN_PROGRAM_ADDRESS,
      TOKEN_PROGRAM_ADDRESS,
    ]);
  });

  it('leaves the marker as it was', async () => {
    await pay();
    const marker = await world.markerOf(RUN_ID);
    const before = world.accounts.get(marker);
    world.answers.blockhash = () => LATER_BLOCKHASH;
    await probe();
    expect(world.accounts.get(marker)).toEqual(before);
  });

  it('reports a run that is not well formed without sending', async () => {
    const result = await world.rail.probeRepeatRun({ account: OWNER, lines: [], runId: RUN_ID });
    expect(result).toEqual({ signature: null, failedOnChain: false, error: 'run has no lines' });
  });

  it('reports an unreachable node instead of throwing', async () => {
    world.node.unreachable.add('getAccountInfo');
    expect(await probe()).toEqual({ signature: null, failedOnChain: false, error: 'connect ECONNREFUSED' });
  });
});
