import type { PayoutLine } from '@holdfast/core';
import { type Address, isAddress } from 'viem';
import { allowsRecipient } from './key-status';
import { MAX_LINES_PER_RUN, lineOfMemo, memoProblem, runIdProblem } from './memo';
import type { KeyStatus } from './types';
import { formatBaseUnits } from './units';

/** How long a signed payout stays valid, in seconds of chain time. After that it can never be included. */
export const TX_VALIDITY_SECONDS = 60;

/**
 * Gas ceilings used to size the sponsor's float before anything is simulated.
 * Measured on Moderato: a transfer to an address that never held the token
 * costs about 268k gas, to a known one about 20k, and the first use of a
 * nonce lane adds 250k.
 */
const GAS_BASE = 600_000n;
const GAS_PER_LINE = 270_000n;
/** Provisioning a key: about 2.6M with a selector scope plus about 510k per allow-listed recipient. */
const GAS_AUTHORIZE_BASE = 3_000_000n;
const GAS_AUTHORIZE_PER_RECIPIENT = 520_000n;
/** The node suggests twice the base fee and the SDK adds a fifth on top. */
export const FEE_HEADROOM = 3n;
/** Gas is priced in units of 1e-18 USD, stablecoins count in 1e-6. */
const ATTO_PER_BASE_UNIT = 10n ** 12n;

export function gasCeiling(lines: number, authorizing: { recipients: number } | null = null): bigint {
  const authorize = authorizing ? GAS_AUTHORIZE_BASE + GAS_AUTHORIZE_PER_RECIPIENT * BigInt(authorizing.recipients) : 0n;
  return GAS_BASE + GAS_PER_LINE * BigInt(lines) + authorize;
}

/** The most a transaction with this gas ceiling can cost the sponsor, in fee-token base units. */
export function feeCeiling(gas: bigint, baseFeePerGas: bigint): bigint {
  const atto = gas * baseFeePerGas * FEE_HEADROOM;
  return (atto + ATTO_PER_BASE_UNIT - 1n) / ATTO_PER_BASE_UNIT;
}

export function totalOf(lines: readonly PayoutLine[]): bigint {
  return lines.reduce((sum, line) => sum + line.amount, 0n);
}

/** Problems that can be read off the request alone. With a run id, every memo must also be one of that run's line memos. */
export function lineProblems(lines: readonly PayoutLine[], runId?: string): string[] {
  const problems: string[] = [];
  const run = runId === undefined ? null : runIdProblem(runId);
  if (run) problems.push(run);
  if (lines.length === 0) problems.push('the run has no payout lines');
  if (lines.length > MAX_LINES_PER_RUN) problems.push(`${lines.length} lines exceed the ${MAX_LINES_PER_RUN} calls one Tempo transaction may carry`);
  const seen = new Set<string>();
  lines.forEach((line, i) => {
    const label = `line ${i + 1}`;
    // A mixed-case address has to carry a correct checksum: a wrong one is a typo, not a payee.
    if (!isAddress(line.to)) problems.push(`${label}: "${line.to}" is not a valid address`);
    if (line.amount <= 0n) problems.push(`${label}: amount must be positive`);
    const memo = memoProblem(line.memo);
    if (memo) {
      problems.push(`${label}: ${memo}`);
      return;
    }
    if (seen.has(line.memo)) problems.push(`${label}: memo "${line.memo}" is used by an earlier line`);
    seen.add(line.memo);
    if (runId !== undefined && !run && lineOfMemo(line.memo, runId) === null) {
      problems.push(`${label}: memo "${line.memo}" is not "${runId}/<line>" with a line from 1 to ${MAX_LINES_PER_RUN}`);
    }
  });
  return problems;
}

/** What the chain says at the moment a payout is about to be sent. */
export interface PayoutFacts {
  /** Chain time, unix seconds. */
  now: number;
  key: KeyStatus;
  /** The paying account's balance of the payout token. */
  rootBalance: bigint;
  /** The sponsor's balance of the fee token. */
  sponsorBalance: bigint;
  /** Worst-case fee of the transaction, in fee-token base units. */
  feeCeiling: bigint;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** Why the key cannot sign a payout right now; empty when it can. */
export function keyProblems(key: KeyStatus, now: number): string[] {
  if (key.revoked) return [`access key ${key.accessKey} was revoked`];
  if (key.expiresAt !== null && key.expiresAt <= now * 1000) return [`access key ${key.accessKey} expired at ${iso(key.expiresAt)}`];
  if (!key.live) return [`access key ${key.accessKey} is not authorized on this account`];
  if (key.mismatch.length > 0) return [`access key ${key.accessKey} is not the bounded payout key this rail accepts: ${key.mismatch.join('; ')}`];
  if (key.expiresAt !== null && key.expiresAt <= (now + TX_VALIDITY_SECONDS) * 1000) {
    return [`access key ${key.accessKey} expires at ${iso(key.expiresAt)}, before a payout sent now is certain to settle`];
  }
  return [];
}

/** Problems that depend on chain state. Assumes the lines themselves passed `lineProblems`. */
export function payoutProblems(input: { lines: readonly PayoutLine[]; sponsor: Address; facts: PayoutFacts }): string[] {
  const { lines, sponsor, facts } = input;
  const { key } = facts;
  const total = totalOf(lines);
  const problems = keyProblems(key, facts.now);

  if (key.authorized) {
    if (total > key.remaining) {
      const until = key.periodEnd === null ? '' : ` until ${iso(key.periodEnd)}`;
      problems.push(`the run totals ${formatBaseUnits(total)} but the key may only spend ${formatBaseUnits(key.remaining)} more${until}`);
    }
    lines.forEach((line, i) => {
      if (!allowsRecipient(key.scope, line.to as Address)) problems.push(`line ${i + 1}: ${line.to} is not on the key's recipient allow-list`);
    });
  }
  if (total > facts.rootBalance) {
    problems.push(`the run totals ${formatBaseUnits(total)} but the account holds ${formatBaseUnits(facts.rootBalance)} of the payout token`);
  }
  if (facts.feeCeiling > facts.sponsorBalance) {
    problems.push(`fee sponsor ${sponsor} holds ${formatBaseUnits(facts.sponsorBalance)} of the fee token, the fee may reach ${formatBaseUnits(facts.feeCeiling)}`);
  }
  return problems;
}
