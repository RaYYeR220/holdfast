import { HYPERLIQUID_USDC, PERP_DECIMALS, unitsToNumber, ZEC } from '../assets';
import { KINDS_BY_SOURCE, type LedgerEntry, type LedgerKind } from '../entry';
import type { Findings } from '../problems';

const MAX_DECIMALS = 36;

const INFLOWS: readonly LedgerKind[] = ['receipt', 'receipt_untracked', 'swap_in'];
const OUTFLOWS: readonly LedgerKind[] = ['payment', 'swap_out', 'network_fee', 'payout'];
const POSITIONS: readonly LedgerKind[] = ['hedge_open', 'hedge_close'];

/** Float arithmetic on amounts of this size is good to far better than this. */
const USD_TOLERANCE = 1e-9;

function valueFault(entry: LedgerEntry): string | null {
  if (entry.usd === null) return entry.usdPrice === null ? null : 'carries a price and no dollar value';
  if (entry.usdPrice === null) return entry.amount === 0n && entry.usd === 0 ? null : 'carries a dollar value and no price';

  // The books price ZEC and positions at a market price and everything else they price at par.
  const atMarket = entry.asset === ZEC.symbol || POSITIONS.includes(entry.kind);
  if (!(entry.usdPrice > 0)) return 'carries a price that is not a price';
  if (!atMarket && entry.usdPrice !== 1) return 'prices a stablecoin away from one dollar';

  // A venue figure is rounded into base units when it is booked, so the two may differ by one unit's worth.
  const expected = unitsToNumber(entry.amount, entry.decimals) * entry.usdPrice;
  const slack = USD_TOLERANCE * Math.abs(expected) + entry.usdPrice / 10 ** entry.decimals;
  return Math.abs(entry.usd - expected) <= slack ? null : 'carries a dollar value that is not its amount at its price';
}

/** What is wrong with an entry as an entry, whatever the records say; null when nothing is. */
function faultOf(entry: LedgerEntry, ids: ReadonlySet<string>): string | null {
  const kinds = Object.hasOwn(KINDS_BY_SOURCE, entry.source) ? KINDS_BY_SOURCE[entry.source] : [];
  if (!kinds.includes(entry.kind)) return `is a ${entry.kind} from ${entry.source}, which that source does not produce`;
  if (!Number.isInteger(entry.decimals) || entry.decimals < 0 || entry.decimals > MAX_DECIMALS) return 'has decimals no asset has';
  // The link is shown to people; the books only ever write an explorer page over https.
  if (entry.proof.url !== null && !entry.proof.url.startsWith('https://')) return 'links to something that is not a web page';

  if (entry.source === 'zcash' && (entry.asset !== ZEC.symbol || entry.decimals !== ZEC.decimals)) return 'is a Zcash entry that is not in zatoshi';
  if (entry.source === 'hyperliquid') {
    const position = POSITIONS.includes(entry.kind);
    if (position && !entry.asset.endsWith('-PERP')) return 'is a position that is not in a perp';
    if (entry.decimals !== (position ? PERP_DECIMALS : HYPERLIQUID_USDC.decimals)) return 'is not in the units the venue is booked in';
    const fill = entry.id.replace(/^hl:(fee|pnl):/, 'hl:fill:');
    if ((entry.kind === 'trade_fee' || entry.kind === 'realized_pnl') && (fill === entry.id || !ids.has(fill))) return 'belongs to no fill in the ledger';
  }

  if (entry.kind === 'change' && entry.amount !== 0n) return 'is change booked with an amount';
  if (INFLOWS.includes(entry.kind) && entry.amount < 0n) return `is a ${entry.kind} with a negative amount`;
  if (OUTFLOWS.includes(entry.kind) && entry.amount > 0n) return `is a ${entry.kind} with a positive amount`;
  return valueFault(entry);
}

/**
 * The form every entry has when the books wrote it: a kind its source
 * produces, the units of its chain, the sign of its direction, and a dollar
 * value that is its own amount at its own price. The other checks hold
 * entries against records; this one is what makes an entry's fields answer
 * for each other, so that an amount cannot be confirmed while the dollar
 * figure beside it says something else.
 */
export function checkEntries(ledger: readonly LedgerEntry[], out: Findings): void {
  const ids = new Set(ledger.map((entry) => entry.id));
  for (const entry of ledger) {
    const fault = faultOf(entry, ids);
    if (fault !== null) out.error('malformed_entry', `ledger entry ${entry.id} ${fault}`, entry.id);
  }
}
