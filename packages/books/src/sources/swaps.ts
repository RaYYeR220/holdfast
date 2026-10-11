import { type AssetDirectory, resolveAsset } from '../assets';
import type { LedgerEntry } from '../entry';
import { type ExplorerTemplates, proofOf } from '../explorers';
import { entryId, uniqueBy } from '../ids';
import type { PriceBook } from '../prices';
import { type SwapRecord, SWAP_SUCCESS, swapSawDeposit } from '../records';
import { valueOf } from '../valuation';

export interface SwapsInput {
  swaps: readonly SwapRecord[];
  /** Ledger id of the treasury payment that funded each swap, by swap id. */
  fundedBy: ReadonlyMap<string, string>;
  assets: AssetDirectory;
  prices: PriceBook;
  explorers: ExplorerTemplates;
}

/**
 * What a swap adds to the ledger beside the treasury payment that funded it.
 *
 * The input leg is that payment, already booked from the Zcash side. A swap
 * whose deposit the treasury's own history does not show still spent
 * something, so its input leg is booked here from the swap record instead of
 * being left out. The output leg is booked once the swap has delivered.
 */
export function swapEntries(i: SwapsInput): LedgerEntry[] {
  const entries: LedgerEntry[] = [];

  for (const swap of uniqueBy(i.swaps, (s) => s.id)) {
    const origin = resolveAsset(swap.originAsset, i.assets, 'unknown');
    const destination = resolveAsset(swap.destinationAsset, i.assets, 'unknown');
    const arrived = swap.state === SWAP_SUCCESS && swap.amountOut !== null;
    const funding = i.fundedBy.get(swap.id);
    const outId = funding ?? (swapSawDeposit(swap) ? entryId.swapOut(swap.id) : null);

    if (funding === undefined && outId !== null) {
      entries.push({
        id: outId,
        ts: swap.createdAt,
        source: 'swap',
        kind: 'swap_out',
        asset: origin.symbol,
        decimals: origin.decimals,
        amount: -swap.amountIn,
        ...valueOf(-swap.amountIn, origin, swap.createdAt, i.prices),
        ref: swap.id,
        counterparty: { name: null, address: swap.depositAddress },
        proof: proofOf(origin.chain, swap.originTxs[0] ?? null, null, i.explorers),
        linked: arrived ? [entryId.swapIn(swap.id)] : [],
      });
    }

    if (arrived && swap.amountOut !== null) {
      entries.push({
        id: entryId.swapIn(swap.id),
        ts: swap.updatedAt,
        source: 'swap',
        kind: 'swap_in',
        asset: destination.symbol,
        decimals: destination.decimals,
        amount: swap.amountOut,
        ...valueOf(swap.amountOut, destination, swap.updatedAt, i.prices),
        ref: swap.id,
        counterparty: { name: null, address: swap.recipient },
        proof: proofOf(destination.chain, swap.destinationTxs[0] ?? null, null, i.explorers),
        linked: outId === null ? [] : [outId],
      });
    }
  }
  return entries;
}
