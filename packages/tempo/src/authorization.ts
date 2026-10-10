import { KeyAuthorization, SignatureEnvelope } from 'ox/tempo';
import { type Address, type Hex, encodeFunctionData, getAddress, isAddress, isAddressEqual } from 'viem';
import { Abis, Account, Addresses, P256 } from 'viem/tempo';
import type { RawScope } from './chain';
import { type Call, TRANSFER_WITH_MEMO, TRANSFER_WITH_MEMO_SELECTOR } from './tip20';
import { formatBaseUnits } from './units';

/**
 * Each allow-listed recipient adds about 510k gas to the transaction that
 * provisions the key, and the estimator stops at 30M. Twenty-five keeps the
 * authorization under 16M gas and under the 1 kB size of the payment lane.
 */
export const MAX_SCOPED_RECIPIENTS = 25;

/** Unix seconds beyond this are almost certainly milliseconds passed by mistake. */
const LATEST_SANE_EXPIRY = 100_000_000_000;

export interface AccessKeyPolicyInput {
  /** The organisation's account; its root signs the authorization. */
  rootAddress: Address;
  /** Key id of the service's access key, from `generateAccessKey`. */
  accessKeyAddress: Address;
  /** The one stablecoin the key may spend. */
  token: Address;
  /** Spending limit in base units: per period, or once when `periodSeconds` is 0. */
  limit: bigint;
  /** Length of the spending window. The windows sit on a fixed grid that starts when the key is provisioned. */
  periodSeconds: number;
  /** Unix seconds after which the key stops working. */
  expiry: number;
  /** Payees the key may pay; omit to allow any recipient. */
  recipients?: readonly Address[];
  chainId: number;
}

export interface AccessKeyAuthorizationRequest {
  rootAddress: Address;
  /** The unsigned authorization, in the shape `ox/tempo` serializes. */
  authorization: KeyAuthorization.KeyAuthorization<false>;
  /**
   * The 32-byte digest the root signs: the WebAuthn challenge for a passkey,
   * the message hash for a secp256k1 key. It commits to the key id, chain,
   * expiry, limit and scope, and to nothing else.
   */
  signPayload: Hex;
  /** The same request as arguments for viem: `root.signKeyAuthorization(key, policy)`. */
  key: { address: Address; type: 'p256' };
  policy: {
    chainId: bigint;
    expiry: number;
    limits: { token: Address; limit: bigint; period: number }[];
    scopes: { address: Address; selector: string; recipients?: Address[] }[];
  };
}

/** A fresh P-256 key for the service. Only the address leaves the backend. */
export function generateAccessKey(): { privateKey: Hex; address: Address } {
  const privateKey = P256.randomPrivateKey();
  return { privateKey, address: accessKeyAddressOf(privateKey) };
}

export function accessKeyAddressOf(privateKey: Hex): Address {
  return Account.fromP256(privateKey).address;
}

/**
 * Describe the key the treasurer is asked to authorize: one token, a spending
 * limit, an expiry, and `transferWithMemo` on that token as the only call.
 */
export function buildAccessKeyAuthorization(input: AccessKeyPolicyInput): AccessKeyAuthorizationRequest {
  const rootAddress = requireAddress(input.rootAddress, 'rootAddress');
  const accessKey = requireAddress(input.accessKeyAddress, 'accessKeyAddress');
  const token = requireAddress(input.token, 'token');
  if (isAddressEqual(rootAddress, accessKey)) throw new RangeError('the access key must not be the root key');
  // Chain id 0 would make the authorization valid on every chain.
  if (!Number.isInteger(input.chainId) || input.chainId <= 0) throw new RangeError('chainId must be the id of one chain');
  if (input.limit <= 0n) throw new RangeError('limit must be positive');
  if (!Number.isInteger(input.periodSeconds) || input.periodSeconds < 0) throw new RangeError('periodSeconds must be a whole number of seconds, or 0 for a one-off limit');
  if (!Number.isInteger(input.expiry) || input.expiry <= 0) throw new RangeError('expiry must be a unix timestamp in seconds');
  if (input.expiry > LATEST_SANE_EXPIRY) throw new RangeError('expiry must be a unix timestamp in seconds, not milliseconds');

  const recipients = (input.recipients ?? []).map((recipient, i) => requireAddress(recipient, `recipients[${i}]`));
  if (new Set(recipients.map((recipient) => recipient.toLowerCase())).size !== recipients.length) throw new RangeError('recipients contains the same address twice');
  if (recipients.length > MAX_SCOPED_RECIPIENTS) throw new RangeError(`${recipients.length} recipients exceed the ${MAX_SCOPED_RECIPIENTS} an authorization can list at a workable cost`);

  const policy: AccessKeyAuthorizationRequest['policy'] = {
    chainId: BigInt(input.chainId),
    expiry: input.expiry,
    limits: [{ token, limit: input.limit, period: input.periodSeconds }],
    scopes: [{ address: token, selector: TRANSFER_WITH_MEMO, ...(recipients.length > 0 ? { recipients } : {}) }],
  };
  const authorization = KeyAuthorization.from({ address: accessKey, type: 'p256', ...policy }) as KeyAuthorization.KeyAuthorization<false>;
  return {
    rootAddress,
    authorization,
    signPayload: KeyAuthorization.getSignPayload(authorization),
    key: { address: accessKey, type: 'p256' },
    policy,
  };
}

