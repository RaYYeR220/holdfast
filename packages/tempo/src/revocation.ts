import * as Signature from 'ox/Signature';
import { SignatureEnvelope, TxEnvelopeTempo } from 'ox/tempo';
import { type Address, type Hex, decodeFunctionData, getAddress, isAddress, isAddressEqual, keccak256 } from 'viem';
import { Abis, Addresses } from 'viem/tempo';
import { buildRevoke } from './authorization';
import type { SignedTx } from './chain';
import { FEE_HEADROOM, feeCeiling } from './preflight';
import { formatBaseUnits } from './units';

/**
 * Taking an access key back. Only the root of the account can do it, with a
 * `revokeKey` call it signs itself, and the service does not hold the root.
 * So the root signs the transaction and the service's sponsor pays for it:
 * Tempo lets a second signer, the fee payer, cover the fee of a transaction
 * if the sender signed it for that. A sender's signature covers either a
 * transaction it pays for itself or one a fee payer pays for, never both; the
 * node refuses a fee payer's signature beside a sender's that was made for
 * the other kind. The root therefore signs with the marker that a fee payer
 * follows, and commits to no fee token: the fee payer names it.
 */

/**
 * How long a prepared revocation can still be included, in seconds of chain
 * time. A person answers a passkey prompt in between, so it is longer than
 * the window of a payout, which the service signs itself.
 */
export const REVOCATION_VALIDITY_SECONDS = 120;

/**
 * Gas given to a revocation. Measured on Moderato: `revokeKey` signed by a
 * passkey and paid by a sponsor used about 286,000 as the account's first
 * transaction of its own, for which the node estimated 308,749, and about
 * 36,000 as its second: the account's nonce is new state only once.
 */
export const REVOCATION_GAS = 600_000n;

/** The tip a revocation offers: the fee is the base fee and next to nothing on top. */
export const REVOCATION_PRIORITY_FEE = 1n;

/** A revocation is numbered on the account's own sequence. The payout lane is the access key's. */
export const REVOCATION_NONCE_KEY = 0n;

/** Everything the root's signature on a revocation covers, apart from the call itself. */
export interface RevocationTerms {
  chainId: number;
  /** The key to take back: the key id the root authorized. */
  accessKey: Address;
  /** The next nonce of the account's own sequence. */
  nonce: number;
  gas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  /** Unix seconds; the transaction cannot be included in a block at or after this time. */
  validBefore: number;
}

/** What the root is asked to sign, and who pays for it. */
export interface RevocationRequest extends RevocationTerms {
  nonceKey: bigint;
  /** The account that pays the fee, with a signature of its own after the root's. */
  feePayer: Address;
  /** The token the fee is paid in. The fee payer names it; the root's signature does not cover it. */
  feeToken: Address;
}

/** The revocation of `accessKeyAddress` as it can be signed at this moment of the chain. */
export function buildRevocation(input: {
  accessKeyAddress: Address;
  chainId: number;
  nonce: number;
  baseFeePerGas: bigint;
  /** Chain time, unix seconds. */
  now: number;
  feePayer: Address;
  feeToken: Address;
}): RevocationRequest {
  if (!isAddress(input.accessKeyAddress)) throw new RangeError(`accessKeyAddress "${input.accessKeyAddress}" is not a valid address`);
  if (!Number.isInteger(input.chainId) || input.chainId <= 0) throw new RangeError('chainId must be the id of one chain');
  if (!Number.isSafeInteger(input.nonce) || input.nonce < 0) throw new RangeError('nonce must be a whole number, zero or more');
  if (!Number.isInteger(input.now) || input.now <= 0) throw new RangeError('now must be a unix timestamp in seconds');
  return {
    chainId: input.chainId,
    accessKey: getAddress(input.accessKeyAddress),
    nonce: input.nonce,
    nonceKey: REVOCATION_NONCE_KEY,
    gas: REVOCATION_GAS,
    // Twice the base fee, as the node itself suggests; never less than the tip.
    maxFeePerGas: input.baseFeePerGas > 0n ? input.baseFeePerGas * 2n : REVOCATION_PRIORITY_FEE,
    maxPriorityFeePerGas: REVOCATION_PRIORITY_FEE,
    feePayer: getAddress(input.feePayer),
    feeToken: getAddress(input.feeToken),
    validBefore: input.now + REVOCATION_VALIDITY_SECONDS,
  };
}

