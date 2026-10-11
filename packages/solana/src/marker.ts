import {
  createAddressWithSeed,
  getAddressEncoder,
  getBase58Decoder,
  type Address,
  type Instruction,
  type MaybeEncodedAccount,
  type TransactionSigner,
} from '@solana/kit';
import {
  getAllocateWithSeedInstruction,
  getTransferSolInstruction,
  SYSTEM_PROGRAM_ADDRESS,
} from '@solana-program/system';

/**
 * A run marker is what makes "a run is paid at most once" a rule of the
 * chain rather than a conclusion drawn from reading it.
 *
 * It is a System-owned account holding one byte, at an address derived from
 * the service key and the run. The payout transaction gives the account its
 * byte with `AllocateWithSeed`, in the same transaction as the transfers.
 * The System program allocates only an account that has no data yet, so a
 * second payout of the same run fails as a whole and moves nothing, whether
 * it comes from a retry, from another process, or while the first is still
 * on its way.
 *
 * Four rules of the System program carry this:
 *
 * - Only the service key can put data there. Allocating at a seed-derived
 *   address takes the signature of its base, which is the service key.
 *   Anyone may send lamports to the address; that changes nothing, and the
 *   payout then only adds what is still missing for rent exemption.
 * - Allocating twice fails with `AccountAlreadyInUse`, custom error 0.
 * - Lamports cannot leave an account that carries data, so the marker can
 *   not be emptied afterwards, not by the service key either.
 * - The address was derived for the System program as owner, so it cannot
 *   be assigned to any other program, which would be the only other way to
 *   change it.
 *
 * The account must stay smaller than a nonce account (80 bytes): the System
 * program lets anyone turn a zeroed account of that size into a nonce
 * account and then withdraw from it. One byte cannot be read as one.
 */
export const MARKER_SPACE = 1;

/** Length of the seed a marker address is derived with; 32 is the most the System program takes. */
export const MARKER_SEED_LENGTH = 32;

/** Where `AllocateWithSeed` sits in a payout transaction; a failure there means the run is already paid. */
export const MARKER_INSTRUCTION_INDEX = 2;

/** `SystemError::AccountAlreadyInUse`: what allocating a marker a second time fails with. */
export const MARKER_TAKEN_ERROR_CODE = 0;

const SEED_DOMAIN = 'holdfast run marker 1';

export interface RunMarker {
  address: Address;
  seed: string;
}

/**
 * The seed that stands for a run of a team wallet in a mint: the leading 32
 * base58 characters, about 187 bits, of a SHA-256 over the three. The wallet
 * and the mint are of fixed length and come first, so no two runs can spell
 * the same input.
 */
export async function runMarkerSeed(owner: Address, mint: Address, runId: string): Promise<string> {
  const addresses = getAddressEncoder();
  const input = new Uint8Array([
    ...new TextEncoder().encode(SEED_DOMAIN),
    ...addresses.encode(owner),
    ...addresses.encode(mint),
    ...new TextEncoder().encode(runId),
  ]);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', input));
  // A digest with leading zero bytes encodes shorter; padding keeps the seed length fixed.
  return getBase58Decoder().decode(digest).padEnd(MARKER_SEED_LENGTH, '1').slice(0, MARKER_SEED_LENGTH);
}

/** The marker of a run under a given service key. A rotated key has markers of its own. */
export async function runMarker(delegate: Address, seed: string): Promise<RunMarker> {
  const address = await createAddressWithSeed({ baseAddress: delegate, programAddress: SYSTEM_PROGRAM_ADDRESS, seed });
  return { address, seed };
}

/**
 * Whether an account is a run marker that has been set. Lamports alone do
 * not make one: anybody can send those. Data in a System-owned account at a
 * seed-derived address can only come from the base of that address.
 */
export function isMarkerSet(account: MaybeEncodedAccount | undefined): boolean {
  return (
    account !== undefined &&
    account.exists &&
    account.programAddress === SYSTEM_PROGRAM_ADDRESS &&
    account.data.length > 0
  );
}

/**
 * What a payout still has to send to its marker so that the marker is rent
 * exempt once it carries its byte. Never nothing: an account left with no
 * lamports at all is dropped at the end of the transaction, and a payout
 * that sent nothing to a marker that turned out to be empty would then go
 * through without leaving one. With at least one lamport on its way, that
 * transaction fails for lack of rent instead.
 */
export function markerShortfall(lamportsThere: bigint, rentExemptMinimum: bigint): bigint {
  return lamportsThere >= rentExemptMinimum ? 1n : rentExemptMinimum - lamportsThere;
}

/** The two instructions that set a marker: fund it, then give it its byte. */
export function markerInstructions(delegate: TransactionSigner, marker: RunMarker, lamports: bigint): Instruction[] {
  return [
    getTransferSolInstruction({ source: delegate, destination: marker.address, amount: lamports }),
    getAllocateWithSeedInstruction({
      newAccount: marker.address,
      baseAccount: delegate,
      base: delegate.address,
      seed: marker.seed,
      space: MARKER_SPACE,
      programAddress: SYSTEM_PROGRAM_ADDRESS,
    }),
  ];
}
