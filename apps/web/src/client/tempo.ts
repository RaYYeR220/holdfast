import * as Bytes from 'ox/Bytes';
import * as Hash from 'ox/Hash';
import * as P256 from 'ox/P256';
import * as PublicKey from 'ox/PublicKey';
import { KeyAuthorization, SignatureEnvelope } from 'ox/tempo';
import { type Address, type Hex, encodeFunctionData, getAddress, isAddress, toHex } from 'viem';
import { Abis, Account, Addresses, WebAuthnP256 } from 'viem/tempo';
import { type Api, type Organisation, type TempoAuthorization, type TempoAuthorizationRequest, type TempoRevocation, type TempoRevokeRequest, type TempoTermsInput, api as defaultApi } from './api';
import { ClientError, walletError } from './errors';

/**
 * The organisation's Tempo payroll account. It is a passkey account: its
 * root key is a WebAuthn credential that lives in the treasurer's
 * authenticator and never leaves it, and its address is derived from that
 * credential's public key. The root authorizes the service's access key for
 * one token, a spending limit and an expiry, and can take the key back.
 */

/** What is kept of a passkey: enough to ask for it again and to know the account, and nothing that can sign. */
export interface StoredPasskey {
  /** The WebAuthn credential id, as the browser gave it. */
  credentialId: string;
  /** The credential's P-256 public key, x then y. It cannot be read back from the authenticator later. */
  publicKey: Hex;
  /** The account the key is the root of. */
  address: Address;
}

/** The root of a Tempo account as viem has it; a passkey account is one. */
export type TempoRoot = Account.RootAccount;

const PASSKEY_PREFIX = 'holdfast.tempo.passkey.';
const PENDING_PREFIX = 'holdfast.tempo.pending.';
const PROBE_KEY = 'holdfast.tempo.probe';
/** The one function a payout key may call, on the one token it may spend. */
const TRANSFER_WITH_MEMO = 'transferWithMemo(address,uint256,bytes32)';
/** WebAuthn takes a user id of up to 64 bytes. */
const USER_ID_BYTES = 32;

export function passkeysSupported(): boolean {
  return typeof window !== 'undefined' && typeof window.PublicKeyCredential === 'function' && typeof window.navigator?.credentials?.create === 'function';
}

function relyingParty(): string {
  if (typeof window === 'undefined') throw new ClientError('wallet_unavailable', 'a passkey can only be used in a browser');
  return window.location.hostname;
}

function storage(): Storage {
  try {
    if (typeof window !== 'undefined' && window.localStorage !== undefined) return window.localStorage;
  } catch {
    // Reading the property throws where the browser denies storage to the page.
  }
  throw new ClientError('wallet_unavailable', 'this browser does not let the page keep the public key of the passkey');
}

/**
 * The storage, once it is known to take a write. A passkey's public key is
 * given out once; storage that would refuse it is found out before the
 * passkey is made, not after.
 */
function writable(): Storage {
  const store = storage();
  try {
    store.setItem(PROBE_KEY, '1');
    store.removeItem(PROBE_KEY);
  } catch (error) {
    throw new ClientError('wallet_unavailable', 'this browser does not let the page keep the public key of the passkey', { cause: error });
  }
  return store;
}

/** Write a passkey down. Should the write fail after all, the passkey travels in the error: it exists, and this is all that is known of it. */
function keep(store: Storage, passkey: StoredPasskey): StoredPasskey {
  try {
    store.setItem(`${PASSKEY_PREFIX}${passkey.address.toLowerCase()}`, JSON.stringify(passkey));
  } catch (error) {
    throw new ClientError('wallet_failed', 'the passkey exists, but its public key could not be kept in this browser', { details: { passkey }, cause: error });
  }
  return passkey;
}

