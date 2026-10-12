import { getAddress, isAddress } from 'viem';
import { base58Decode } from '../../../client/solana';
import { type PayoutChain, durationWords, formatUnits, parseAmount } from './format';

/**
 * What the owner's forms on the Payouts pages decide before anything is
 * sent, and how an answer of the server or a wallet is put into words.
 * Plain functions: the forms hold the text that was typed, these say what it
 * amounts to.
 */

/**
 * The most lines the server takes in one run, on either rail: a Tempo
 * transaction carries that many calls and no more. How many a Solana
 * transaction has room for depends on the run; the preview says.
 */
export const MAX_LINES = 32;
/** The most recipients an access key's authorization may list. */
export const MAX_RECIPIENTS = 25;
const MAX_NAME = 120;
const MAX_REFERENCE = 64;
const DAY = 86_400;
const SOLANA_KEY_BYTES = 32;

/** Whether a text is a Solana address: base58 for thirty-two bytes. */
export function isSolanaAddress(text: string): boolean {
  try {
    return base58Decode(text).length === SOLANA_KEY_BYTES;
  } catch {
    return false;
  }
}

/** Why a typed address cannot be a payee on a chain, or null when it can. A mixed-case Tempo address has to carry a correct checksum. */
export function addressProblem(chain: PayoutChain, text: string): string | null {
  if (text === '') return 'Enter the address to pay.';
  if (chain === 'solana') return isSolanaAddress(text) ? null : 'This is not a Solana address.';
  if (!/^0x[0-9a-fA-F]{40}$/.test(text)) return 'This is not a Tempo address: 0x and forty hexadecimal characters.';
  return isAddress(text) ? null : 'The capital letters of this address do not match its checksum. One character is probably mistyped.';
}

// The bounds of the Tempo access key.

export interface TermsDraft {
  /** The spending limit, as typed. */
  limit: string;
  /** The length of the spending window in days; 0 for a limit that is given once. */
  periodDays: number;
  /** How many days from now the key stops working. */
  expiryDays: number;
  /** Let the key pay any address. When false, it may pay the listed ones only. */
  anyRecipient: boolean;
  /** The addresses the key may pay, one to a line. */
  recipients: string;
}

export interface Terms {
  /** Token base units. */
  limit: bigint;
  periodSeconds: number;
  /** Unix seconds. */
  expiry: number;
  recipients?: string[];
}

export type TermsCheck = { ok: true; terms: Terms } | { ok: false; errors: { limit?: string; recipients?: string } };

/** The bounds a form describes, as the server takes them, or what is wrong with the form. `nowSeconds` is the moment the expiry is counted from. */
export function checkTerms(draft: TermsDraft, decimals: number, nowSeconds: number): TermsCheck {
  const errors: { limit?: string; recipients?: string } = {};
  const limit = parseAmount(draft.limit, decimals);
  if (!limit.ok) errors.limit = limit.reason;

  let recipients: string[] | undefined;
  if (!draft.anyRecipient) {
    const typed = draft.recipients
      .split(/[\s,;]+/)
      .map((entry) => entry.trim())
      .filter((entry) => entry !== '');
    const seen = new Set<string>();
    recipients = [];
    for (const entry of typed) {
      const problem = addressProblem('tempo', entry);
      if (problem !== null) {
        errors.recipients = `"${entry.length > 48 ? `${entry.slice(0, 48)}…` : entry}": ${problem}`;
        break;
      }
      if (seen.has(entry.toLowerCase())) {
        errors.recipients = `${entry} is listed twice.`;
        break;
      }
      seen.add(entry.toLowerCase());
      recipients.push(getAddress(entry));
    }
    if (errors.recipients === undefined && recipients.length === 0) errors.recipients = 'List at least one address the key may pay, or allow any recipient.';
    if (errors.recipients === undefined && recipients.length > MAX_RECIPIENTS) errors.recipients = `A key lists at most ${MAX_RECIPIENTS} recipients; this list has ${recipients.length}.`;
  }

  if (!limit.ok || errors.recipients !== undefined) return { ok: false, errors };
  return {
    ok: true,
    terms: { limit: limit.units, periodSeconds: draft.periodDays * DAY, expiry: nowSeconds + draft.expiryDays * DAY, ...(recipients === undefined ? {} : { recipients }) },
  };
}

