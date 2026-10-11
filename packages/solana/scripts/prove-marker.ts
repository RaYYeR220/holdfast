import assert from 'node:assert/strict';
import type { PayoutLine } from '@holdfast/core';
import {
  createSolanaPayoutRail,
  runMarker,
  runMarkerSeed,
  type RepeatRunProbe,
  type RunInput,
  type RunMarker,
  type SolanaPayoutResult,
} from '../src/index';
import { MARKER_SPACE, markerInstructions } from '../src/marker';
import { submit, submitToBeRefused, type RefusedOnChain } from './chain';
import {
  allocationUnderBase,
  describeMarker,
  nonceInitialization,
  preflightRepeat,
  racePayouts,
  readMarker,
  reassignment,
  withdrawal,
  type MarkerState,
  type RacedPayout,
  type StoppedAtPreflight,
} from './marker-checks';
import { eventually, readLanded, type Proving } from './proving';

const RACED_RUN_ID = 'HF-2026-10-0004';
/** A run that is never paid: its marker address is used to show what an allocation without rent comes to. */
const UNPAID_RUN_ID = 'HF-2026-10-0008';

export interface MarkerProof {
  repeatProbe: RepeatRunProbe;
  repeatAtPreflight: StoppedAtPreflight;
  nonceByAnotherKey: RefusedOnChain;
  withdrawal: RefusedOnChain;
  reassignment: RefusedOnChain;
  /** An allocation the service key sent no lamports with: its transaction, and what its address held afterwards. */
  unfundedAllocation: { signature: string; left: MarkerState };
  underfundedAllocation: RefusedOnChain;
  race: RacedPayout[];
  replayAfterRace: SolanaPayoutResult;
  remainingAfterRace: bigint;
}

/**
 * What the chain does with the marker of a paid run, and with two payouts
 * of one run that reach it together. `allowance` is what the delegate may
 * still move when this starts.
 */
export async function proveMarker(
  p: Proving,
  paid: RunInput,
  marker: RunMarker,
  allowance: bigint,
): Promise<MarkerProof> {
  const { rpc, rail, owner, delegate, amount, show, step, refusedStep } = p;
  const [first, second] = p.payees;

  const restarted = createSolanaPayoutRail(p.railConfig);
  const repeatProbe = await eventually(() => restarted.probeRepeatRun(paid), probed => probed.signature !== null);
  assert.ok(repeatProbe.failedOnChain && repeatProbe.signature, `the repeat was not refused on chain: ${repeatProbe.error}`);
  assert.equal(await p.remaining(allowance), allowance, 'a refused repeat moves nothing');
  step(
    `probeRepeatRun sends run ${paid.runId} a second time with preflight skipped; the System program refuses its marker`,
    repeatProbe.signature,
    [
      `reported: ${repeatProbe.error}`,
      ...(await readLanded(rpc, repeatProbe.signature)).notes,
      `remaining() = ${show(allowance)}`,
    ],
  );

  const repeatAtPreflight = await preflightRepeat(p.railConfig, paid);
  assert.deepEqual(repeatAtPreflight.custom, { index: 2, code: 0 });
  step('The same repeat offered with preflight on is stopped by the node, with the error pay() reads as already paid', null, [
    `reported: ${repeatAtPreflight.error}`,
  ]);

  const nonceByAnotherKey = await submitToBeRefused(rpc, owner, [nonceInitialization(marker, owner.address)]);
  assert.equal(nonceByAnotherKey.error, 'instruction 0 failed: InvalidAccountData');
  await refusedStep(
    'Another key cannot make the marker a nonce account, which it could then withdraw from',
    nonceByAnotherKey,
  );
  const withdrawn = await submitToBeRefused(rpc, delegate, [withdrawal(marker, delegate)]);
  assert.equal(withdrawn.error, 'instruction 0 failed: InvalidArgument');
  await refusedStep('The service key cannot take lamports back out of the marker it set', withdrawn);
  const reassigned = await submitToBeRefused(rpc, delegate, [reassignment(marker, delegate)]);
  assert.match(reassigned.error, /^instruction 0 failed: custom program error 0x5 /);
  await refusedStep('The service key cannot hand the marker to another program either', reassigned);

  // Why a payout always sends its marker at least one lamport, and what stops one that sends too little.
  const unpaid = await runMarker(delegate.address, await runMarkerSeed(owner.address, p.mint, UNPAID_RUN_ID));
  const markerRent = await rpc.getMinimumBalanceForRentExemption(BigInt(MARKER_SPACE)).send();
  const unfunded = await submit(rpc, delegate, [allocationUnderBase(unpaid, delegate)]);
  const unfundedNotes = (await readLanded(rpc, unfunded)).notes;
  const left = await readMarker(rpc, unpaid.address);
  assert.equal(left.exists, false, 'an account without lamports does not outlast its transaction');
  step('An allocation with no lamports behind it goes through and leaves no account, so it marks nothing', unfunded, [
    ...unfundedNotes,
    `address ${unpaid.address} afterwards: ${describeMarker(left)}`,
  ]);
  const underfunded = await submitToBeRefused(rpc, delegate, markerInstructions(delegate, unpaid, markerRent - 1n));
  assert.match(underfunded.error, /InsufficientFundsForRent/);
  await refusedStep(
    `With one lamport less than the rent of ${markerRent} behind it, the transaction fails as a whole`,
    underfunded,
  );

  const lines: PayoutLine[] = [
    { to: first, amount: amount('0.25'), memo: 'INV-1044 hosting' },
    { to: second, amount: amount('0.5'), memo: 'INV-1045 review' },
  ];
  const raced = { account: owner.address, lines, runId: RACED_RUN_ID, notBefore: await rail.checkpoint() };
  const race = await racePayouts(p.railConfig, raced);
  const [winner, ...otherWinners] = race.filter(payout => payout.error === null);
  const [loser] = race.filter(payout => payout.error !== null);
  assert.ok(winner && loser && otherWinners.length === 0, 'exactly one of the two payouts went through');
  assert.match(loser.error ?? '', /^instruction 2 failed: custom program error 0x0 /);
  const remainingAfterRace = await p.remaining(allowance - amount('0.75'));
  assert.equal(remainingAfterRace, allowance - amount('0.75'), 'the run was paid once: 0.75, not 1.50');
  step(`Two payouts of run ${RACED_RUN_ID} (0.25 + 0.50) are sent at the same moment; this one lands`, winner.signature, [
    ...(await readLanded(rpc, winner.signature)).notes,
    `remaining() = ${show(remainingAfterRace)}`,
  ]);
  step('The other one fails as a whole at its marker and moves nothing', loser.signature, [
    `reported: ${loser.error}`,
    ...(await readLanded(rpc, loser.signature)).notes,
  ]);
  const replayAfterRace = await eventually(() => rail.pay(raced), result => result.tx !== null);
  assert.ok(replayAfterRace.ok && replayAfterRace.replayed, `the raced run was not recognised: ${replayAfterRace.error}`);
  assert.equal(replayAfterRace.tx, winner.signature);
  step('pay() asked for that run afterwards answers with the payout that landed and sends nothing', null, [
    `outcome ${replayAfterRace.outcome}, replayed ${replayAfterRace.replayed}, tx ${replayAfterRace.tx}`,
  ]);

  return {
    repeatProbe,
    repeatAtPreflight,
    nonceByAnotherKey,
    withdrawal: withdrawn,
    reassignment: reassigned,
    unfundedAllocation: { signature: unfunded, left },
    underfundedAllocation: underfunded,
    race,
    replayAfterRace,
    remainingAfterRace,
  };
}