/**
 * The transaction of a revocation before anyone signed it: one call,
 * `revokeKey(accessKey)` on the Account Keychain, with the marker in the fee
 * payer's place that says one signs after the sender.
 */
export function revocationEnvelope(terms: RevocationTerms): TxEnvelopeTempo.TxEnvelopeTempo<false> {
  return TxEnvelopeTempo.from({
    chainId: terms.chainId,
    calls: [buildRevoke({ accessKeyAddress: terms.accessKey })],
    nonce: BigInt(terms.nonce),
    nonceKey: REVOCATION_NONCE_KEY,
    gas: terms.gas,
    maxFeePerGas: terms.maxFeePerGas,
    maxPriorityFeePerGas: terms.maxPriorityFeePerGas,
    validBefore: terms.validBefore,
    feePayerSignature: null,
  }) as TxEnvelopeTempo.TxEnvelopeTempo<false>;
}

/** The 32-byte digest the root signs for a revocation on these terms. */
export function revocationSignPayload(terms: RevocationTerms): Hex {
  return TxEnvelopeTempo.getSignPayload(revocationEnvelope(terms));
}

/** A revocation the root of an account signed, reduced to what was checked of it. */
export interface SignedRevocation {
  /** The revocation rebuilt from the terms that were checked, with the root's signature on it. */
  envelope: TxEnvelopeTempo.Signed;
  nonce: number;
  maxFeePerGas: bigint;
  validBefore: number;
}

export type RevocationCheck = { ok: true; revocation: SignedRevocation } | { ok: false; problems: string[] };

function reasonOf(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return (text.split('\n')[0] ?? text).trim();
}

/** The key a call asks the keychain to revoke; null when the call is anything else. */
function revokedKeyOf(call: TxEnvelopeTempo.Call): Address | null {
  if (call.to === undefined || !isAddressEqual(call.to, Addresses.accountKeychain) || (call.value ?? 0n) !== 0n || call.data === undefined) return null;
  try {
    const decoded = decodeFunctionData({ abi: Abis.accountKeychain, data: call.data });
    return decoded.functionName === 'revokeKey' ? getAddress(decoded.args[0]) : null;
  } catch {
    return null;
  }
}

function callProblems(calls: readonly TxEnvelopeTempo.Call[], accessKey: Address): string[] {
  const [call] = calls;
  if (calls.length !== 1 || call === undefined) return [`the transaction makes ${calls.length} calls, expected the revocation alone`];
  const expected = buildRevoke({ accessKeyAddress: accessKey });
  const revoked = revokedKeyOf(call);
  if (revoked !== null && !isAddressEqual(revoked, accessKey)) return [`the transaction revokes key ${revoked}, this rail's key is ${accessKey}`];
  // To the byte: a call with anything appended to it is not the call that was asked for.
  if (revoked === null || (call.data ?? '0x').toLowerCase() !== expected.data.toLowerCase()) return [`the transaction's call is not revokeKey(${accessKey}) on the Account Keychain`];
  return [];
}

/**
 * Decide whether a transaction the root signed may be given the sponsor's
 * signature and sent. It may only when it is, to the byte, the revocation of
 * this rail's key on this chain as `buildRevocation` describes it, signed by
 * the root key of `account` for a fee payer to pay for. All of that is
 * settled here, before anything is asked of the chain: what gets the
 * sponsor's signature is paid for by the service and acts on the account.
 *
 * The fee and the deadline are the root's to state and are read back from
 * the transaction; `revocationProblems` holds them against the chain.
 *
 * The signature is checked against the account's own address, so the root
 * has to be a secp256k1 key or a passkey; other signature types are refused,
 * an access key's among them.
 */