/**
 * Turn a root-signed authorization into the hex string the backend stores and
 * submits. Pass the signature the root produced over `signPayload` (a
 * secp256k1 signature or a serialized WebAuthn envelope), or omit it when
 * `authorization` is already signed, as `root.signKeyAuthorization` returns it.
 */
export function serializeSignedAuthorization(
  authorization: KeyAuthorization.KeyAuthorization,
  signature?: Hex | KeyAuthorization.Signature,
): Hex {
  const signed = signature === undefined ? authorization : KeyAuthorization.from(authorization, { signature });
  if (!signed.signature) throw new RangeError('the authorization is not signed');
  return KeyAuthorization.serialize(signed);
}

export interface SignedAuthorization {
  signed: KeyAuthorization.Signed;
  accessKey: Address;
  chainId: number;
  /** Unix seconds; null when the key never expires. */
  expiry: number | null;
  /** Null when the key is authorized without spending limits. */
  limits: { token: Address; limit: bigint; period: number }[] | null;
  isScoped: boolean;
  scopes: RawScope[];
}

/** Decode what `serializeSignedAuthorization` produced, in the vocabulary of the keychain's own getters. */
export function readSignedAuthorization(wire: Hex): SignedAuthorization {
  const decoded = KeyAuthorization.deserialize(wire);
  if (!decoded.signature) throw new RangeError('the authorization is not signed');
  if (decoded.isAdmin) throw new RangeError('admin key authorizations are not accepted: an admin key is not bounded');
  // The wire lists one entry per selector; the keychain groups them by target, and a target without a selector is open in full.
  const targets = new Map<Address, { open: boolean; rules: RawScope['selectorRules'][number][] }>();
  for (const scope of decoded.scopes ?? []) {
    const target = getAddress(scope.address);
    const entry = targets.get(target) ?? { open: false, rules: [] };
    if (scope.selector) entry.rules.push({ selector: scope.selector as Hex, recipients: (scope.recipients ?? []).map((recipient) => getAddress(recipient)) });
    else entry.open = true;
    targets.set(target, entry);
  }
  const scopes = [...targets].map(([target, entry]) => ({ target, selectorRules: entry.open ? [] : entry.rules }));
  return {
    signed: decoded as KeyAuthorization.Signed,
    accessKey: getAddress(decoded.address),
    chainId: Number(decoded.chainId),
    expiry: decoded.expiry ?? null,
    limits: decoded.limits ? decoded.limits.map((limit) => ({ token: getAddress(limit.token), limit: limit.limit, period: limit.period ?? 0 })) : null,
    isScoped: decoded.scopes !== undefined,
    scopes,
  };
}

export type AuthorizationCheck = { ok: true; authorization: SignedAuthorization } | { ok: false; problems: string[] };

