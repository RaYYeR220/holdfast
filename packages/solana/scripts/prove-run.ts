import assert from 'node:assert/strict';
import type { PayoutLine } from '@holdfast/core';
import { getTransferSolInstruction, SYSTEM_PROGRAM_ADDRESS } from '@solana-program/system';
import { totalLamports } from '../src/cost';
import {
  associatedTokenAddress,
  createSolanaPayoutRail,
  runMarker,
  runMarkerSeed,
  type PayoutPreview,
  type PayoutRun,
  type RunInput,
  type RunMarker,
  type SolanaPayoutResult,
} from '../src/index';
import { MARKER_SPACE } from '../src/marker';
import { submit, submitToBeRefused, type RefusedOnChain } from './chain';
import {
  allocationUnderBase,
  allocationWithoutBaseSignature,
  describeMarker,
  readMarker,
  type MarkerState,
} from './marker-checks';
import { eventually, readLanded, type Proving } from './proving';

export const RUN_ID = 'HF-2026-10-0001';

export interface RunProof {
  priced: PayoutPreview;
  refusedOverAccountLimit: SolanaPayoutResult;
  /** The marker of the run: where it is, what was sent there ahead of the run, and what it held once paid. */
  marker: { address: string; seed: string; rent: bigint; prefunded: bigint; afterPayout: MarkerState };
  allocationByAnotherKey: RefusedOnChain;
  allocationUnderOwnBase: RefusedOnChain;
  pricedAfterPrefunding: PayoutPreview;
  remainingAfterRun: bigint;
  payout: SolanaPayoutResult;
  /** Lamports that left the service key in the payout transaction, as the chain recorded them. */
  payoutSpent: bigint;
  run: PayoutRun;
  replay: SolanaPayoutResult;
  replayAfterRestart: SolanaPayoutResult;
  refusedDifferentLines: SolanaPayoutResult;
}

/**
 * Pay one run of three lines out of an allowance of 10.00, with somebody
 * else's lamports already sitting at its marker's address, and then ask for
 * it again.
 */