export function verifySignedRevocation(input: { serialized: Hex; account: Address; accessKey: Address; chainId: number }): RevocationCheck {
  const { account, accessKey, chainId } = input;
  let decoded: TxEnvelopeTempo.TxEnvelopeTempo;
  try {
    // The node takes 0x76; 0x78 is the same transaction as a sender hands it to a fee payer.
    if (!/^0x7[68]([0-9a-fA-F]{2})+$/.test(input.serialized)) throw new RangeError('it is not a Tempo transaction');
    decoded = TxEnvelopeTempo.deserialize(input.serialized as TxEnvelopeTempo.Serialized);
  } catch (error) {
    return { ok: false, problems: [`the transaction cannot be read: ${reasonOf(error)}`] };
  }
  const { signature } = decoded;
  if (signature === undefined) return { ok: false, problems: ['the transaction is not signed'] };

  const problems: string[] = [];
  if (decoded.feePayerSignature === undefined) problems.push('the transaction is signed for the account to pay the fee itself, not for the fee sponsor to pay it');
  else if (decoded.feePayerSignature !== null) problems.push("the transaction already carries a fee payer's signature");
  if (decoded.chainId !== chainId) problems.push(`the transaction is for chain ${decoded.chainId}, this rail runs on chain ${chainId}`);
  if (decoded.from !== undefined && !isAddressEqual(decoded.from, account)) problems.push(`the transaction is sent by ${getAddress(decoded.from)}, not by ${account}`);
  problems.push(...callProblems(decoded.calls, accessKey));
  if ((decoded.nonceKey ?? 0n) !== REVOCATION_NONCE_KEY) problems.push(`the transaction is numbered on nonce key ${decoded.nonceKey}, expected the account's own sequence`);
  if (decoded.gas !== REVOCATION_GAS) problems.push(`the transaction carries a gas limit of ${decoded.gas ?? 0n}, expected ${REVOCATION_GAS}`);
  if ((decoded.maxPriorityFeePerGas ?? 0n) !== REVOCATION_PRIORITY_FEE) problems.push(`the transaction offers a tip of ${decoded.maxPriorityFeePerGas ?? 0n} per gas, expected ${REVOCATION_PRIORITY_FEE}`);
  const { maxFeePerGas, validBefore } = decoded;
  const nonce = decoded.nonce ?? 0n;
  if (maxFeePerGas === undefined || maxFeePerGas < REVOCATION_PRIORITY_FEE) problems.push('the transaction names no fee it would pay');
  if (validBefore === undefined) problems.push('the transaction never expires');
  if (nonce > BigInt(Number.MAX_SAFE_INTEGER)) problems.push('the nonce of the transaction is not one an account can have');
  if (problems.length > 0 || maxFeePerGas === undefined || validBefore === undefined) return { ok: false, problems };

  let expected: TxEnvelopeTempo.TxEnvelopeTempo<false>;
  let payload: Hex;
  let same: boolean;
  try {
    expected = revocationEnvelope({ chainId, accessKey, nonce: Number(nonce), gas: REVOCATION_GAS, maxFeePerGas, maxPriorityFeePerGas: REVOCATION_PRIORITY_FEE, validBefore });
    payload = TxEnvelopeTempo.getSignPayload(expected);
    // The digest covers every field the root signed, including ones the comparison above has no words for.
    same = TxEnvelopeTempo.getSignPayload(decoded) === payload;
  } catch (error) {
    return { ok: false, problems: [`the transaction cannot be read: ${reasonOf(error)}`] };
  }
  if (!same) return { ok: false, problems: ['the transaction carries more than the revocation'] };

  let signedByRoot: boolean;
  try {
    signedByRoot = SignatureEnvelope.verify(signature, { address: account, payload });
  } catch {
    return { ok: false, problems: [`the transaction carries a ${signature.type} signature, which cannot be checked against the account; the root has to be a secp256k1 key or a passkey`] };
  }
  if (!signedByRoot) return { ok: false, problems: [`the transaction is not signed by the root key of ${account}`] };
  // What goes on is the rebuilt transaction: nothing the root did not sign travels with its signature.
  return { ok: true, revocation: { envelope: TxEnvelopeTempo.from(expected, { signature }) as TxEnvelopeTempo.Signed, nonce: Number(nonce), maxFeePerGas, validBefore } };
}

