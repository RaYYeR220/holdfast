import { KeyAuthorization } from 'ox/tempo';
import { type Address, type Hex, encodeFunctionData, getAddress, isAddress, isAddressEqual } from 'viem';
import { Abis, Account, Addresses, P256 } from 'viem/tempo';
import type { RawScope } from './chain';
import { type Call, TRANSFER_WITH_MEMO } from './tip20';

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
