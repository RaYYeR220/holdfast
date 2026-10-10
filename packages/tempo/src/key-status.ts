import { type Address, type Hex, isAddressEqual } from 'viem';
import type { SignedAuthorization } from './authorization';
import type { RawKeyState, RawScope } from './chain';
import { TRANSFER_WITH_MEMO_SELECTOR } from './tip20';
import type { KeyScope, KeyStatus } from './types';
import { formatBaseUnits } from './units';

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

/**
 * How a key differs from the only kind this rail pays with: one that has a
 * spending limit and whose call scope is `transferWithMemo` on the payout
 * token and nothing else. The product promises a bounded key, so a broader one
 * is not used even though the chain would accept its signature.
 */
export function boundProblems(limited: boolean, scope: KeyScope): string[] {
  const problems: string[] = [];
  if (!limited) problems.push('it has no spending limit');
  if (scope.unrestricted) return [...problems, 'it has no call scope and may call anything'];
  if (scope.otherTargets.length > 0) problems.push(`it may call other contracts (${scope.otherTargets.join(', ')})`);
  if (scope.selectors === null) return [...problems, 'it may call every function of the payout token'];
  const others = scope.selectors.filter((selector) => selector !== TRANSFER_WITH_MEMO_SELECTOR);
  if (others.length > 0) problems.push(`it may call other functions of the payout token (${others.join(', ')})`);
  if (!scope.selectors.includes(TRANSFER_WITH_MEMO_SELECTOR)) problems.push('it may not call transferWithMemo on the payout token');
  return problems;
}

/**
 * What the keychain says about `accessKey` on one account, judged against
 * what this rail accepts. `now` is chain time in unix seconds.
 *
 * A key limited only on some other token reads as a budget of zero: the
 * keychain answers zero both for a limit that is spent and for a token the
 * key has no limit on.
 */
export function toKeyStatus(raw: RawKeyState, accessKey: Address, token: Address, now: number): KeyStatus {
  const known = isAddressEqual(raw.keyId, accessKey);
  const expires = known && raw.expiry < NO_EXPIRY_AFTER;
  const live = known && !raw.isRevoked && (!expires || raw.expiry > BigInt(now));
  const limited = !known || raw.enforceLimits;
  const scope = scopeOf(raw.isScoped, raw.scopes, token);
  const mismatch = live ? boundProblems(limited, scope) : [];
  const authorized = live && mismatch.length === 0;
  return {
    accessKey,
    authorized,
    live,
    mismatch,
    revoked: raw.isRevoked,
    expiresAt: expires ? Number(raw.expiry) * 1000 : null,
    limited,
    remaining: authorized ? raw.remaining : 0n,
    periodEnd: authorized && raw.periodEnd > 0n ? Number(raw.periodEnd) * 1000 : null,
    scope,
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

function sameAddresses(a: readonly Address[] | null, b: readonly Address[] | null): boolean {
  if (a === null || b === null) return a === b;
  return a.length === b.length && a.every((address) => b.some((other) => isAddressEqual(address, other)));
}

/**
 * How a key that is already live differs from an authorization for the same
 * key id, as far as the keychain lets it be read: expiry and recipients in
 * full, the limit only as "more is left than the limit would allow".
 */
export function differencesFromAuthorization(key: KeyStatus, authorization: SignedAuthorization, token: Address): string[] {
  const expected = grantedStatus(authorization, token, 0);
  const differences: string[] = [];
  if (key.expiresAt !== expected.expiresAt) {
    const when = (ms: number | null) => (ms === null ? 'never' : new Date(ms).toISOString());
    differences.push(`it expires ${when(key.expiresAt)}, expected ${when(expected.expiresAt)}`);
  }
  if (!sameAddresses(key.scope.recipients, expected.scope.recipients)) {
    const list = (recipients: readonly Address[] | null) => (recipients === null ? 'anyone' : `[${recipients.join(', ')}]`);
    differences.push(`it may pay ${list(key.scope.recipients)}, expected ${list(expected.scope.recipients)}`);
  }
  if (key.remaining > expected.remaining) {
    differences.push(`it may still spend ${formatBaseUnits(key.remaining)}, more than the expected limit of ${formatBaseUnits(expected.remaining)}`);
  }
  return differences;
}

/** Whether the scope lets `transferWithMemo` pay `to`. */
export function allowsRecipient(scope: KeyScope, to: Address): boolean {
  if (scope.unrestricted || scope.selectors === null) return true;
  if (!scope.selectors.includes(TRANSFER_WITH_MEMO_SELECTOR)) return false;
  return scope.recipients === null || scope.recipients.some((allowed) => isAddressEqual(allowed, to));
}
