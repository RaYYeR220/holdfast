import { ZAT_PER_LOT } from '@holdfast/core';
import type { JournalEntry } from '@holdfast/engine';
import type { LedgerEntry } from '../entry';
import { type Findings, journalRef } from '../problems';

const isFill = (entry: LedgerEntry) => entry.kind === 'hedge_open' || entry.kind === 'hedge_close';
const abs = (n: bigint) => (n < 0n ? -n : n);

/**
 * Each order the journal placed against the fills that carry its client order
 * id. An order can fill in several pieces, so sizes are compared in total.
 * A fill no order explains — a trade made by hand, a liquidation — is the
 * account doing something the controller did not decide.
 */
export function checkOrders(journal: readonly JournalEntry[], ledger: readonly LedgerEntry[], out: Findings): void {
  const fillsByCloid = new Map<string, LedgerEntry[]>();
  const explained = new Set<LedgerEntry>();
  for (const fill of ledger.filter(isFill)) {
    const cloid = fill.ref.toLowerCase();
    fillsByCloid.set(cloid, [...(fillsByCloid.get(cloid) ?? []), fill]);
  }

  const seen = new Map<string, number>();
  for (const entry of journal) {
    const order = entry.order;
    if (order === null) continue;
    const cloid = order.cloid.toLowerCase();
    const ref = journalRef(entry.seq);

    const earlier = seen.get(cloid);
    if (earlier !== undefined) {
      out.error('duplicate_cloid', `journal entries ${earlier} and ${entry.seq} placed orders under the same client order id ${order.cloid}`, journalRef(earlier), ref);
      continue;
    }
    seen.set(cloid, entry.seq);

    const fills = fillsByCloid.get(cloid) ?? [];
    for (const fill of fills) explained.add(fill);
    const ids = fills.map((fill) => fill.id);
    const filledLots = order.result.filledLots;

    if (fills.length === 0) {
      if (filledLots !== 0) {
        out.error('order_without_fill', `journal entry ${entry.seq} records ${filledLots} lot(s) filled for order ${order.cloid}, and the venue shows no fill for it`, ref);
      }
      continue;
    }

    const sidesAgree = fills.every((fill) => (order.side === 'sell' ? fill.amount < 0n : fill.amount > 0n));
    if (!sidesAgree) {
      out.error('fill_side_mismatch', `order ${order.cloid} of journal entry ${entry.seq} is a ${order.side}, but the venue filled it the other way`, ref, ...ids);
    }
    const filled = fills.reduce((sum, fill) => sum + abs(fill.amount), 0n);
    const sizesAgree = Number.isSafeInteger(filledLots) && filledLots >= 0 && BigInt(filledLots) * ZAT_PER_LOT === filled;
    if (!sizesAgree) {
      const venueLots = Number(filled) / Number(ZAT_PER_LOT);
      out.error('fill_size_mismatch', `journal entry ${entry.seq} records ${filledLots} lot(s) filled for order ${order.cloid}; the venue filled ${venueLots}`, ref, ...ids);
    }
    if (sidesAgree && sizesAgree) out.match('order', ref, ...ids);
  }

  for (const fill of ledger.filter(isFill)) {
    if (explained.has(fill)) continue;
    const label = fill.ref === '' ? 'carries no client order id' : `carries client order id ${fill.ref}, which no journal entry placed`;
    out.error('fill_without_order', `fill ${fill.id} ${label}`, fill.id);
  }
}
