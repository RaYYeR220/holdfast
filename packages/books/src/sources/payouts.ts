import { type AssetDirectory, resolveAsset } from '../assets';
import type { LedgerEntry } from '../entry';
import { type ExplorerTemplates, proofOf } from '../explorers';
import { entryId, uniqueBy } from '../ids';
import type { PriceBook } from '../prices';
import { PAYOUT_PAID, type PayoutRunRecord } from '../records';
import { valueOf } from '../valuation';

export interface PayoutsInput {
  runs: readonly PayoutRunRecord[];
  assets: AssetDirectory;
  prices: PriceBook;
  explorers: ExplorerTemplates;
}

/**
 * One entry per line of every run that was paid. A run that is still a
 * draft, was refused or failed moved no money and is not in the ledger; one
 * that is being sent enters it when its payment is confirmed.
 */
export function payoutEntries(i: PayoutsInput): LedgerEntry[] {
  return uniqueBy(i.runs, (run) => run.id)
    .filter((run) => run.status === PAYOUT_PAID)
    .flatMap((run) => {
      const asset = resolveAsset(run.token, i.assets, run.chain);
      const ts = run.executedAt ?? run.createdAt;
      return uniqueBy(run.lines, (line) => String(line.lineNo)).map(
        (line): LedgerEntry => ({
          id: entryId.payout(run.id, line.lineNo),
          ts,
          source: run.chain,
          kind: 'payout',
          asset: asset.symbol,
          decimals: asset.decimals,
          amount: -line.amount,
          ...valueOf(-line.amount, asset, ts, i.prices),
          ref: line.memo,
          counterparty: { name: line.payeeName, address: line.toAddress },
          proof: proofOf(run.chain, line.tx ?? run.tx, null, i.explorers),
          linked: [],
        }),
      );
    });
}