function readStored(text: string | null): StoredPasskey | null {
  if (text === null) return null;
  try {
    const { credentialId, publicKey, address } = JSON.parse(text) as Partial<StoredPasskey>;
    if (typeof credentialId !== 'string' || credentialId === '' || typeof publicKey !== 'string' || !/^0x[0-9a-fA-F]{128}$/.test(publicKey) || typeof address !== 'string') return null;
    // What is stored is only believed as far as the address follows from the key.
    const derived = Account.fromWebAuthnP256({ id: credentialId, publicKey: publicKey as Hex }).address;
    return derived.toLowerCase() === address.toLowerCase() ? { credentialId, publicKey: publicKey as Hex, address: derived } : null;
  } catch {
    return null;
  }
}

/** The passkey of a Tempo account, if this browser created it and still knows its public key. */
export function storedPasskey(address: string): StoredPasskey | null {
  return readStored(storage().getItem(`${PASSKEY_PREFIX}${address.toLowerCase()}`));
}

export function forgetPasskey(address: string): void {
  storage().removeItem(`${PASSKEY_PREFIX}${address.toLowerCase()}`);
}

/** A passkey that was created for an organisation whose profile does not name its account yet. */
export function pendingPasskey(orgId: string): StoredPasskey | null {
  const address = storage().getItem(`${PENDING_PREFIX}${orgId}`);
  return address === null ? null : storedPasskey(address);
}

export interface CreatePasskeyOptions {
  /** The name the authenticator shows for the passkey, such as "Acme Labs payroll". */
  label: string;
  /** Used in place of `navigator.credentials.create`. */
  createFn?: WebAuthnP256.createCredential.Parameters['createFn'];
}

/**
 * Create the passkey of a new Tempo account and derive the account's
 * address. The credential id and public key are written to `localStorage`
 * before this returns: the public key is given out once, at creation, and
 * without it the account can neither be recognised nor sign.
 */
export async function createPasskey(options: CreatePasskeyOptions): Promise<StoredPasskey> {
  const store = writable();
  let credential: WebAuthnP256.P256Credential;
  try {
    credential = await WebAuthnP256.createCredential({
      label: options.label,
      // A passkey is bound to its relying party, which is this site's host name. It signs on pages of this
      // host and of no other, so an account made here cannot be used from another domain the app is served on.
      rpId: relyingParty(),
      // An authenticator keeps one passkey for each user id of a site and replaces it when the id comes again.
      // The id is therefore random: a second account with the same label must not overwrite the root of the first.
      userId: crypto.getRandomValues(new Uint8Array(USER_ID_BYTES)),
      ...(options.createFn === undefined ? {} : { createFn: options.createFn }),
    });
  } catch (error) {
    throw walletError(error, 'creating the passkey');
  }
  const { address } = Account.fromWebAuthnP256(credential);
  return keep(store, { credentialId: credential.id, publicKey: credential.publicKey, address });
}

export interface RootOptions {
  /** Used in place of `navigator.credentials.get`. */
  getFn?: Account.fromWebAuthnP256.Options['getFn'];
}

/**
 * Find again the passkey of an account whose public key this browser does
 * not hold: the account was made in another browser, or this one lost its
 * storage. An authenticator never gives a public key out a second time, but
 * a signature gives it away: the treasurer picks the passkey, it signs a
 * random challenge, and of the two keys that could have made that signature
 * the one whose address is the account's is the account's root. It is then
 * kept as `createPasskey` keeps one. A passkey of another account is refused.
 */
export async function recoverPasskey(address: string, options: RootOptions = {}): Promise<StoredPasskey> {
  const store = writable();
  let found: WebAuthnP256.getCredential.ReturnValue;
  try {
    found = await WebAuthnP256.getCredential({
      hash: toHex(crypto.getRandomValues(new Uint8Array(32))),
      // No credential is named: the authenticator offers the passkeys it holds for this site.
      rpId: relyingParty(),
      getPublicKey: async () => '0x',
      ...(options.getFn === undefined ? {} : { getFn: options.getFn }),
    });
  } catch (error) {
    throw walletError(error, 'finding the passkey');
  }

  // What a passkey signs: the authenticator data followed by the hash of the client data, hashed once more.
  const { authenticatorData, clientDataJSON } = found.metadata;
  const payload = Hash.sha256(Bytes.concat(Bytes.fromHex(authenticatorData), Hash.sha256(Bytes.fromString(clientDataJSON), { as: 'Bytes' })));
  for (const yParity of [0, 1]) {
    let publicKey: Hex;
    try {
      publicKey = PublicKey.toHex(P256.recoverPublicKey({ payload, signature: { r: found.signature.r, s: found.signature.s, yParity } }), { includePrefix: false });
    } catch {
      continue;
    }
    const account = Account.fromWebAuthnP256({ id: found.id, publicKey });
    if (account.address.toLowerCase() !== address.toLowerCase()) continue;
    return keep(store, { credentialId: found.id, publicKey, address: account.address });
  }
  throw new ClientError('wrong_account', `the passkey that answered is not the root of ${address}`);
}