/** The limit of a set of bounds in words: "250.00 USDC in every period of 30 days". */
export function limitWords(terms: Pick<Terms, 'limit' | 'periodSeconds'>, token: { symbol: string; decimals: number }): string {
  const amount = `${formatUnits(terms.limit, token.decimals)} ${token.symbol}`;
  return terms.periodSeconds === 0 ? `${amount}, once, with no refill` : `${amount} in every period of ${durationWords(terms.periodSeconds)}`;
}

// The lines of a new run.

export interface LineDraft {
  name: string;
  address: string;
  amount: string;
  reference: string;
}

export const EMPTY_LINE: LineDraft = { name: '', address: '', amount: '', reference: '' };

export interface RunContext {
  chain: PayoutChain;
  decimals: number;
  symbol: string;
  /** What the rail's key may still pay, in base units; null when its chain could not be read or the key may pay nothing. */
  remaining: bigint | null;
  /** Tempo: the recipients the access key lists; null when it lists none, or is not authorized. */
  recipients: readonly string[] | null;
}

export interface LineCheck {
  name?: string;
  address?: string;
  amount?: string;
  reference?: string;
  /** The amount in base units when it could be read. */
  units: bigint | null;
}

export interface RunCheck {
  lines: LineCheck[];
  /** The sum of the amounts that could be read. */
  total: bigint;
  /** What the key's chain would refuse as the key stands now. The run can be drafted all the same; it cannot be paid until this changes. */
  warnings: string[];
  /** Why the run cannot be drafted as a whole. */
  problem: string | null;
  /** The lines as the API takes them; null while anything above stands in the way of drafting. */
  payload: { payee: { name: string; address: string }; amount: bigint; reference: string }[] | null;
}

function referenceProblem(reference: string): string | null {
  if (reference.length > MAX_REFERENCE) return `A reference has at most ${MAX_REFERENCE} characters; this one has ${reference.length}.`;
  if (!/^[\x20-\x7e]*$/.test(reference)) return 'A reference goes on chain as it is written: plain letters, digits and punctuation only.';
  if (reference !== reference.trim()) return 'A reference must not start or end with a space.';
  return null;
}

/**
 * The lines of a run held to what the server accepts, and to what the key of
 * the chosen rail may pay at the moment. The first is a reason not to draft
 * the run; the second is said at once and leaves the drafting open.
 */