/** What the chain says at the moment a revocation is about to be prepared or sent. */
export interface RevocationFacts {
  /** Chain time, unix seconds. */
  now: number;
  baseFeePerGas: bigint;
  /** The next nonce of the account's own sequence. */
  nonce: number;
  sponsor: Address;
  /** The sponsor's balance of the fee token. */
  sponsorBalance: bigint;
}

function iso(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

/** Why the sponsor cannot pay for a revocation now; null when it can. */
export function sponsorProblem(facts: Pick<RevocationFacts, 'baseFeePerGas' | 'sponsor' | 'sponsorBalance'>): string | null {
  const fee = feeCeiling(REVOCATION_GAS, facts.baseFeePerGas);
  if (fee <= facts.sponsorBalance) return null;
  return `fee sponsor ${facts.sponsor} holds ${formatBaseUnits(facts.sponsorBalance)} of the fee token, the fee may reach ${formatBaseUnits(fee)}`;
}

/**
 * Why a signed revocation cannot be sent as the chain stands; empty when it
 * can. The root stated the fee and the deadline, and the sponsor pays, so
 * both are held to what this rail prepares: a fee within what the base fee
 * calls for, and a deadline no further off than a revocation is prepared for,
 * which also bounds how long its outcome can stay open.
 */
export function revocationProblems(revocation: Pick<SignedRevocation, 'nonce' | 'maxFeePerGas' | 'validBefore'>, facts: RevocationFacts): string[] {
  const problems: string[] = [];
  const again = 'prepare the revocation again';
  if (revocation.validBefore <= facts.now) problems.push(`the transaction expired at ${iso(revocation.validBefore)}; ${again}`);
  else if (revocation.validBefore > facts.now + REVOCATION_VALIDITY_SECONDS) {
    problems.push(`the transaction stays valid until ${iso(revocation.validBefore)}, longer than the ${REVOCATION_VALIDITY_SECONDS} s a revocation is prepared for`);
  }
  const most = facts.baseFeePerGas > 0n ? facts.baseFeePerGas * FEE_HEADROOM : REVOCATION_PRIORITY_FEE;
  if (revocation.maxFeePerGas < facts.baseFeePerGas) problems.push(`the transaction offers ${revocation.maxFeePerGas} per gas and the base fee is ${facts.baseFeePerGas} now; ${again}`);
  else if (revocation.maxFeePerGas > most) problems.push(`the transaction offers ${revocation.maxFeePerGas} per gas, more than the ${most} this rail pays at a base fee of ${facts.baseFeePerGas}`);
  if (revocation.nonce < facts.nonce) problems.push(`nonce ${revocation.nonce} of the transaction is used already, the next of the account is ${facts.nonce}; ${again}`);
  else if (revocation.nonce > facts.nonce) problems.push(`nonce ${revocation.nonce} of the transaction is ahead of the account's next, ${facts.nonce}; ${again}`);
  const sponsor = sponsorProblem(facts);
  if (sponsor !== null) problems.push(sponsor);
  return problems;
}

/**
 * Add the fee payer's signature to a revocation the root signed, and return
 * the bytes the node takes. The fee payer signs the whole transaction
 * together with the sender's address and the fee token, so its signature
 * pays for this sender's revocation in this token and for nothing else.
 */
export async function sponsorRevocation(input: {
  envelope: TxEnvelopeTempo.Signed;
  root: Address;
  feeToken: Address;
  sponsor: { sign(i: { hash: Hex }): Promise<Hex> };
}): Promise<SignedTx> {
  const transaction = { ...input.envelope, feeToken: input.feeToken, feePayerSignature: null };
  const payload = TxEnvelopeTempo.getFeePayerSignPayload(transaction, { sender: input.root });
  const feePayerSignature = Signature.from(await input.sponsor.sign({ hash: payload }));
  const serialized = TxEnvelopeTempo.serialize(transaction, { feePayerSignature });
  return { serialized, hash: keccak256(serialized) };
}
