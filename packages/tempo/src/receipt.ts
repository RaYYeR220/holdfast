import type { PayoutLine } from '@holdfast/core';
import { type Address, type Hex, getAddress, hexToBigInt, isAddressEqual, toEventSelector } from 'viem';
import { Addresses } from 'viem/tempo';
import type { ChainLog } from './chain';
import { lineOfMemo, memoBytes, memoText } from './memo';
import { TRANSFER_TOPIC, TRANSFER_WITH_MEMO_TOPIC } from './tip20';
import type { PaidLine } from './types';
import { formatBaseUnits } from './units';

interface TokenTransfer {
  token: Address;
  from: Address;
  to: Address;
  amount: bigint;
  /** Present on `TransferWithMemo`, absent on the plain `Transfer` the token emits alongside it. */
  memo: Hex | null;
  logIndex: number;
}

type MemoTransfer = TokenTransfer & { memo: Hex };

function hasMemo(transfer: TokenTransfer): transfer is MemoTransfer {
  return transfer.memo !== null;
}

export type ReceiptCheck = { ok: true; lines: PaidLine[] } | { ok: false; problems: string[] };

function addressOfTopic(topic: Hex): Address {
  return getAddress(`0x${topic.slice(-40)}`);
}

function decode(log: ChainLog): TokenTransfer | null {
  const [signature, from, to, memo] = log.topics;
  if (!signature || !from || !to) return null;
  const withMemo = signature.toLowerCase() === TRANSFER_WITH_MEMO_TOPIC;
  if (!withMemo && signature.toLowerCase() !== TRANSFER_TOPIC) return null;
  if (withMemo && !memo) return null;
  return {
    token: getAddress(log.address),
    from: addressOfTopic(from),
    to: addressOfTopic(to),
    amount: log.data === '0x' ? 0n : hexToBigInt(log.data),
    memo: withMemo && memo ? (memo.toLowerCase() as Hex) : null,
    logIndex: log.logIndex,
  };
}

/** Text of an on-chain memo; memos nobody could have written with `memoBytes` stay hex. */
function readable(memo: Hex): string {
  try {
    return memoText(memo);
  } catch {
    return memo;
  }
}

/** Every token movement out of `root` that a receipt records. */
function outgoing(logs: readonly ChainLog[], root: Address): TokenTransfer[] {
  return logs.flatMap((log) => {
    const transfer = decode(log);
    return transfer && isAddressEqual(transfer.from, root) ? [transfer] : [];
  });
}

/** The lines of one run inside a receipt: `TransferWithMemo` events from `root` on `token` that carry one of the run's line memos. */
export function runLines(logs: readonly ChainLog[], root: Address, token: Address, runId: string): PaidLine[] {
  return outgoing(logs, root)
    .filter(hasMemo)
    .flatMap((transfer) => {
      const memo = readable(transfer.memo);
      const ours = isAddressEqual(transfer.token, token) && lineOfMemo(memo, runId) !== null;
      return ours ? [{ to: transfer.to, amount: transfer.amount, memo, logIndex: transfer.logIndex }] : [];
    });
}

/**
 * A payout succeeded only if the receipt shows exactly one
 * `TransferWithMemo(root, to, amount, memo)` per line and no other movement of
 * tokens out of the root.
 */
export function verifyPayoutLogs(input: { root: Address; token: Address; lines: readonly PayoutLine[]; logs: readonly ChainLog[] }): ReceiptCheck {
  const { root, token, lines, logs } = input;
  const transfers = outgoing(logs, root);
  const memoEvents = transfers.filter(hasMemo);
  const plainEvents = transfers.filter((transfer) => !hasMemo(transfer));
  const problems: string[] = [];
  const paid: PaidLine[] = [];

  const take = <T extends TokenTransfer>(from: T[], match: (transfer: T) => boolean): T | null => {
    const index = from.findIndex(match);
    return index === -1 ? null : (from.splice(index, 1)[0] ?? null);
  };

  lines.forEach((line, i) => {
    const label = `line ${i + 1} (${line.memo})`;
    const memo = memoBytes(line.memo);
    const exact = take(memoEvents, (t) => t.memo === memo && isAddressEqual(t.token, token) && isAddressEqual(t.to, line.to as Address) && t.amount === line.amount);
    if (exact) {
      paid.push({ to: exact.to, amount: exact.amount, memo: line.memo, logIndex: exact.logIndex });
      // The token emits a plain Transfer for the same movement; it is accounted for, not extra.
      take(plainEvents, (t) => isAddressEqual(t.token, token) && isAddressEqual(t.to, exact.to) && t.amount === exact.amount);
      return;
    }
    const near = take(memoEvents, (t) => t.memo === memo);
    if (!near) {
      problems.push(`${label}: no TransferWithMemo event carries this memo`);
      return;
    }
    take(plainEvents, (t) => isAddressEqual(t.token, near.token) && isAddressEqual(t.to, near.to) && t.amount === near.amount);
    if (!isAddressEqual(near.token, token)) problems.push(`${label}: paid in token ${near.token}, expected ${token}`);
    if (!isAddressEqual(near.to, line.to as Address)) problems.push(`${label}: paid to ${near.to}, expected ${line.to}`);
    if (near.amount !== line.amount) problems.push(`${label}: ${formatBaseUnits(near.amount)} on chain, expected ${formatBaseUnits(line.amount)}`);
  });

  for (const extra of memoEvents) {
    problems.push(`unexpected TransferWithMemo of ${formatBaseUnits(extra.amount)} to ${extra.to} with memo ${readable(extra.memo)}`);
  }
  for (const extra of plainEvents) {
    problems.push(`unexpected Transfer of ${formatBaseUnits(extra.amount)} from the account to ${extra.to}`);
  }
  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, lines: paid };
}

const KEY_AUTHORIZED_TOPIC = toEventSelector('KeyAuthorized(address,address,uint8,uint64)');

/** Whether a receipt records the keychain provisioning `accessKey` for `root`. */
export function keyAuthorizedIn(logs: readonly ChainLog[], root: Address, accessKey: Address): boolean {
  return logs.some((log) => {
    const [signature, account, key] = log.topics;
    if (!signature || !account || !key || !isAddressEqual(log.address, Addresses.accountKeychain)) return false;
    return signature.toLowerCase() === KEY_AUTHORIZED_TOPIC && isAddressEqual(addressOfTopic(account), root) && isAddressEqual(addressOfTopic(key), accessKey);
  });
}

/** Whether two sets of lines pay the same people the same amounts under the same memos. */
export function sameLines(expected: readonly PayoutLine[], found: readonly PaidLine[]): boolean {
  if (expected.length !== found.length) return false;
  const key = (to: string, amount: bigint, memo: string) => `${to.toLowerCase()}|${amount}|${memo}`;
  const remaining = found.map((line) => key(line.to, line.amount, line.memo));
  for (const line of expected) {
    const index = remaining.indexOf(key(line.to, line.amount, line.memo));
    if (index === -1) return false;
    remaining.splice(index, 1);
  }
  return true;
}
