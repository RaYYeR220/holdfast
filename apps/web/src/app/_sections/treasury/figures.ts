import type { State } from '../../../ui/onebit/patterns';

/**
 * The Treasury page's own arithmetic and wording: amounts in base units as
 * text and back, what the rows of the page add up to, the treasury's own
 * payments beside their fees, and where a swap stands in words.
 */

const ZAT_PER_ZEC = 100_000_000n;
/** The whole ZEC supply, in zatoshi. */
const MAX_ZAT = 21_000_000n * ZAT_PER_ZEC;

function grouped(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * An amount in base units as a decimal: separators in the whole part, at
 * least `min` decimals, and no trailing zeros beyond them.
 */
export function formatUnits(value: bigint | string, decimals: number, min = 2): string {
  const amount = typeof value === 'string' ? BigInt(value) : value;
  const negative = amount < 0n;
  const abs = negative ? -amount : amount;
  const base = 10n ** BigInt(decimals);
  const fraction = decimals === 0 ? '' : (abs % base).toString().padStart(decimals, '0');
  const kept = fraction.replace(/0+$/, '').padEnd(Math.min(min, decimals), '0');
  return `${negative ? '−' : ''}${grouped((abs / base).toString())}${kept === '' ? '' : `.${kept}`}`;
}

/** Zatoshi as ZEC with every digit the amount has and none it has not. */
export function zecText(zat: bigint | string): string {
  return formatUnits(zat, 8, 0);
}

export type ZecReading = { ok: true; zat: bigint } | { ok: false; error: string };

/** An amount of ZEC as a treasurer types it, in zatoshi; or why it cannot be one. */
export function readZec(text: string): ZecReading {
  const written = text.trim().replace(',', '.');
  if (written === '') return { ok: false, error: 'An amount is needed.' };
  if (!/^\d+(\.\d+)?$/.test(written)) return { ok: false, error: 'Write the amount as a plain number of ZEC, such as 0.5.' };
  const [whole = '0', fraction = ''] = written.split('.');
  if (fraction.length > 8) return { ok: false, error: 'ZEC has eight decimals at most.' };
  const zat = BigInt(whole) * ZAT_PER_ZEC + BigInt(fraction.padEnd(8, '0'));
  if (zat <= 0n) return { ok: false, error: 'The amount has to be more than zero.' };
  if (zat > MAX_ZAT) return { ok: false, error: 'That is more ZEC than exists.' };
  return { ok: true, zat };
}

/** Whether a text has the shape of a transparent Zcash address, which is the only kind a swap refunds to. */
export function looksTransparent(address: string): boolean {
  return /^(t1|t3|tm|t2)[1-9A-HJ-NP-Za-km-z]{33}$/.test(address.trim());
}

export interface Totals {
  receivedZat: bigint;
  sentZat: bigint;
  feesZat: bigint;
}

/**
 * Whether the rows account for the balance: everything received, less what
 * was sent and the fees paid, is what the treasury holds. It does not when
 * the treasury holds notes whose spends a viewing key cannot follow, or when
 * the page shows only part of a long history.
 */
export function accountsFor(totals: Totals, balanceZat: bigint): boolean {
  return totals.receivedZat - totals.sentZat - totals.feesZat === balanceZat;
}

export interface SentInput {
  id: string;
  txid: string;
}

export interface FeeInput {
  txid: string;
  zat: bigint;
}

/**
 * The treasury's payments, each with the fee of its transaction. A
 * transaction that made several payments carries its fee on the first of
 * them; a fee whose transaction made no payment that is shown is returned
 * apart.
 */
export function withFees<S extends SentInput, F extends FeeInput>(sent: readonly S[], fees: readonly F[]): { rows: (S & { fee: F | null })[]; otherFees: F[] } {
  const byTx = new Map(fees.map((fee) => [fee.txid, fee]));
  const used = new Set<string>();
  const rows = sent.map((payment) => {
    const fee = used.has(payment.txid) ? undefined : byTx.get(payment.txid);
    if (fee !== undefined) used.add(payment.txid);
    return { ...payment, fee: fee ?? null };
  });
  return { rows, otherFees: fees.filter((fee) => !used.has(fee.txid)) };
}

export type SwapPurposeShown = 'margin' | 'payout_float' | string;

export interface PurposeWords {
  short: string;
  /** What arrives and where, as it reads after "into". */
  delivers: string;
  /** The chain the receiving transaction is on; null for a purpose this page does not know. */
  chain: 'hyperliquid' | 'solana' | null;
  /**
   * The decimals of the amounts the swap service states for what arrives.
   * HyperCore keeps USDC with eight, two more than USDC has on Solana. Null
   * for a purpose this page does not know.
   */
  decimals: number | null;
}

/** What a swap is for, as the page names it. */
export function purposeWords(purpose: SwapPurposeShown): PurposeWords {
  if (purpose === 'margin') return { short: 'Margin', delivers: 'USDC margin on the team’s Hyperliquid account', chain: 'hyperliquid', decimals: 8 };
  if (purpose === 'payout_float') return { short: 'Payout float', delivers: 'USDC on the team’s Solana wallet', chain: 'solana', decimals: 6 };
  return { short: purpose, delivers: 'dollars on an account of the team', chain: null, decimals: null };
}

/** An amount that arrives, in dollars of USDC; in base units, and said to be, when its decimals are not known. */
export function deliveredText(amount: bigint | string, purpose: Pick<PurposeWords, 'decimals'>): string {
  return purpose.decimals === null ? `${formatUnits(amount, 0, 0)} base units` : `${formatUnits(amount, purpose.decimals)} USDC`;
}

export interface SwapWords {
  /** The state in a word or two. */
  label: string;
  state: State;
  /** What is true now and what happens next. */
  text: string;
  /** How far along the three steps it is: nothing paid, deposit seen, delivered. Null for a swap that ended without delivering. */
  step: 0 | 1 | 2 | null;
}

/** Where a swap stands, from the state the swap service last reported. */
export function swapWords(state: string): SwapWords {
  switch (state) {
    case 'PENDING_DEPOSIT':
      return { label: 'Waiting for the deposit', state: 'limit', text: 'The swap service has not seen the payment yet. A deposit that arrives after the quote lapses is sent back, not swapped.', step: 0 };
    case 'PROCESSING':
      return { label: 'Swapping', state: 'unlocked', text: 'The swap service has the deposit and is delivering the dollars.', step: 1 };
    case 'SUCCESS':
      return { label: 'Delivered', state: 'locked', text: 'The dollars arrived on the team’s own account.', step: 2 };
    case 'INCOMPLETE_DEPOSIT':
      return { label: 'Deposit incomplete', state: 'limit', text: 'The swap service saw less than the quoted amount arrive. It waits for the rest until the quote lapses, then sends back what it holds.', step: 0 };
    case 'REFUNDED':
      return { label: 'Refunded', state: 'refused', text: 'The swap did not complete, and the ZEC was sent back to the refund address.', step: null };
    case 'FAILED':
      return { label: 'Failed', state: 'refused', text: 'The swap service reports the swap as failed.', step: null };
    default:
      return { label: state, state: 'stale', text: 'The swap service reported a state this page does not know.', step: null };
  }
}
