/**
 * How the Payouts pages write amounts, periods, chains and the states of a
 * run. Plain functions with no locale and no clock of their own, so the
 * server and every browser produce the same text.
 */

export type PayoutChain = 'tempo' | 'solana';
export type RunStatus = 'draft' | 'approved' | 'sending' | 'paid' | 'failed' | 'refused';
/** The five fills of the design system; a run's status is shown as one of them and a word. */
export type Fill = 'locked' | 'unlocked' | 'refused' | 'limit' | 'stale';

const LAMPORTS_PER_SOL_DECIMALS = 9;

function grouped(whole: bigint): string {
  return whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * Base units as a decimal amount with thousands separators and at least
 * `least` decimals; further ones are shown only as far as they are not zero.
 * `formatUnits(1_250_000n, 6)` is `1.25`, `formatUnits(400_000n, 6)` is `0.40`.
 */
export function formatUnits(units: bigint, decimals: number, least = 2): string {
  const negative = units < 0n;
  const abs = negative ? -units : units;
  const scale = 10n ** BigInt(decimals);
  const kept = Math.min(least, decimals);
  let fraction = decimals === 0 ? '' : (abs % scale).toString().padStart(decimals, '0');
  while (fraction.length > kept && fraction.endsWith('0')) fraction = fraction.slice(0, -1);
  return `${negative ? '−' : ''}${grouped(abs / scale)}${fraction === '' ? '' : `.${fraction}`}`;
}

export interface TokenShown {
  symbol: string | null;
  decimals: number | null;
}

/**
 * An amount of a token as a figure and its unit. A run written before the
 * decimals were kept cannot be scaled, and is shown in base units as such.
 */
export function tokenAmount(units: bigint, token: TokenShown): { figure: string; unit: string } {
  if (token.decimals === null) return { figure: grouped(units), unit: token.symbol === null ? 'base units' : `base units of ${token.symbol}` };
  return { figure: formatUnits(units, token.decimals), unit: token.symbol ?? 'tokens' };
}

/** The same in one piece: `0.40 USDC`. */
export function tokenText(units: bigint, token: TokenShown): string {
  const { figure, unit } = tokenAmount(units, token);
  return `${figure} ${unit}`;
}

/** Lamports as SOL, with as many decimals as are not zero and at least four. */
export function formatSol(lamports: bigint): string {
  return formatUnits(lamports, LAMPORTS_PER_SOL_DECIMALS, 4);
}

export type ParsedAmount = { ok: true; units: bigint } | { ok: false; reason: string };

/**
 * A typed amount as base units. Only a plain decimal is taken: digits, and
 * at most as many after the point as the token has. Nothing is rounded.
 */
export function parseAmount(text: string, decimals: number): ParsedAmount {
  const trimmed = text.trim();
  if (trimmed === '') return { ok: false, reason: 'Enter an amount.' };
  const match = /^(\d{1,30})(?:\.(\d*))?$/.exec(trimmed);
  if (match === null) return { ok: false, reason: 'Write the amount as a plain number, such as 250 or 250.50.' };
  const fraction = match[2] ?? '';
  if (fraction.length > decimals) return { ok: false, reason: `The token has ${decimals} decimals; this amount has ${fraction.length}.` };
  const units = BigInt(match[1] ?? '0') * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0') || '0');
  if (units <= 0n) return { ok: false, reason: 'The amount has to be more than nothing.' };
  return { ok: true, units };
}

const DAY = 86_400;
const HOUR = 3_600;

function count(n: number, unit: string): string {
  return `${grouped(BigInt(n))} ${unit}${n === 1 ? '' : 's'}`;
}

/** A length of time in the largest unit that divides it: `30 days`, `12 hours`, `90 seconds`. */
export function durationWords(seconds: number): string {
  if (seconds % DAY === 0) return count(seconds / DAY, 'day');
  if (seconds % HOUR === 0) return count(seconds / HOUR, 'hour');
  if (seconds % 60 === 0) return count(seconds / 60, 'minute');
  return count(seconds, 'second');
}

/** How a spending limit is counted: once, or anew in every period. */
export function periodWords(periodSeconds: number): string {
  return periodSeconds === 0 ? 'once, with no refill' : `in every period of ${durationWords(periodSeconds)}`;
}

/** The chain a payout is on, with the network when it is not the main one. */
export function chainName(chain: PayoutChain, network: string): string {
  if (chain === 'tempo') return network === 'mainnet' ? 'Tempo' : `Tempo ${network === 'moderato' ? 'Moderato testnet' : network}`;
  return network === 'mainnet-beta' ? 'Solana' : `Solana ${network}`;
}

export const RAIL_NAME: Record<PayoutChain, string> = { tempo: 'Tempo', solana: 'Solana' };

interface RunStateShown {
  fill: Fill;
  word: string;
  /** What the status says about the money, in one sentence. */
  meaning: string;
}

/** A run's status as its fill, its word and what it means. */
export const RUN_STATE: Record<RunStatus, RunStateShown> = {
  draft: { fill: 'limit', word: 'Draft', meaning: 'Nothing has been sent for this run.' },
  approved: { fill: 'limit', word: 'Approved', meaning: 'Nothing has been sent for this run.' },
  sending: { fill: 'stale', word: 'Not settled', meaning: 'An attempt to pay this run was made and its outcome is not established. The run must not be treated as unpaid.' },
  paid: { fill: 'locked', word: 'Paid', meaning: 'The run is paid.' },
  failed: { fill: 'refused', word: 'Failed', meaning: 'A transaction was sent and paid nothing.' },
  refused: { fill: 'refused', word: 'Refused', meaning: 'Nothing was sent: the rail would not pay the run as things stood.' },
};

/** An address on its chain's explorer, from what the server says comes before and after it in the link. */
export function addressUrl(links: { before: string; after: string }, address: string): string {
  return `${links.before}${address}${links.after}`;
}

/** The path of a line's public receipt. */
export function receiptPath(token: string): string {
  return `/receipts/${token}`;
}

/**
 * How far ahead a moment lies, in the largest unit that fits and in the
 * abbreviations `formatAgo` uses for the past: "in 40 s", "in 12 min",
 * "in 5 h", "in 28 d". Null for a moment that is not ahead.
 */
export function formatAhead(ms: number, now: number): string | null {
  const seconds = Math.round((ms - now) / 1000);
  if (seconds <= 0) return null;
  if (seconds < 90) return `in ${seconds} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `in ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `in ${hours} h`;
  return `in ${Math.round(hours / 24)} d`;
}