export async function proveRun(p: Proving): Promise<{ paid: RunInput; marker: RunMarker; proof: RunProof }> {
  const { rpc, rail, owner, delegate, mint, amount, show, step } = p;
  const [first, second, third] = p.payees;
  const lines: PayoutLine[] = [
    { to: first, amount: amount('1'), memo: 'INV-1041 design retainer' },
    { to: second, amount: amount('2.5'), memo: 'INV-1042 audit milestone 2' },
    { to: third, amount: amount('0.75'), memo: 'INV-1043 translation' },
  ];
  // The run comes into being here. Nothing that pays it can be older than
  // this slot, which bounds every later reading of history for its payment.
  const notBefore = await rail.checkpoint();
  const run1 = { account: owner.address, lines, runId: RUN_ID, notBefore };
  const marker = await runMarker(delegate.address, await runMarkerSeed(owner.address, mint, RUN_ID));
  const markerRent = await rpc.getMinimumBalanceForRentExemption(BigInt(MARKER_SPACE)).send();

  const priced = await eventually(() => rail.preview(run1), preview => preview.ok);
  assert.ok(priced.ok && priced.cost, `preview turned the run down: ${priced.error}`);
  assert.equal(priced.cost.newTokenAccounts, 3);
  assert.equal(priced.cost.markerLamports, markerRent);
  step('preview() prices the run before anything is sent', null, [
    `the run is bounded below by slot ${notBefore}, taken from checkpoint() when it was created`,
    `${priced.cost.newTokenAccounts} payee token accounts to create: ${priced.cost.rentLamports} lamports of rent ` +
      `from the delegate, ${priced.cost.markerLamports} lamports for the run marker, ` +
      `and a fee of ${priced.cost.feeLamports} lamports`,
    `run marker ${marker.address} (seed ${marker.seed}): ${describeMarker(await readMarker(rpc, marker.address))}`,
  ]);

  const refusedOverAccountLimit = await rail.pay({
    account: owner.address,
    lines: [...lines, { to: p.newcomer, amount: amount('0.01'), memo: 'one new account too many' }],
    runId: 'HF-2026-10-0009',
    notBefore: p.since,
  });
  assert.equal(refusedOverAccountLimit.outcome, 'refused');
  assert.match(refusedOverAccountLimit.error ?? '', /^run would create 4 payee token accounts/);
  step('pay() refuses a run that would create four token accounts; the limit per run is three', null, [
    `error: ${refusedOverAccountLimit.error}`,
  ]);

  const prefunded = await rpc.getMinimumBalanceForRentExemption(0n).send();
  const prefundSignature = await submit(rpc, owner, [
    getTransferSolInstruction({ source: owner, destination: marker.address, amount: prefunded }),
  ]);
  const markerAfterPrefunding = await eventually(() => readMarker(rpc, marker.address), state => state.exists);
  const onlyLamports = { exists: true, lamports: prefunded, space: 0, owner: SYSTEM_PROGRAM_ADDRESS };
  assert.deepEqual(markerAfterPrefunding, onlyLamports);
  step('Another key sends lamports to the address of the run marker before the run is paid', prefundSignature, [
    `sent ${prefunded} lamports, the least an empty account may hold`,
    `run marker: ${describeMarker(markerAfterPrefunding)}`,
  ]);

  const allocationByAnotherKey = await submitToBeRefused(rpc, owner, [
    allocationWithoutBaseSignature(marker, delegate.address),
  ]);
  assert.equal(allocationByAnotherKey.error, 'instruction 0 failed: MissingRequiredSignature');
  await p.refusedStep(
    'That key cannot set the marker: allocating it takes the signature of the service key',
    allocationByAnotherKey,
  );
  const allocationUnderOwnBase = await submitToBeRefused(rpc, owner, [allocationUnderBase(marker, owner)]);
  assert.match(allocationUnderOwnBase.error, /^instruction 0 failed: custom program error 0x5 /);
  await p.refusedStep(
    'Nor can it allocate that address as the base itself: its own key derives a different address',
    allocationUnderOwnBase,
  );

  const shortfall = markerRent - prefunded;
  const pricedAfterPrefunding = await eventually(
    () => rail.preview(run1),
    preview => preview.cost?.markerLamports === shortfall,
  );
  assert.ok(pricedAfterPrefunding.ok && !pricedAfterPrefunding.alreadyPaid, 'lamports alone do not mark a run paid');
  assert.equal(pricedAfterPrefunding.cost?.markerLamports, shortfall);
  step('preview() still sees an unpaid run, and now charges the marker only what its address lacks', null, [
    `already paid: ${pricedAfterPrefunding.alreadyPaid}`,
    `${pricedAfterPrefunding.cost?.markerLamports} lamports for the run marker, down from ${markerRent}`,
  ]);

  const payout = await rail.pay(run1);
  assert.ok(payout.outcome === 'paid' && payout.tx && payout.cost, `payout failed: ${payout.error}`);
  const remainingAfterRun = await p.remaining(amount('5.75'));
  assert.equal(remainingAfterRun, amount('5.75'));
  const landed = await readLanded(rpc, payout.tx);
  assert.equal(payout.cost.markerLamports, shortfall);
  assert.equal(landed.spent, totalLamports(payout.cost), 'the cost pay() reports is what left the service key');
  const markerAfterPayout = await eventually(
    () => readMarker(rpc, marker.address),
    state => state.space === MARKER_SPACE,
  );
  assert.deepEqual(markerAfterPayout, { ...onlyLamports, lamports: markerRent, space: MARKER_SPACE });
  step(`Delegate pays run ${RUN_ID}: 1.00 + 2.50 + 0.75 to three new recipients, one transaction`, payout.tx, [
    ...landed.notes,
    `outcome ${payout.outcome}, line memos on chain: ${payout.lineMemos}`,
    `remaining() = ${show(remainingAfterRun)}`,
    `cost reported by pay(): ${payout.cost.rentLamports} rent + ${payout.cost.markerLamports} marker + ` +
      `${payout.cost.feeLamports} fee = ${totalLamports(payout.cost)} lamports; ` +
      `the delegate's balance fell by ${landed.spent} lamports in this transaction`,
    `run marker: ${describeMarker(markerAfterPayout)}`,
  ]);

  const run = await eventually(
    () => rail.findRun(owner.address, RUN_ID, { notBefore }).catch(() => null),
    found => found !== null,
  );
  assert.ok(run, 'the run is found by its memo');
  assert.equal(run.signature, payout.tx);
  assert.deepEqual(
    run.transfers.map(({ to, amount: sent, memo }) => ({ to, amount: sent, memo })),
    lines,
  );
  const ownerTokenAccount = await associatedTokenAddress(owner.address, mint);
  const history = await rpc.getSignaturesForAddress(ownerTokenAccount, { limit: 1 }).send();
  step('findRun rebuilds the run from chain data alone', null, [
    `getSignaturesForAddress memo field: \`${history[0]?.memo}\``,
    ...run.transfers.map(transfer => `${show(transfer.amount)} to ${transfer.to} "${transfer.memo}"`),
    `total ${show(run.total)}`,
  ]);

  const replay = await rail.pay(run1);
  assert.ok(replay.ok && replay.replayed, `the replay was not recognised: ${replay.error}`);
  assert.equal(replay.tx, payout.tx);
  // A rail that starts afresh has only the chain to go by. Let it see the run
  // there before it is asked to pay, as a service coming back up would.
  const restarted = createSolanaPayoutRail(p.railConfig);
  const seen = await eventually(() => restarted.preview(run1), preview => preview.paidBy !== null);
  assert.ok(seen.alreadyPaid);
  assert.equal(seen.paidBy, payout.tx);
  const replayAfterRestart = await restarted.pay(run1);
  assert.ok(replayAfterRestart.ok && replayAfterRestart.replayed);
  assert.equal(replayAfterRestart.tx, payout.tx);
  assert.equal(await p.remaining(remainingAfterRun), remainingAfterRun, 'a replay pays nothing');
  step('pay() called again with the same run returns the first transaction and sends nothing', null, [
    `same rail: outcome ${replay.outcome}, replayed ${replay.replayed}, tx ${replay.tx}`,
    `a new rail on the same key, going by the marker: replayed ${replayAfterRestart.replayed}, tx ${replayAfterRestart.tx}`,
    `remaining() = ${show(remainingAfterRun)}`,
  ]);

  const refusedDifferentLines = await rail.pay({
    ...run1,
    lines: lines.map((line, index) => (index === 0 ? { ...line, amount: amount('1.5') } : line)),
  });
  assert.equal(refusedDifferentLines.outcome, 'refused');
  assert.match(refusedDifferentLines.error ?? '', /was already paid by .* with different lines/);
  step('pay() refuses the same run id with different lines', null, [`error: ${refusedDifferentLines.error}`]);

  return {
    paid: run1,
    marker,
    proof: {
      priced,
      refusedOverAccountLimit,
      marker: {
        address: marker.address,
        seed: marker.seed,
        rent: markerRent,
        prefunded,
        afterPayout: markerAfterPayout,
      },
      allocationByAnotherKey,
      allocationUnderOwnBase,
      pricedAfterPrefunding,
      remainingAfterRun,
      payout,
      payoutSpent: landed.spent,
      run,
      replay,
      replayAfterRestart,
      refusedDifferentLines,
    },
  };
}