export function checkRun(lines: readonly LineDraft[], context: RunContext): RunCheck {
  const { chain, decimals, symbol } = context;
  const references = new Set<string>();
  let total = 0n;

  const checked = lines.map((line): LineCheck => {
    const check: LineCheck = { units: null };
    const name = line.name.trim();
    if (name === '') check.name = 'Enter the name of the payee.';
    else if (name.length > MAX_NAME) check.name = `A name has at most ${MAX_NAME} characters.`;

    const address = addressProblem(chain, line.address.trim());
    if (address !== null) check.address = address;

    const amount = parseAmount(line.amount, decimals);
    if (amount.ok) {
      check.units = amount.units;
      total += amount.units;
    } else check.amount = amount.reason;

    const reference = referenceProblem(line.reference);
    if (reference !== null) check.reference = reference;
    // On Solana the reference is the line's memo on chain, and a memo is how a line is found again.
    else if (chain === 'solana' && line.reference !== '' && references.has(line.reference)) check.reference = 'An earlier line has this reference. On Solana each reference of a run has to be its own.';
    references.add(line.reference);
    return check;
  });

  const warnings: string[] = [];
  if (chain === 'tempo' && context.recipients !== null) {
    const listed = new Set(context.recipients.map((recipient) => recipient.toLowerCase()));
    lines.forEach((line, index) => {
      const address = line.address.trim();
      if (checked[index]?.address === undefined && !listed.has(address.toLowerCase())) {
        warnings.push(`Line ${index + 1}: ${address} is not among the recipients the access key lists. The chain would refuse the whole run.`);
      }
    });
  }
  if (context.remaining !== null && total > context.remaining) {
    const left = `${formatUnits(context.remaining, decimals)} ${symbol}`;
    warnings.push(
      chain === 'tempo'
        ? `The run totals ${formatUnits(total, decimals)} ${symbol}; the access key has ${left} left in this period. The chain would refuse the whole run.`
        : `The run totals ${formatUnits(total, decimals)} ${symbol}; the delegate has ${left} of allowance left. The chain would refuse the whole run.`,
    );
  }

  const problem = lines.length === 0 ? 'A run has at least one line.' : lines.length > MAX_LINES ? `A run carries at most ${MAX_LINES} lines; this one has ${lines.length}.` : null;
  const clean = problem === null && checked.every((check) => check.name === undefined && check.address === undefined && check.amount === undefined && check.reference === undefined);
  return {
    lines: checked,
    total,
    warnings,
    problem,
    payload: clean
      ? lines.map((line, index) => ({
          payee: { name: line.name.trim(), address: chain === 'tempo' ? getAddress(line.address.trim()) : line.address.trim() },
          amount: checked[index]?.units ?? 0n,
          reference: line.reference,
        }))
      : null,
  };
}

// What executing a run leaves of a limit.

/** What is left of a limit after a run is paid from it; null when the limit is not known or does not cover the run. */
export function leftAfter(remaining: bigint | null, total: bigint): bigint | null {
  return remaining === null || total > remaining ? null : remaining - total;
}

export interface SolanaCost {
  newTokenAccounts: number;
  rentLamports: bigint;
  markerLamports: bigint;
  feeLamports: bigint;
}

/** Everything a Solana run takes out of the service key's SOL, in lamports. */
export function solanaCostTotal(cost: SolanaCost): bigint {
  return cost.rentLamports + cost.markerLamports + cost.feeLamports;
}

// Answers, in words.

export interface Told {
  /** `done` for what went through, `info` for the product answering as it should, `warning` for what is not settled, `refusal` for what was turned down. */
  kind: 'done' | 'info' | 'warning' | 'refusal';
  /** One or two words that name the answer. */
  word: string;
  title: string;
  /** Sentences, each a paragraph. */
  body: string[];
}

/** A reason as a chain, a rail or the server worded it, written as a sentence: a capital first, a full stop last. */
export function sentence(text: string): string {
  const trimmed = text.trim();
  if (trimmed === '') return '';
  const capital = trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
  return /[.!?]$/.test(capital) ? capital : `${capital}.`;
}

export interface Failure {
  code: string;
  message: string;
  status: number | null;
  details?: Readonly<Record<string, unknown>>;
}

