import type { OutgoingPayment, OwnedNote } from '@holdfast/core';
import { type AssetDirectory, KNOWN_ASSETS, resolveAsset, ZEC } from './assets';
import { compareEntries, type LedgerEntry } from './entry';
import { DEFAULT_EXPLORERS, type ExplorerTemplates } from './explorers';
import { entryId, uniqueBy } from './ids';
import { type PricePoint, priceBook } from './prices';
import type { FeeRecord, FundingPayment, HedgeFill, PayoutRunRecord, SwapRecord } from './records';
import { hyperliquidEntries } from './sources/hyperliquid';
import { payoutEntries } from './sources/payouts';
import { swapEntries } from './sources/swaps';
import { zcashEntries } from './sources/zcash';
import { matchSwapFunding } from './swap-funding';

export interface LedgerInput {
  /** Notes the treasury owns: payments received and change from its own spends. */
  notes?: readonly OwnedNote[];
  outgoing?: readonly OutgoingPayment[];
  fees?: readonly FeeRecord[];
  fills?: readonly HedgeFill[];
  funding?: readonly FundingPayment[];
  swaps?: readonly SwapRecord[];
  payoutRuns?: readonly PayoutRunRecord[];
  /** ZEC/USD, as a series or one point per event. */
  prices?: readonly PricePoint[];
  /** How old a price may be when it is applied; an hour unless set. */
  priceMaxAgeMs?: number;
  /** Tokens beyond the built-in swap assets, such as the ones payouts are made in. */
  assets?: AssetDirectory;
  explorers?: ExplorerTemplates;
}

/**
 * Everything that moved, in one list ordered by time.
 *
 * Each record of each source becomes one entry, apart from a fill, whose fee
 * and realised profit are entries of their own. Amounts are signed base units
 * of what the organisation holds, so the ZEC entries of the treasury add up
 * to the balance of its notes.
 */
export function buildLedger(input: LedgerInput): LedgerEntry[] {
  const assets = { ...KNOWN_ASSETS, ...input.assets };
  const explorers = { ...DEFAULT_EXPLORERS, ...input.explorers };
  const prices = priceBook(input.prices ?? [], input.priceMaxAgeMs);
  const outgoing = input.outgoing ?? [];
  const swaps = uniqueBy(input.swaps ?? [], (swap) => swap.id);

  // Only a swap paid in ZEC can have been funded by the treasury.
  const paidInZec = swaps.filter((swap) => resolveAsset(swap.originAsset, assets, 'unknown').chain === ZEC.chain);
  const funding = matchSwapFunding(paidInZec, outgoing);
  const deposits = new Map<string, SwapRecord>();
  const fundedBy = new Map<string, string>();
  for (const swap of paidInZec) {
    const outgoingId = funding.get(swap.id);
    if (outgoingId === undefined) continue;
    deposits.set(outgoingId, swap);
    fundedBy.set(swap.id, entryId.zcash(outgoingId));
  }

  return [
    ...zcashEntries({ notes: input.notes ?? [], outgoing, fees: input.fees ?? [], deposits, prices, explorers }),
    ...swapEntries({ swaps, fundedBy, assets, prices, explorers }),
    ...hyperliquidEntries({ fills: input.fills ?? [], funding: input.funding ?? [], explorers }),
    ...payoutEntries({ runs: input.payoutRuns ?? [], assets, prices, explorers }),
  ].sort(compareEntries);
}
