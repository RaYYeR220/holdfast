import { type AssetInfo, unitsToNumber } from './assets';
import type { LedgerEntry } from './entry';
import type { PriceBook } from './prices';

export type Valuation = Pick<LedgerEntry, 'usd' | 'usdPrice' | 'usdPriceAt'>;

export const UNPRICED: Valuation = { usd: null, usdPrice: null, usdPriceAt: null };

/** An entry that moved nothing needs no price to be worth nothing. */
export const NO_VALUE: Valuation = { usd: 0, usdPrice: null, usdPriceAt: null };

/**
 * The dollar value of an amount at the moment it moved. Stablecoins are
 * carried at par, ZEC at the price observed at or just before that moment,
 * and anything else has no dollar value in these books.
 */
export function valueOf(amount: bigint, asset: AssetInfo, ts: number, prices: PriceBook): Valuation {
  const units = unitsToNumber(amount, asset.decimals);
  if (asset.usdPegged) return { usd: units, usdPrice: 1, usdPriceAt: ts };
  if (asset.symbol !== 'ZEC') return UNPRICED;
  const price = prices.at(ts);
  return price === null ? UNPRICED : { usd: units * price.px, usdPrice: price.px, usdPriceAt: price.ts };
}