/**
 * The root account of a stored passkey. Nothing is asked of the
 * authenticator until the account signs; each signature is one passkey
 * prompt, for the relying party the passkey was created under.
 */
export function tempoRoot(passkey: Pick<StoredPasskey, 'credentialId' | 'publicKey'>, options: RootOptions = {}): TempoRoot {
  return Account.fromWebAuthnP256(
    { id: passkey.credentialId, publicKey: passkey.publicKey },
    { rpId: relyingParty(), ...(options.getFn === undefined ? {} : { getFn: options.getFn }) },
  );
}

export interface TempoFlowOptions {
  api?: Api;
}

/** Record an account as the organisation's Tempo account, in its profile on the server. */
export async function linkTempoAccount(orgId: string, address: string, options: TempoFlowOptions = {}): Promise<Organisation> {
  const org = await (options.api ?? defaultApi).updateOrg(orgId, { tempoAccount: address });
  storage().removeItem(`${PENDING_PREFIX}${orgId}`);
  return org;
}

/**
 * Create the organisation's Tempo account: a new passkey, kept in this
 * browser, whose address is then recorded in the organisation's profile.
 * Should recording it fail, the passkey is not lost: `pendingPasskey` finds
 * it and `linkTempoAccount` records it.
 */
export async function createTempoAccount(orgId: string, options: CreatePasskeyOptions & TempoFlowOptions): Promise<{ passkey: StoredPasskey; org: Organisation }> {
  const passkey = await createPasskey(options);
  storage().setItem(`${PENDING_PREFIX}${orgId}`, passkey.address);
  return { passkey, org: await linkTempoAccount(orgId, passkey.address, options) };
}

