import {
  AccountRole,
  createNoopSigner,
  fetchEncodedAccount,
  type Address,
  type Instruction,
  type KeyPairSigner,
} from '@solana/kit';
import {
  getAllocateWithSeedInstruction,
  getAssignWithSeedInstruction,
  getInitializeNonceAccountInstruction,
  getTransferSolWithSeedInstruction,
  SYSTEM_PROGRAM_ADDRESS,
} from '@solana-program/system';
import { TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import { sendAndConfirm } from '../src/confirm';
import type { SolanaRpc } from '../src/connection';
import { createRailContext, type SolanaPayoutRailConfig } from '../src/context';
import { describeFailure, describeTransactionError, simulatedCustomError, type CustomError } from '../src/errors';
import { MARKER_SPACE, type RunMarker } from '../src/marker';
import { payoutInstructions } from '../src/payout';
import { identifyRun, prepareRun, type RunInput } from '../src/prepare';

/** What a marker's address holds, as the node reports it. */
export interface MarkerState {
  exists: boolean;
  lamports: bigint;
  space: number;
  owner: string | null;
}

export async function readMarker(rpc: SolanaRpc, address: Address): Promise<MarkerState> {
  const account = await fetchEncodedAccount(rpc, address, { commitment: 'confirmed' });
  if (!account.exists) return { exists: false, lamports: 0n, space: 0, owner: null };
  return { exists: true, lamports: account.lamports, space: account.data.length, owner: account.programAddress };
}

export const describeMarker = (state: MarkerState): string =>
  state.exists
    ? `${state.lamports} lamports, ${state.space} bytes of data, owner ${state.owner}`
    : 'no account at this address';

/**
 * The allocation a payout makes, as someone other than the service key has
 * to send it: with the service key named as the base but not signing.
 */
export function allocationWithoutBaseSignature(marker: RunMarker, delegate: Address): Instruction {
  const instruction = getAllocateWithSeedInstruction({
    newAccount: marker.address,
    baseAccount: createNoopSigner(delegate),
    base: delegate,
    seed: marker.seed,
    space: MARKER_SPACE,
    programAddress: SYSTEM_PROGRAM_ADDRESS,
  });
  return {
    programAddress: instruction.programAddress,
    data: instruction.data,
    accounts: instruction.accounts.map(account =>
      account.address === delegate ? { address: delegate, role: AccountRole.READONLY } : account,
    ),
  };
}

/** The same allocation with the sender as the base, which it can sign for but which is not the marker's base. */
export function allocationUnderBase(marker: RunMarker, base: KeyPairSigner): Instruction {
  return getAllocateWithSeedInstruction({
    newAccount: marker.address,
    baseAccount: base,
    base: base.address,
    seed: marker.seed,
    space: MARKER_SPACE,
    programAddress: SYSTEM_PROGRAM_ADDRESS,
  });
}

/** Turning the marker into a nonce account would let whoever did it withdraw from it. */
export function nonceInitialization(marker: RunMarker, authority: Address): Instruction {
  return getInitializeNonceAccountInstruction({ nonceAccount: marker.address, nonceAuthority: authority });
}

/** The service key taking a lamport back out of a marker it set. */
export function withdrawal(marker: RunMarker, delegate: KeyPairSigner): Instruction {
  return getTransferSolWithSeedInstruction({
    source: marker.address,
    baseAccount: delegate,
    destination: delegate.address,
    amount: 1n,
    fromSeed: marker.seed,
    fromOwner: SYSTEM_PROGRAM_ADDRESS,
  });
}

/** The service key handing a marker to another program, which could then change it. */
export function reassignment(marker: RunMarker, delegate: KeyPairSigner): Instruction {
  return getAssignWithSeedInstruction({
    account: marker.address,
    baseAccount: delegate,
    base: delegate.address,
    seed: marker.seed,
    programAddress: TOKEN_PROGRAM_ADDRESS,
  });
}

export interface StoppedAtPreflight {
  /** What the node answered, in the words of `describeFailure`. */
  error: string;
  /** The custom program error in that answer, as the rail reads it. */
  custom: CustomError | null;
}

/**
 * Offer a second payout of a paid run to the node with preflight on, and
 * return the refusal of its simulation. Throws if the node takes it.
 */
export async function preflightRepeat(config: SolanaPayoutRailConfig, run: RunInput): Promise<StoppedAtPreflight> {
  const context = createRailContext(config);
  const request = await identifyRun(context, run);
  if (typeof request === 'string') throw new Error(request);
  const prepared = await prepareRun(context, request, (await context.rent()).marker);
  if ('error' in prepared) throw new Error(prepared.error);
  const instructions = payoutInstructions(prepared.plan);
  const broadcast = await context.sign(instructions);
  try {
    await context.rpc
      .sendTransaction(broadcast.wire, { encoding: 'base64', skipPreflight: false, preflightCommitment: 'confirmed' })
      .send();
  } catch (error) {
    return { error: describeFailure(error, instructions), custom: simulatedCustomError(error) };
  }
  throw new Error(`the node took a second payout of run ${run.runId} as ${broadcast.signature}`);
}

export interface RacedPayout {
  signature: string;
  /** Null for the payout that went through. */
  error: string | null;
}

/**
 * Send two payouts of one run at the same moment, both past preflight, and
 * report how each ended. They differ by a lamport sent to the marker, which
 * makes them two transactions rather than one transaction sent twice.
 */
export async function racePayouts(config: SolanaPayoutRailConfig, run: RunInput): Promise<RacedPayout[]> {
  const context = createRailContext(config);
  const request = await identifyRun(context, run);
  if (typeof request === 'string') throw new Error(request);
  const prepared = await prepareRun(context, request, 0n);
  if ('error' in prepared) throw new Error(prepared.error);

  const plans = [prepared.plan, { ...prepared.plan, markerLamports: prepared.plan.markerLamports + 1n }];
  const broadcasts = await Promise.all(plans.map(plan => context.sign(payoutInstructions(plan))));
  const outcomes = await Promise.all(
    broadcasts.map(broadcast => sendAndConfirm(context.rpc, broadcast, { ...context.following, skipPreflight: true })),
  );
  return outcomes.map((outcome, index) => {
    if (outcome.status !== 'landed') throw new Error(`payout ${outcome.signature} did not land: ${outcome.status}`);
    const plan = plans[index] ?? prepared.plan;
    const error = outcome.err === null ? null : describeTransactionError(outcome.err, payoutInstructions(plan));
    return { signature: outcome.signature, error };
  });
}
