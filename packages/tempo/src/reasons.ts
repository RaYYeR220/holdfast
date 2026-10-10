import type { Hex } from 'viem';
import { ExecutionError } from 'viem/tempo';

export interface RevertReason {
  /** First four bytes of the revert data. */
  selector: Hex;
  /** Error name as the precompile declares it, or `Unknown`. */
  name: string;
  message: string;
}

/** The two reverts the Account Keychain answers a bounded key with when it oversteps. */
export const SPENDING_LIMIT_EXCEEDED: Hex = '0x8a9e71ea';
export const CALL_NOT_ALLOWED: Hex = '0x576b38b4';

const MESSAGES: Record<string, string> = {
  SpendingLimitExceeded: 'the transfer exceeds what the access key may still spend',
  CallNotAllowed: 'the call is outside the scope the access key was authorized for',
  KeyAlreadyRevoked: 'the access key was revoked by the account',
  KeyExpired: 'the access key has expired',
  KeyNotFound: 'the access key is not authorized on this account',
  KeyAlreadyExists: 'the access key is already authorized on this account',
  ExpiryInPast: 'the authorization expires in the past',
};

const NAMES: Record<string, string> = {
  [SPENDING_LIMIT_EXCEEDED]: 'SpendingLimitExceeded',
  [CALL_NOT_ALLOWED]: 'CallNotAllowed',
};

/**
 * Name the error behind revert data. A reverted Tempo receipt carries no
 * reason; the data comes from `debug_traceTransaction` or from a failed
 * simulation. Returns null when there is no data to decode.
 */
export function decodeRevertReason(data: string | null | undefined): RevertReason | null {
  if (!data || !/^0x[0-9a-fA-F]{8}/.test(data)) return null;
  const selector = data.slice(0, 10).toLowerCase() as Hex;
  const known = NAMES[selector];
  if (known) return { selector, name: known, message: MESSAGES[known] ?? known };
  const decoded = ExecutionError.from(data as Hex);
  if (decoded.errorName !== 'unknown') return { selector, name: decoded.errorName, message: MESSAGES[decoded.errorName] ?? decoded.message };
  return { selector, name: 'Unknown', message: `unrecognised revert data ${data}` };
}

/**
 * One readable line for anything a send can fail with: revert data from a
 * simulation, a keychain rejection the node reports as text, or a transport
 * error.
 */
export function explainError(error: unknown): string {
  const reason = decodeRevertReason(revertDataOf(error));
  if (reason) return `${reason.name}: ${reason.message}`;
  const text = textOf(error);
  // Revoked and expired keys are refused during validation, as text and without revert data.
  const keychain = /(?:AccountKeychainError\(|keychain error: )(\w+)\(/i.exec(text);
  if (keychain?.[1]) return `${keychain[1]}: ${MESSAGES[keychain[1]] ?? text}`;
  return text;
}

function chainOf(error: unknown): Record<string, unknown>[] {
  const chain: Record<string, unknown>[] = [];
  const seen = new Set<unknown>();
  let current = error;
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    chain.push(current as Record<string, unknown>);
    current = (current as { cause?: unknown }).cause;
  }
  return chain;
}

function revertDataOf(error: unknown): string | null {
  for (const level of chainOf(error)) {
    const data = level.data;
    if (typeof data === 'string' && /^0x[0-9a-fA-F]{8,}$/.test(data)) return data;
    if (data && typeof data === 'object' && typeof (data as { data?: unknown }).data === 'string') return (data as { data: string }).data;
  }
  return null;
}

function textOf(error: unknown): string {
  if (typeof error === 'string') return error;
  const levels = chainOf(error);
  // The innermost level that says anything is the node's own wording.
  for (const level of [...levels].reverse()) {
    for (const key of ['details', 'shortMessage', 'message'] as const) {
      const value = level[key];
      if (typeof value === 'string' && value.trim().length > 0) return (value.split('\n')[0] ?? value).trim();
    }
  }
  return 'unknown error';
}