/** A failed step as the page says it: who turned it down, the reason as it was given, and what did and did not happen. */
export function failureTold(error: Failure): Told {
  const reason = sentence(error.message);
  const problems = Array.isArray(error.details?.problems) ? (error.details.problems as unknown[]).filter((p): p is string => typeof p === 'string').map(sentence) : [];
  switch (error.code) {
    case 'wallet_rejected':
      return { kind: 'warning', word: 'Declined', title: 'You declined', body: [reason, 'Nothing was signed and nothing was sent. Nothing has changed.'] };
    case 'wallet_unavailable':
      return { kind: 'warning', word: 'No signer', title: 'There is nothing to sign with here', body: [reason] };
    case 'wallet_failed':
      return { kind: 'refusal', word: 'Failed', title: 'The wallet did not complete it', body: [reason] };
    case 'wrong_account':
      return { kind: 'warning', word: 'Wrong account', title: 'The signer is not the account this needs', body: [reason, 'Nothing was signed.'] };
    case 'unexpected_request':
      return { kind: 'refusal', word: 'Stopped', title: 'What the server prepared was not what was asked', body: [reason, 'The page checks what it is given to sign against what you entered, and it did not match.'] };
    case 'nothing_to_sign':
      return { kind: 'warning', word: 'Nothing to sign', title: 'There is nothing to sign as things stand', body: [reason] };
    case 'not_confirmed':
      return { kind: 'warning', word: 'Not confirmed', title: 'The chain does not show the change yet', body: [reason, 'This does not mean the transaction failed: it may still arrive. Read the chain again in a moment.'] };
    case 'invalid_argument':
      return { kind: 'refusal', word: 'Not usable', title: 'A value cannot be used', body: [reason] };
    case 'network':
    case 'aborted':
    case 'bad_response':
      return { kind: 'warning', word: 'No answer', title: 'The server did not answer', body: [reason, 'Whether the request reached the server is not known. Read the page again before trying once more.'] };
    case 'unauthenticated':
      return { kind: 'warning', word: 'Signed out', title: 'Your session has ended', body: ['Sign in again with the wallet of the team’s Hyperliquid account, then come back to this page.'] };
    case 'refused':
      return { kind: 'refusal', word: 'Refused', title: 'The server would not do this as things stand', body: [reason, ...problems] };
    case 'invalid_input':
      return { kind: 'refusal', word: 'Not accepted', title: 'The server did not accept what was sent', body: [reason, ...problems] };
    case 'unavailable':
      return { kind: 'warning', word: 'Unavailable', title: 'A source could not be read', body: [reason, 'Nothing was changed.'] };
    case 'not_found':
      return { kind: 'warning', word: 'Not found', title: 'There is no such thing for this organisation', body: [reason] };
    default:
      return { kind: 'warning', word: 'Failed', title: 'The server could not complete the request', body: [reason] };
  }
}

export interface ExecutionSeen {
  outcome: 'paid' | 'refused' | 'failed' | 'unsettled' | 'not_sent';
  replayed: boolean;
  error: string | null;
  chain: PayoutChain;
  /** Whether the answer names a transaction. */
  hasTx: boolean;
}

/** How an attempt to pay a run ended, as the page says it. */
export function executionTold(seen: ExecutionSeen): Told {
  const why = seen.error === null ? [] : [sentence(seen.error)];
  const repeat =
    seen.chain === 'tempo'
      ? 'Asking again is safe: the rail looks the run up on Tempo before it sends anything, and answers with the payment it finds.'
      : 'Asking again is safe: Solana accepts one payout for a run id, whoever sends the second, and the rail looks the run up before it sends.';
  switch (seen.outcome) {
    case 'paid':
      return seen.replayed
        ? { kind: 'info', word: 'Already paid', title: 'This run was already paid; nothing was sent', body: ['The answer is the transaction that paid it the first time. A run is paid once, however often it is executed.'] }
        : { kind: 'done', word: 'Paid', title: 'The run is paid', body: ['One transaction paid every line. Each line now has a receipt to send to its payee.'] };
    case 'refused':
      return { kind: 'refusal', word: 'Refused', title: 'Nothing was sent', body: [...why, 'The run is unpaid and can be executed again once what stands in the way is gone.'] };
    case 'failed':
      return { kind: 'refusal', word: 'Failed', title: 'A transaction was sent and paid nothing', body: [...why, 'The chain included it and undid it as a whole: no line was paid.'] };
    case 'not_sent':
      return { kind: 'warning', word: 'Not sent', title: 'Nothing was sent, for a reason that passes', body: [...why, 'The run is as it was. Execute it again in a moment.'] };
    case 'unsettled':
      return {
        kind: 'warning',
        word: 'Not settled',
        title: 'Whether the run is paid is not established',
        body: [
          ...why,
          seen.hasTx ? 'A transaction for this run was signed, and its fate has not been read from the chain.' : 'No transaction is named in the answer.',
          `Do not treat the run as unpaid, and do not pay it by hand. ${repeat}`,
        ],
      };
  }
}