function sameAccount(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * What an authorization is for besides its terms: which key it lets in, to
 * spend which token, on which chain. These are the rail's, as the treasurer
 * is shown it; the terms are the treasurer's own.
 */
export interface TempoGrant {
  /** The key id of the service's access key. The service's keys are P-256 keys. */
  accessKey: string;
  /** The one stablecoin the key may spend. */
  token: string;
  /** The id of the one chain the authorization is valid on. */
  chainId: number;
}

/**
 * The authorization the treasurer set the terms of: this key, on this chain,
 * may call `transferWithMemo` on this token and nothing else, within this
 * limit, until this expiry, paying these recipients or anyone when none are
 * listed. It is built here from the grant and the terms and holds nothing
 * they do not say: no admin key, no second token, no other call.
 */
export function buildAuthorization(grant: TempoGrant, terms: TempoTermsInput): KeyAuthorization.KeyAuthorization<false> {
  // Chain id 0 would make the authorization valid on every chain.
  if (!Number.isSafeInteger(grant.chainId) || grant.chainId <= 0) throw new ClientError('invalid_argument', `${String(grant.chainId)} is not the id of one chain`);
  for (const address of [grant.accessKey, grant.token, ...(terms.recipients ?? [])]) {
    if (!isAddress(address)) throw new ClientError('invalid_argument', `"${address}" is not an account address`);
  }
  if (terms.limit <= 0n) throw new ClientError('invalid_argument', 'the limit has to be more than nothing');
  if (!Number.isSafeInteger(terms.periodSeconds) || terms.periodSeconds < 0 || !Number.isSafeInteger(terms.expiry) || terms.expiry <= 0) {
    throw new ClientError('invalid_argument', 'the period and the expiry are whole numbers of seconds');
  }
  const token = getAddress(grant.token);
  const recipients = (terms.recipients ?? []).map((recipient) => getAddress(recipient));
  return KeyAuthorization.from({
    address: getAddress(grant.accessKey),
    type: 'p256',
    chainId: BigInt(grant.chainId),
    expiry: terms.expiry,
    limits: [{ token, limit: terms.limit, period: terms.periodSeconds }],
    scopes: [{ address: token, selector: TRANSFER_WITH_MEMO, ...(recipients.length > 0 ? { recipients } : {}) }],
  }) as KeyAuthorization.KeyAuthorization<false>;
}

/**
 * Sign what `/rails/tempo/authorization` answered, and return the signed
 * authorization in the serialization `/rails/tempo/authorization/submit`
 * takes as `signedWire`.
 *
 * The server hands back a 32-byte digest to sign. A digest says nothing of
 * what it stands for, so nothing else of the answer is used: the
 * authorization is built here from the grant and the treasurer's terms, and
 * the root signs only if the digest of that is the one the server sent. The
 * root then signs the digest itself: a secp256k1 root directly, a passkey as
 * the challenge of a WebAuthn assertion. What comes back from a passkey is
 * not a bare signature but a signature envelope, which carries the
 * authenticator data, the client data and the public key; the envelope is
 * attached to the authorization and the two are RLP-encoded together, which
 * is what the server decodes and checks against the account.
 */
export async function signTempoAuthorization(root: Pick<TempoRoot, 'address' | 'sign'>, request: Pick<TempoAuthorizationRequest, 'signPayload'>, grant: TempoGrant, terms: TempoTermsInput): Promise<Hex> {
  const authorization = buildAuthorization(grant, terms);
  const digest = KeyAuthorization.getSignPayload(authorization);
  if (typeof request.signPayload !== 'string' || digest.toLowerCase() !== request.signPayload.toLowerCase()) {
    throw new ClientError('unexpected_request', 'what the server asked to have signed is not the authorization these terms describe; nothing was signed');
  }

  let signature: Hex;
  try {
    signature = await root.sign({ hash: digest });
  } catch (error) {
    throw walletError(error, 'signing the authorization');
  }
  // The same check the server makes, made here first: a passkey whose stored public key is not its own fails it.
  let signedByRoot: boolean;
  let signedWire: Hex;
  try {
    signedByRoot = SignatureEnvelope.verify(SignatureEnvelope.from(signature), { address: root.address, payload: digest });
    signedWire = KeyAuthorization.serialize(KeyAuthorization.from(authorization, { signature }));
  } catch (error) {
    throw new ClientError('wallet_failed', 'the signature is not one that can be checked against the account', { cause: error });
  }
  if (!signedByRoot) throw new ClientError('wallet_failed', `the signature is not that of the root key of ${root.address}`);
  return signedWire;
}

/**
 * What the organisation's rail says an authorization is for, once it is
 * settled that this root is the root of the organisation's Tempo account and
 * that the key the rail names is the organisation's own access key.
 */
export async function tempoGrant(rootAddress: string, orgId: string, options: TempoFlowOptions = {}): Promise<TempoGrant> {
  const api = options.api ?? defaultApi;
  const [org, rail] = await Promise.all([api.getOrg(orgId), api.tempoRail(orgId)]);
  if (org.tempoAccount === null || rail.account === null) throw new ClientError('wrong_account', 'the organisation has no Tempo account yet; create one first');
  if (!sameAccount(org.tempoAccount, rootAddress) || !sameAccount(rail.account, rootAddress)) {
    throw new ClientError('wrong_account', `this is the root of ${rootAddress}, and the Tempo account of the organisation is ${org.tempoAccount}`);
  }
  const key = org.serviceKeys.find((candidate) => candidate.kind === 'tempo_access');
  if (key === undefined || rail.accessKey === null) throw new ClientError('nothing_to_sign', 'the organisation has no Tempo access key to authorize');
  if (!sameAccount(key.address, rail.accessKey)) throw new ClientError('unexpected_request', 'the key the rail names is not the access key of this organisation; nothing was signed');
  return { accessKey: rail.accessKey, token: rail.token.address, chainId: rail.chainId };
}

/**
 * Authorize the service's access key on the organisation's Tempo account,
 * on the terms given: read the rail, ask the server what to sign, sign it
 * with the root, and submit it. The server sends it to the chain and answers
 * once it is there; `tx` is null when the key already held exactly these
 * terms.
 */
export async function authorizeTempoAccessKey(root: Pick<TempoRoot, 'address' | 'sign'>, orgId: string, terms: TempoTermsInput, options: TempoFlowOptions = {}): Promise<TempoAuthorization> {
  const api = options.api ?? defaultApi;
  const grant = await tempoGrant(root.address, orgId, options);
  const request = await api.tempoAuthorization(orgId, terms);
  const signedWire = await signTempoAuthorization(root, request, grant, terms);
  return api.submitTempoAuthorization(orgId, { terms, signedWire });
}

/**
 * What the chain needs to know of a transaction besides what it does. The
 * root pays the fee itself, in `feeToken`, unless `feePayer` names who pays
 * in its place. The gas and the fee given here are the most whoever pays can
 * be made to pay: they are signed as given, so they are the caller's to
 * bound.
 */
export interface TempoRevokeFields {
  chainId: number;
  /** The access key to take back: the key id the root authorized. */
  accessKey: string;
  /** The next nonce of the account on `nonceKey`. */
  nonce: number;
  nonceKey?: bigint;
  gas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas?: bigint;
  /** The stablecoin the fee is paid in, where the root pays it. */
  feeToken?: string;
  /**
   * The account that pays the fee in the root's place. With one named, the
   * root signs a transaction that is valid only with a fee payer's signature
   * beside its own, and signs for no fee token: the fee payer names it.
   */
  feePayer?: string;
  /** Unix seconds after which the transaction can no longer be included. */
  validBefore?: number;
}

/**
 * Sign the transaction with which the root takes an access key back: one
 * call, `revokeKey(accessKey)` on the Account Keychain. A revoked key id can
 * never be authorized again. This signs and does not send. Without a fee
 * payer the result is the serialized transaction for
 * `eth_sendRawTransaction`. With one it is the same transaction as a sender
 * hands it to a fee payer: the node takes it once the fee payer has signed
 * too, and not before. Tempo holds a sender's signature to one or the other,
 * so a transaction signed here for a fee payer cannot be made to charge the
 * account, and one signed without cannot be paid for by anyone else.
 */
export async function signTempoRevoke(root: Pick<TempoRoot, 'address' | 'signTransaction'>, fields: TempoRevokeFields): Promise<Hex> {
  if (!isAddress(fields.accessKey)) throw new ClientError('invalid_argument', `"${fields.accessKey}" is not an access key address`);
  if (fields.feeToken !== undefined && !isAddress(fields.feeToken)) throw new ClientError('invalid_argument', `"${fields.feeToken}" is not a token address`);
  if (fields.feePayer !== undefined && !isAddress(fields.feePayer)) throw new ClientError('invalid_argument', `"${fields.feePayer}" is not an account address`);
  const call: { to: Address; data: Hex } = {
    to: Addresses.accountKeychain,
    data: encodeFunctionData({ abi: Abis.accountKeychain, functionName: 'revokeKey', args: [getAddress(fields.accessKey)] }),
  };
  // The sender's signature says only that a fee payer follows; which account that is, and in what token it pays, is the fee payer's own to sign.
  const payment = fields.feePayer !== undefined ? { feePayer: true as const } : fields.feeToken === undefined ? {} : { feeToken: getAddress(fields.feeToken) };
  try {
    return await root.signTransaction({
      type: 'tempo',
      chainId: fields.chainId,
      calls: [call],
      nonce: fields.nonce,
      gas: fields.gas,
      maxFeePerGas: fields.maxFeePerGas,
      ...(fields.maxPriorityFeePerGas === undefined ? {} : { maxPriorityFeePerGas: fields.maxPriorityFeePerGas }),
      ...(fields.nonceKey === undefined ? {} : { nonceKey: fields.nonceKey }),
      ...payment,
      ...(fields.validBefore === undefined ? {} : { validBefore: fields.validBefore }),
    });
  } catch (error) {
    throw walletError(error, 'signing the revocation');
  }
}

/** A whole number the server wrote in decimal digits, as amounts and gas travel; null for anything else. */
function wholeNumber(value: unknown): bigint | null {
  return typeof value === 'string' && /^(0|[1-9]\d{0,77})$/.test(value) ? BigInt(value) : null;
}

/**
 * The fields to sign for a revocation the server prepared. What is revoked,
 * and on which chain, is this side's to say: the organisation's own access
 * key, on the chain of its rail, with a fee payer paying. Only the nonce, the
 * gas, the fee and the deadline are the server's, and under a fee payer none
 * of them can cost the account anything. A request for another key or
 * another chain, or one the account would pay for itself, never reaches the
 * passkey.
 */
export function checkedRevokeFields(request: TempoRevokeRequest, grant: Pick<TempoGrant, 'accessKey' | 'chainId'>): TempoRevokeFields {
  const refuse = (why: string) => new ClientError('unexpected_request', `the revocation the server prepared ${why}; nothing was signed`);
  if (!Number.isSafeInteger(grant.chainId) || grant.chainId <= 0) throw new ClientError('invalid_argument', `${String(grant.chainId)} is not the id of one chain`);
  if (!isAddress(grant.accessKey)) throw new ClientError('invalid_argument', `"${grant.accessKey}" is not an access key address`);
  const fields: Record<string, unknown> = request;
  if (typeof fields.accessKey !== 'string' || !sameAccount(fields.accessKey, grant.accessKey)) throw refuse('is not for the access key of this organisation');
  if (fields.chainId !== grant.chainId) throw refuse(`is for chain ${String(fields.chainId)}, and the rail of the organisation is on chain ${grant.chainId}`);
  if (typeof fields.feePayer !== 'string' || !isAddress(fields.feePayer)) throw refuse('names nobody but the account itself to pay its fee');

  const { nonce, validBefore } = fields;
  const [nonceKey, gas, maxFeePerGas, maxPriorityFeePerGas] = [fields.nonceKey, fields.gas, fields.maxFeePerGas, fields.maxPriorityFeePerGas].map(wholeNumber);
  const numbered = typeof nonce === 'number' && Number.isSafeInteger(nonce) && nonce >= 0 && typeof validBefore === 'number' && Number.isSafeInteger(validBefore) && validBefore > 0;
  if (!numbered || nonceKey == null || gas == null || maxFeePerGas == null || maxPriorityFeePerGas == null) throw refuse('is not a transaction that can be signed');
  // On a sequence of its own nothing else the account sends would ever use up the nonce of a revocation that was signed and not sent.
  if (nonceKey !== 0n) throw refuse("is not numbered on the account's own sequence of transactions");
  return { chainId: grant.chainId, accessKey: getAddress(grant.accessKey), nonce, nonceKey, gas, maxFeePerGas, maxPriorityFeePerGas, feePayer: fields.feePayer, validBefore };
}

/**
 * Take the service's access key back from the organisation's Tempo account:
 * read the rail, ask the server for the revocation as the chain stands now,
 * sign it with the root, and hand it back. The server adds the signature of
 * its fee sponsor, which pays for the transaction, sends it, and answers once
 * the chain shows the key revoked. The account pays nothing and needs to hold
 * nothing. A revoked key can never be authorized again.
 */
export async function revokeTempoAccessKey(root: Pick<TempoRoot, 'address' | 'signTransaction'>, orgId: string, options: TempoFlowOptions = {}): Promise<TempoRevocation> {
  const api = options.api ?? defaultApi;
  const grant = await tempoGrant(root.address, orgId, options);
  const request = await api.tempoRevoke(orgId);
  const signedTransaction = await signTempoRevoke(root, checkedRevokeFields(request, grant));
  return api.submitTempoRevoke(orgId, { signedTransaction });
}
