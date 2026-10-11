import {
  AccountRole,
  createNoopSigner,
  generateKeyPairSigner,
  type Address,
  type Instruction,
  type KeyPairSigner,
} from '@solana/kit';
import {
  getAllocateWithSeedInstruction,
  getAssignWithSeedInstruction,
  getTransferSolInstruction,
  getTransferSolWithSeedInstruction,
  SYSTEM_PROGRAM_ADDRESS,
} from '@solana-program/system';
import { TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import { beforeEach, describe, expect, it } from 'vitest';
import { markerInstructions, runMarker, type RunMarker } from '../src/marker';
import { executeSystemInstructions, rentFor, type LedgerAccount } from './ledger';
import { decodeWire, signedWire } from './world';

/**
 * The fake chain is only worth testing against if it refuses what the real
 * one refuses. Each rule below was observed on devnet first, as the result
 * of a simulated or a landed transaction, and is pinned here as observed.
 */

const RENT = rentFor(1);
const wallet = (lamports = 1_000_000_000n): LedgerAccount => ({ lamports, owner: SYSTEM_PROGRAM_ADDRESS, space: 0 });

let service: KeyPairSigner;
let stranger: KeyPairSigner;
let marker: RunMarker;
let state: Map<Address, LedgerAccount>;
beforeEach(async () => {
  service = await generateKeyPairSigner();
  stranger = await generateKeyPairSigner();
  marker = await runMarker(service.address, 's'.repeat(32));
  state = new Map([
    [service.address, wallet()],
    [stranger.address, wallet()],
  ]);
});

/** Run a transaction against the state and keep what it did if it succeeded, as a chain does. */
async function run(feePayer: KeyPairSigner, instructions: readonly Instruction[]) {
  const { instructions: resolved, accounts } = decodeWire((await signedWire(feePayer, instructions)).wire);
  const execution = await executeSystemInstructions(resolved, accounts, address => state.get(address));
  if (execution.err === null) for (const [address, account] of execution.accounts) state.set(address, account);
  return execution.err;
}
const setMarker = () => run(service, markerInstructions(service, marker, RENT));

/** The allocation of the marker as someone without the service key has to send it: the base named, not signing. */
function allocationBy(base: KeyPairSigner | Address): Instruction {
  const signer = typeof base === 'string' ? createNoopSigner(base) : base;
  const instruction = getAllocateWithSeedInstruction({
    newAccount: marker.address,
    baseAccount: signer,
    base: signer.address,
    seed: marker.seed,
    space: 1,
    programAddress: SYSTEM_PROGRAM_ADDRESS,
  });
  if (typeof base !== 'string') return instruction;
  const accounts = instruction.accounts.map(account =>
    account.address === base ? { address: base, role: AccountRole.READONLY } : account,
  );
  return { programAddress: instruction.programAddress, data: instruction.data, accounts };
}

describe('setting a marker', () => {
  it('gives a System-owned account one byte and its rent', async () => {
    expect(await setMarker()).toBeNull();
    expect(state.get(marker.address)).toEqual({ lamports: RENT, owner: SYSTEM_PROGRAM_ADDRESS, space: 1 });
  });

  it('takes the signature of the service key, the base of the address', async () => {
    expect(await run(stranger, [allocationBy(service.address)])).toEqual({
      InstructionError: [0, 'MissingRequiredSignature'],
    });
  });

  it('cannot be done under another base: that derives another address', async () => {
    expect(await run(stranger, [allocationBy(stranger)])).toEqual({ InstructionError: [0, { Custom: 5 }] });
  });

  it('works at an address somebody has already sent lamports to', async () => {
    const send = getTransferSolInstruction({ source: stranger, destination: marker.address, amount: rentFor(0) });
    expect(await run(stranger, [send])).toBeNull();
    expect(state.get(marker.address)).toEqual({ lamports: rentFor(0), owner: SYSTEM_PROGRAM_ADDRESS, space: 0 });

    expect(await run(service, markerInstructions(service, marker, RENT - rentFor(0)))).toBeNull();
    expect(state.get(marker.address)).toEqual({ lamports: RENT, owner: SYSTEM_PROGRAM_ADDRESS, space: 1 });
  });

  it('fails as a whole when the marker would be left short of its rent', async () => {
    const before = new Map(state);
    expect(await run(service, markerInstructions(service, marker, RENT - 1n))).toEqual({
      InsufficientFundsForRent: { account_index: 1 },
    });
    expect(state).toEqual(before);
  });

  it('leaves nothing behind when no lamports are sent with it', async () => {
    expect(await run(service, [allocationBy(service)])).toBeNull();
    expect(state.get(marker.address)).toEqual({ lamports: 0n, owner: SYSTEM_PROGRAM_ADDRESS, space: 0 });
  });
});

describe('a marker that is set', () => {
  beforeEach(async () => {
    await setMarker();
  });

  it('cannot be set again: AccountAlreadyInUse, at the allocation', async () => {
    expect(await run(service, markerInstructions(service, marker, 1n))).toEqual({ InstructionError: [1, { Custom: 0 }] });
    expect(state.get(marker.address)?.lamports).toBe(RENT);
  });

  it('still takes lamports from anybody, which changes nothing about it', async () => {
    const send = getTransferSolInstruction({ source: stranger, destination: marker.address, amount: 5n });
    expect(await run(stranger, [send])).toBeNull();
    expect(state.get(marker.address)).toEqual({ lamports: RENT + 5n, owner: SYSTEM_PROGRAM_ADDRESS, space: 1 });
  });

  it('gives no lamports back, not to the service key either', async () => {
    const withdraw = getTransferSolWithSeedInstruction({
      source: marker.address,
      baseAccount: service,
      destination: service.address,
      amount: 1n,
      fromSeed: marker.seed,
      fromOwner: SYSTEM_PROGRAM_ADDRESS,
    });
    expect(await run(service, [withdraw])).toEqual({ InstructionError: [0, 'InvalidArgument'] });
  });

  it('cannot be handed to another program', async () => {
    const assign = getAssignWithSeedInstruction({
      account: marker.address,
      baseAccount: service,
      base: service.address,
      seed: marker.seed,
      programAddress: TOKEN_PROGRAM_ADDRESS,
    });
    expect(await run(service, [assign])).toEqual({ InstructionError: [0, { Custom: 5 }] });
  });
});
