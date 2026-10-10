import { type Address, type Hex, isAddressEqual } from 'viem';
import type { SignedAuthorization } from './authorization';
import type { RawKeyState, RawScope } from './chain';
import { TRANSFER_WITH_MEMO_SELECTOR } from './tip20';
import type { KeyScope, KeyStatus } from './types';

/** What `remaining` reads for a key authorized without spending limits. */
export const UNLIMITED = 2n ** 256n - 1n;

/** A key authorized without an expiry stores the largest uint64; anything past year 9999 is treated the same. */
const NO_EXPIRY_AFTER = 253_402_300_800n;

/** Reduce the keychain's call scopes to what matters for a payout key on `token`. */
export function scopeOf(isScoped: boolean, scopes: readonly RawScope[], token: Address): KeyScope {
  if (!isScoped) return { unrestricted: true, selectors: null, recipients: null, otherTargets: [] };
  const onToken = scopes.filter((scope) => isAddressEqual(scope.target, token));
  const otherTargets = scopes.filter((scope) => !isAddressEqual(scope.target, token)).map((scope) => scope.target);
  if (onToken.length === 0) return { unrestricted: false, selectors: [], recipients: [], otherTargets };
  // A target listed without selector rules is open in full.
  if (onToken.some((scope) => scope.selectorRules.length === 0)) return { unrestricted: false, selectors: null, recipients: null, otherTargets };
  const rules = onToken.flatMap((scope) => scope.selectorRules);
  const selectors = [...new Set(rules.map((rule) => rule.selector.toLowerCase() as Hex))];
  const memoRules = rules.filter((rule) => rule.selector.toLowerCase() === TRANSFER_WITH_MEMO_SELECTOR);
  if (memoRules.length === 0) return { unrestricted: false, selectors, recipients: [], otherTargets };
  // A rule without recipients lets the selector pay anyone.
  const recipients = memoRules.some((rule) => rule.recipients.length === 0) ? null : memoRules.flatMap((rule) => [...rule.recipients]);
  return { unrestricted: false, selectors, recipients, otherTargets };
}

/** `now` is chain time in unix seconds. */
export function toKeyStatus(raw: RawKeyState, accessKey: Address, token: Address, now: number): KeyStatus {
  const known = isAddressEqual(raw.keyId, accessKey);
  const expires = known && raw.expiry < NO_EXPIRY_AFTER;
  const authorized = known && !raw.isRevoked && (!expires || raw.expiry > BigInt(now));
  return {
    accessKey,
    authorized,
    revoked: raw.isRevoked,
    expiresAt: expires ? Number(raw.expiry) * 1000 : null,
    limited: !known || raw.enforceLimits,
    // The keychain reports zero for a key without limits, and for a revoked or expired one.
    remaining: !authorized ? 0n : raw.enforceLimits ? raw.remaining : UNLIMITED,
    periodEnd: authorized && raw.periodEnd > 0n ? Number(raw.periodEnd) * 1000 : null,
    scope: scopeOf(raw.isScoped, raw.scopes, token),
  };
}

/** The status a key will have once a signed authorization is provisioned: full limit, nothing spent. */
export function grantedStatus(authorization: SignedAuthorization, token: Address, now: number): KeyStatus {
  const limit = authorization.limits?.find((entry) => isAddressEqual(entry.token, token));
  const raw: RawKeyState = {
    keyId: authorization.accessKey,
    expiry: authorization.expiry === null ? NO_EXPIRY_AFTER : BigInt(authorization.expiry),
    enforceLimits: authorization.limits !== null,
    isRevoked: false,
    remaining: limit?.limit ?? 0n,
    periodEnd: 0n,
    isScoped: authorization.isScoped,
    scopes: authorization.scopes,
  };
  return toKeyStatus(raw, authorization.accessKey, token, now);
}

/** Whether the scope lets the key call `selector` on the payout token. */
export function allowsSelector(scope: KeyScope, selector: Hex): boolean {
  return scope.unrestricted || scope.selectors === null || scope.selectors.includes(selector.toLowerCase() as Hex);
}

/** Whether the scope lets `transferWithMemo` pay `to`. */
export function allowsRecipient(scope: KeyScope, to: Address): boolean {
  if (!allowsSelector(scope, TRANSFER_WITH_MEMO_SELECTOR)) return false;
  return scope.recipients === null || scope.recipients.some((allowed) => isAddressEqual(allowed, to));
}
