import { HYPERLIQUID_USDC, numberToUnits, PERP_DECIMALS } from '../assets';
import type { LedgerEntry, LedgerKind } from '../entry';
import { type ExplorerTemplates, proofOf } from '../explorers';
import { entryId, uniqueBy } from '../ids';
import type { FundingPayment, HedgeFill } from '../records';

export interface HyperliquidInput {
  fills: readonly HedgeFill[];
  funding: readonly FundingPayment[];
  explorers: ExplorerTemplates;
}

export const perpAsset = (coin: string): string => `${coin}-PERP`;

/** The venue says whether a fill opened or closed; where its label says neither, a sale adds to a short and a purchase reduces it. */
function hedgeKind(fill: HedgeFill): LedgerKind {
  if (/^open\b/i.test(fill.direction)) return 'hedge_open';
  if (/^close\b/i.test(fill.direction)) return 'hedge_close';
  return fill.side === 'sell' ? 'hedge_open' : 'hedge_close';
}

function usdcEntry(id: string, ts: number, kind: LedgerKind, usd: number, ref: string, explorers: ExplorerTemplates, tx: string | null): LedgerEntry {
  return {
    id,
    ts,
    source: 'hyperliquid',
    kind,
    asset: HYPERLIQUID_USDC.symbol,
    decimals: HYPERLIQUID_USDC.decimals,
    amount: numberToUnits(usd, HYPERLIQUID_USDC.decimals),
    usd,
    usdPrice: 1,
    usdPriceAt: ts,
    ref,
    counterparty: null,
    proof: proofOf('hyperliquid', tx, null, explorers),
    linked: [],
  };
}

function fillEntries(fill: HedgeFill, explorers: ExplorerTemplates): LedgerEntry[] {
  const ref = fill.cloid ?? '';
  const tx = fill.hash ?? null;
  const sign = fill.side === 'sell' ? -1 : 1;

  // The position itself: a sale makes the account shorter. Its dollar figure
  // is the notional traded at the fill price, not cash that changed hands.
  const position: LedgerEntry = {
    id: entryId.fill(fill),
    ts: fill.time,
    source: 'hyperliquid',
    kind: hedgeKind(fill),
    asset: perpAsset(fill.coin),
    decimals: PERP_DECIMALS,
    amount: numberToUnits(sign * fill.size, PERP_DECIMALS),
    usd: sign * fill.size * fill.px,
    usdPrice: fill.px,
    usdPriceAt: fill.time,
    ref,
    counterparty: null,
    proof: proofOf('hyperliquid', tx, null, explorers),
    linked: [],
  };

  const entries = [position];
  if (fill.closedPnlUsd !== 0) {
    entries.push(usdcEntry(entryId.fillPnl(fill), fill.time, 'realized_pnl', fill.closedPnlUsd, ref, explorers, tx));
  }
  if (fill.fee !== 0) {
    const fee = usdcEntry(entryId.fillFee(fill), fill.time, 'trade_fee', -fill.fee, ref, explorers, tx);
    // A fee charged in another token is booked in that token and left without a dollar value.
    entries.push(fill.feeToken === HYPERLIQUID_USDC.symbol ? fee : { ...fee, asset: fill.feeToken, usd: null, usdPrice: null, usdPriceAt: null });
  }

  const ids = entries.map((entry) => entry.id);
  return entries.map((entry) => ({ ...entry, linked: ids.filter((id) => id !== entry.id) }));
}

export function hyperliquidEntries(i: HyperliquidInput): LedgerEntry[] {
  const fills = uniqueBy(i.fills, (fill) => fill.tid).flatMap((fill) => fillEntries(fill, i.explorers));
  const funding = uniqueBy(i.funding, (payment) => entryId.funding(payment)).map((payment) =>
    usdcEntry(entryId.funding(payment), payment.time, 'funding', payment.usd, payment.coin, i.explorers, null),
  );
  return [...fills, ...funding];
}
