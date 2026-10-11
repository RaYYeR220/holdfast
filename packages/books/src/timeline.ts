import { isUsablePrice, navUsd, zatToZec } from '@holdfast/core';
import type { JournalEntry } from '@holdfast/engine';
import { belongsToItsSource, type LedgerEntry } from './entry';

/** The lock a moment falls under: the short opened from flat and not yet fully bought back. */
export interface LockState {
  /** Journal entry whose order opened it. */
  seq: number;
  at: number;
  /** Value of everything at that entry, read before its order traded. */
  navUsd: number | null;
  /** Dollars received less dollars paid out since; null once a flow without a dollar value has been met. */
  externalUsd: number | null;
  /** ZEC the same holdings would be had none of it been hedged or sold for margin. */
  unhedgedZec: number | null;
}

export interface TimelinePoint {
  seq: number;
  at: number;
  /** The venue's mark, or the reference price when the venue was not read. */
  px: number | null;
  /** Treasury, hedge account and payout float together; null when a leg was not read. */
  navUsd: number | null;
  unhedgedUsd: number | null;
  /** The lock in force when the entry was written; the entry that opens a lock is not yet under it. */
  lock: LockState | null;
}

export interface Timeline {
  points: TimelinePoint[];
  /** The lock in force after the last entry. */
  lock: LockState | null;
}

const add = (a: number | null, b: number | null): number | null => (a === null || b === null ? null : a + b);

/** Ledger entries that change what the three legs are worth or count as money in or out. */
function movesValue(entry: LedgerEntry): boolean {
  if (!belongsToItsSource(entry)) return false;
  if (entry.kind === 'receipt' || entry.kind === 'payment' || entry.kind === 'payout') return true;
  // Swap proceeds delivered to the venue are part of its account value already.
  return entry.kind === 'swap_in' && entry.proof.chain !== 'hyperliquid';
}

/**
 * Replays the journal with the ledger beside it, giving each entry the value
 * of the whole organisation at that moment and what it would have been
 * unhedged.
 *
 * The journal has the treasury balance and the venue's account value; the
 * ledger supplies what the journal does not hold: stablecoins swapped out to
 * the payout chains and not yet paid (the float), and which changes in value
 * were money arriving or leaving on purpose. A treasury entry takes effect at
 * the journal entry whose scan reached its block, which is when the balance
 * the journal recorded began to include it; everything else takes effect by
 * time.
 *
 * Unhedged value restates the holdings at the moment a lock opened as ZEC and
 * carries that forward: receipts add ZEC, payments remove it, and a payout
 * removes the ZEC it would have taken to fund at the price of the day.
 */
export function walkJournal(journal: readonly JournalEntry[], ledger: readonly LedgerEntry[]): Timeline {
  const flows = ledger.filter(movesValue);
  const byBlock = flows.filter((e) => e.proof.block !== null).sort((a, b) => (a.proof.block as number) - (b.proof.block as number));
  const byTime = flows.filter((e) => e.proof.block === null).sort((a, b) => a.ts - b.ts);
  let nextByBlock = 0;
  let nextByTime = 0;

  let floatUsd: number | null = 0;
  let lock: LockState | null = null;
  const points: TimelinePoint[] = [];

  for (const entry of [...journal].sort((a, b) => a.seq - b.seq)) {
    const { treasury, hl, ref } = entry.snapshot;
    const venueOk = hl !== null && isUsablePrice(hl.markPx) && Number.isFinite(hl.accountValueUsd);
    const px = venueOk ? hl.markPx : ref !== null && isUsablePrice(ref.px) ? ref.px : null;

    const due: LedgerEntry[] = [];
    if (entry.scan !== null) {
      for (let flow = byBlock[nextByBlock]; flow !== undefined && (flow.proof.block as number) <= entry.scan.to; flow = byBlock[++nextByBlock]) {
        due.push(flow);
      }
    }
    for (let flow = byTime[nextByTime]; flow !== undefined && flow.ts <= entry.at; flow = byTime[++nextByTime]) due.push(flow);

    for (const flow of due) {
      if (flow.kind === 'swap_in' || flow.kind === 'payout') floatUsd = add(floatUsd, flow.usd);
      if (flow.kind === 'swap_in' || lock === null) continue;
      lock.externalUsd = add(lock.externalUsd, flow.usd);
      const zec = flow.kind === 'payout' ? (flow.usd === null || px === null ? null : flow.usd / px) : zatToZec(flow.amount);
      lock.unhedgedZec = add(lock.unhedgedZec, zec);
    }

    const nav =
      treasury !== null && venueOk && floatUsd !== null
        ? navUsd({ treasuryZat: BigInt(treasury.zat), px: hl.markPx, hlAccountValueUsd: hl.accountValueUsd, payoutFloatUsd: floatUsd })
        : null;

    // A flat account is under no lock, unless this very entry opens one.
    if (hl !== null && hl.shortLots === 0) lock = null;
    const unhedgedUsd = lock === null ? nav : lock.unhedgedZec === null || px === null ? null : lock.unhedgedZec * px;
    points.push({ seq: entry.seq, at: entry.at, px, navUsd: nav, unhedgedUsd, lock: lock === null ? null : { ...lock } });

    const order = entry.order;
    const opens = hl !== null && hl.shortLots === 0 && order !== null && order.side === 'sell' && order.result.filledLots > 0;
    if (opens) {
      lock = { seq: entry.seq, at: entry.at, navUsd: nav, externalUsd: 0, unhedgedZec: nav === null || px === null ? null : nav / px };
    }
  }

  return { points, lock };
}
