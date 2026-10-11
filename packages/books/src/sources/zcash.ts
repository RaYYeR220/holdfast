import type { OutgoingPayment, OwnedNote } from '@holdfast/core';
import { ZEC } from '../assets';
import type { LedgerEntry, LedgerKind } from '../entry';
import { type ExplorerTemplates, proofOf } from '../explorers';
import { entryId, uniqueBy } from '../ids';
import type { PriceBook } from '../prices';
import { type FeeRecord, type SwapRecord, SWAP_SUCCESS } from '../records';
import { NO_VALUE, valueOf } from '../valuation';

export interface ZcashInput {
  notes: readonly OwnedNote[];
  outgoing: readonly OutgoingPayment[];
  fees: readonly FeeRecord[];
  /** The swap each deposit paid for, by outgoing id. */
  deposits: ReadonlyMap<string, SwapRecord>;
  prices: PriceBook;
  explorers: ExplorerTemplates;
}

interface BlockTime {
  height: number;
  time: number;
}

/**
 * A fee row names its transaction and, in the database, its block, but not a
 * time. It takes the time of its transaction's other records; a transaction
 * that left nothing else takes the time of the nearest block the treasury has
 * a record in.
 */
function feeMoment(fee: FeeRecord, byTx: ReadonlyMap<string, BlockTime>, known: readonly BlockTime[]): { ts: number; block: number | null } {
  const sibling = byTx.get(fee.txid);
  const block = fee.height ?? sibling?.height ?? null;
  if (typeof fee.time === 'number') return { ts: fee.time, block };
  if (sibling !== undefined) return { ts: sibling.time, block };
  if (block === null) return { ts: 0, block };
  const before = known.findLast((b) => b.height <= block);
  const nearest = before ?? known.find((b) => b.height > block);
  return { ts: nearest?.time ?? 0, block };
}

/**
 * A note is income only if somebody else sent it. Change is the treasury's
 * own money coming back from its own spend, and so is a note the treasury
 * addressed to itself in a transaction it made: the note exists, but nothing
 * was received.
 */
function noteKind(note: OwnedNote, ownTransactions: ReadonlySet<string>): LedgerKind {
  if (note.kind === 'change' || ownTransactions.has(note.txid)) return 'change';
  // Without a nullifier the viewing key cannot see the note being spent.
  return note.nullifier === null ? 'receipt_untracked' : 'receipt';
}

export function zcashEntries(i: ZcashInput): LedgerEntry[] {
  const notes = uniqueBy(i.notes, (n) => n.id);
  const outgoing = uniqueBy(i.outgoing, (o) => o.id);
  const fees = uniqueBy(i.fees, (f) => f.txid);

  const byTx = new Map<string, BlockTime>();
  for (const record of [...notes, ...outgoing]) {
    if (!byTx.has(record.txid)) byTx.set(record.txid, { height: record.height, time: record.time });
  }
  const known = [...byTx.values()].sort((a, b) => a.height - b.height);

  // The treasury made a transaction if it paid its fee, sent something out of it or took change from it.
  const ownTransactions = new Set([...fees, ...outgoing, ...notes.filter((n) => n.kind === 'change')].map((record) => record.txid));

  const base = { source: 'zcash', asset: ZEC.symbol, decimals: ZEC.decimals } as const;
  const entries: (LedgerEntry & { txid: string })[] = [];

  for (const note of notes) {
    const kind = noteKind(note, ownTransactions);
    // Booking the value of change would count it as income, and its
    // transaction would no longer add up to what left the treasury.
    const amount = kind === 'change' ? 0n : note.zat;
    entries.push({
      ...base,
      id: entryId.zcash(note.id),
      ts: note.time,
      kind,
      amount,
      ...(kind === 'change' ? NO_VALUE : valueOf(amount, ZEC, note.time, i.prices)),
      ref: note.memo,
      counterparty: null,
      proof: proofOf('zcash', note.txid, note.height, i.explorers),
      linked: [],
      txid: note.txid,
    });
  }

  for (const out of outgoing) {
    const swap = i.deposits.get(out.id);
    const arrived = swap !== undefined && swap.state === SWAP_SUCCESS && swap.amountOut !== null;
    entries.push({
      ...base,
      id: entryId.zcash(out.id),
      ts: out.time,
      // A payment that funds a swap converts the treasury's ZEC; it pays nobody.
      kind: swap === undefined ? 'payment' : 'swap_out',
      amount: -out.zat,
      ...valueOf(-out.zat, ZEC, out.time, i.prices),
      ref: swap === undefined ? out.memo : swap.id,
      counterparty: swap === undefined ? null : { name: null, address: swap.depositAddress },
      proof: proofOf('zcash', out.txid, out.height, i.explorers),
      linked: arrived ? [entryId.swapIn(swap.id)] : [],
      txid: out.txid,
    });
  }

  for (const fee of fees) {
    const { ts, block } = feeMoment(fee, byTx, known);
    entries.push({
      ...base,
      id: entryId.zcashFee(fee.txid),
      ts,
      kind: 'network_fee',
      amount: -fee.zat,
      ...valueOf(-fee.zat, ZEC, ts, i.prices),
      ref: '',
      counterparty: null,
      proof: proofOf('zcash', fee.txid, block, i.explorers),
      linked: [],
      txid: fee.txid,
    });
  }

  const idsByTx = new Map<string, string[]>();
  for (const entry of entries) idsByTx.set(entry.txid, [...(idsByTx.get(entry.txid) ?? []), entry.id]);

  return entries.map(({ txid, ...entry }) => ({
    ...entry,
    linked: [...(idsByTx.get(txid) ?? []).filter((id) => id !== entry.id), ...entry.linked].sort(),
  }));
}