function when(seconds: number | null): string {
  return seconds === null ? 'never' : new Date(seconds * 1000).toISOString();
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Where the terms a signature covers differ from the terms the caller expects, in words. */
function termDifferences(authorization: SignedAuthorization, expected: AccessKeyPolicyInput): string[] {
  const differences: string[] = [];
  if (authorization.expiry !== expected.expiry) differences.push(`it expires ${when(authorization.expiry)}, expected ${when(expected.expiry)}`);

  const { limits } = authorization;
  const limit = limits?.[0];
  if (limits === null) differences.push('it sets no spending limit');
  else if (limits.length !== 1 || !limit) differences.push(`it sets ${limits.length} spending limits, expected exactly one`);
  else if (!isAddressEqual(limit.token, expected.token)) differences.push(`its spending limit is on token ${limit.token}, expected ${expected.token}`);
  else if (limit.limit !== expected.limit || limit.period !== expected.periodSeconds) {
    differences.push(`it allows ${formatBaseUnits(limit.limit)} per ${limit.period} s, expected ${formatBaseUnits(expected.limit)} per ${expected.periodSeconds} s`);
  }

  const scope = authorization.scopes[0];
  const rule = scope?.selectorRules[0];
  const narrow = authorization.isScoped && authorization.scopes.length === 1 && scope !== undefined && isAddressEqual(scope.target, expected.token);
  if (!narrow || scope.selectorRules.length !== 1 || !rule || rule.selector.toLowerCase() !== TRANSFER_WITH_MEMO_SELECTOR) {
    differences.push(`its call scope is not transferWithMemo on ${expected.token} alone`);
  } else {
    const wanted = expected.recipients ?? [];
    const same = rule.recipients.length === wanted.length && rule.recipients.every((recipient) => wanted.some((other) => isAddressEqual(recipient, other)));
    const list = (recipients: readonly Address[]) => (recipients.length === 0 ? 'anyone' : `[${recipients.join(', ')}]`);
    if (!same) differences.push(`it may pay ${list(rule.recipients)}, expected ${list(wanted)}`);
  }
  return differences;
}

/**
 * Decide whether a signed authorization may be submitted. It may only when it
 * is, to the byte, the authorization `buildAccessKeyAuthorization` produces
 * for the terms the caller expects, when those terms are for this rail's key,
 * token and chain, and when the signature over it is the root key's of
 * `account`. All of it is settled here, before anything is sent: once a key
 * is provisioned only the root can take it back.
 *
 * The signature is checked against the account's own address, so the root has
 * to be a secp256k1 key or a passkey; other signature types are refused.
 */
export function verifySignedAuthorization(input: {
  wire: Hex;
  expected: AccessKeyPolicyInput;
  account: Address;
  accessKey: Address;
  token: Address;
  chainId: number;
}): AuthorizationCheck {
  const { expected, account, accessKey, token, chainId } = input;
  let request: AccessKeyAuthorizationRequest;
  try {
    request = buildAccessKeyAuthorization(expected);
  } catch (error) {
    return { ok: false, problems: [`the expected policy is not valid: ${reasonOf(error)}`] };
  }
  const problems: string[] = [];
  if (!isAddressEqual(request.rootAddress, account)) problems.push(`the expected policy is for account ${request.rootAddress}, not ${account}`);
  if (!isAddressEqual(request.key.address, accessKey)) problems.push(`the expected policy is for key ${request.key.address}, this rail signs with ${accessKey}`);
  if (!isAddressEqual(expected.token, token)) problems.push(`the expected policy is for token ${expected.token}, this rail pays in ${token}`);
  if (expected.chainId !== chainId) problems.push(`the expected policy is for chain ${expected.chainId}, this rail runs on chain ${chainId}`);

  let authorization: SignedAuthorization;
  try {
    authorization = readSignedAuthorization(input.wire);
  } catch (error) {
    return { ok: false, problems: [...problems, `the authorization cannot be read: ${reasonOf(error)}`] };
  }
  if (!isAddressEqual(authorization.accessKey, accessKey)) problems.push(`the authorization is for key ${authorization.accessKey}, this rail signs with ${accessKey}`);
  if (authorization.chainId !== chainId) problems.push(`the authorization is for chain ${authorization.chainId}, this rail runs on chain ${chainId}`);
  problems.push(...termDifferences(authorization, expected).map((difference) => `the authorization differs from the expected policy: ${difference}`));
  if (problems.length > 0) return { ok: false, problems };

  // The digest covers every field, including ones the comparison above has no words for.
  if (KeyAuthorization.getSignPayload(authorization.signed) !== request.signPayload) {
    return { ok: false, problems: ['the authorization is not the one built from the expected policy'] };
  }
  let signedByRoot: boolean;
  try {
    signedByRoot = SignatureEnvelope.verify(authorization.signed.signature, { address: account, payload: request.signPayload });
  } catch {
    return { ok: false, problems: [`the authorization carries a ${authorization.signed.signature.type} signature, which cannot be checked against the account; the root has to be a secp256k1 key or a passkey`] };
  }
  if (!signedByRoot) return { ok: false, problems: [`the authorization is not signed by the root key of ${account}`] };
  return { ok: true, authorization };
}

/**
 * The call the root sends to take the key away, effective in the block that
 * includes it. A revoked key id can never be authorized again.
 */
export function buildRevoke(input: { accessKeyAddress: Address }): Call {
  const accessKey = requireAddress(input.accessKeyAddress, 'accessKeyAddress');
  return {
    to: Addresses.accountKeychain,
    data: encodeFunctionData({ abi: Abis.accountKeychain, functionName: 'revokeKey', args: [accessKey] }),
  };
}

function requireAddress(value: string, name: string): Address {
  if (!isAddress(value)) throw new RangeError(`${name} "${value}" is not a valid address`);
  return getAddress(value);
}
