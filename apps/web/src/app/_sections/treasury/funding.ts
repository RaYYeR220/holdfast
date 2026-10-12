import { looksTransparent, readZec } from './figures';

/**
 * Funding from the treasury, as far as the page decides anything: the form's
 * text read into what the server takes, and the figures a quote implies and
 * does not state. The quote itself, the deposit address and the payment
 * request are the server's.
 */

export type FundingPurpose = 'margin' | 'payout_float';

export interface FundingText {
  purpose: FundingPurpose;
  /** ZEC, as typed. */
  amount: string;
  /** A transparent Zcash address of the treasurer's. */
  refundTo: string;
  /** Slippage in basis points, as the value of the select. */
  slippageBps: string;
}

export interface FundingBody {
  purpose: FundingPurpose;
  amountZat: bigint;
  refundTo: string;
  slippageBps: number;
}

export type FundingErrors = Partial<Record<'purpose' | 'amount' | 'refundTo', string>>;

export type FundingReading = { ok: true; body: FundingBody } | { ok: false; errors: FundingErrors };

/** The slippage the form offers, in basis points; the server takes up to 500. */
export const SLIPPAGE_CHOICES = [50, 100, 200, 300] as const;
export const DEFAULT_SLIPPAGE_BPS = 100;

export function readFunding(text: FundingText, can: { payoutFloat: boolean }): FundingReading {
  const errors: FundingErrors = {};
  if (text.purpose === 'payout_float' && !can.payoutFloat) errors.purpose = 'The organisation has no Solana wallet yet, so there is nowhere to deliver a payout float. Connect one on the Payouts page first.';

  const amount = readZec(text.amount);
  if (!amount.ok) errors.amount = amount.error;

  const refundTo = text.refundTo.trim();
  if (refundTo === '') errors.refundTo = 'A refund address is needed: it is where the ZEC returns if the swap cannot complete.';
  else if (!looksTransparent(refundTo)) errors.refundTo = 'This is not a transparent Zcash address. The swap service returns ZEC to transparent addresses only; they start with t1 or t3.';

  const slippage = Number(text.slippageBps);
  const slippageBps = SLIPPAGE_CHOICES.includes(slippage as (typeof SLIPPAGE_CHOICES)[number]) ? slippage : DEFAULT_SLIPPAGE_BPS;

  if (!amount.ok || Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, body: { purpose: text.purpose, amountZat: amount.zat, refundTo, slippageBps } };
}

export interface QuoteInput {
  amountInUsd: number;
  amountOutUsd: number;
  costBps: number;
}

/** What the swap takes between the two legs, in dollars: the value paid in less the value delivered. */
export function quoteCostUsd(quote: QuoteInput): number {
  return Math.max(0, quote.amountInUsd - quote.amountOutUsd);
}
