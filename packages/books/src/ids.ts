/**
 * Ledger entry ids. Each is derived from the identity its source already
 * gives the record, so rebuilding the ledger from the same history gives the
 * same ids, and an entry can be traced back to its record.
 */
export const entryId = {
  /** A note or an outgoing payment; the scanner's ids already tell the two apart. */
  zcash: (recordId: string) => `zcash:${recordId}`,
  zcashFee: (txid: string) => `zcash:${txid}:fee`,
  swapOut: (swapId: string) => `swap:${swapId}:out`,
  swapIn: (swapId: string) => `swap:${swapId}:in`,
  fill: (fill: { oid: string; tid: string }) => `hl:fill:${fill.oid}:${fill.tid}`,
  fillFee: (fill: { oid: string; tid: string }) => `hl:fee:${fill.oid}:${fill.tid}`,
  fillPnl: (fill: { oid: string; tid: string }) => `hl:pnl:${fill.oid}:${fill.tid}`,
  funding: (payment: { coin: string; time: number }) => `hl:funding:${payment.coin}:${payment.time}`,
  payout: (runId: string, lineNo: number) => `payout:${runId}:${lineNo}`,
};

/** Records that share an id are the same record; the last one given stands, as it does in the store. */
export function uniqueBy<T>(items: readonly T[], key: (item: T) => string): T[] {
  return [...new Map(items.map((item) => [key(item), item])).values()];
}
