import type { SolanaRailShown, TempoRailShown } from '../../../server/pages/payouts';
import { tokenText } from './format';

/**
 * A rail as the form of a new run needs it: whether a run can be drafted on
 * it at all, what its key may pay at the moment in one sentence, and the two
 * bounds a draft is held against as it is typed.
 */
export interface RailForRuns {
  token: { symbol: string; decimals: number };
  /** Why a run cannot be drafted on this rail yet; null when one can. */
  blocked: string | null;
  /** What the rail's key may pay now, as its chain reports it. */
  standing: string;
  /** What is left to the key, in base units as decimal digits; null when the chain could not be read or the key may pay nothing. */
  remaining: string | null;
  /** Tempo: the recipients the access key lists; null when it lists none or is not authorized. */
  recipients: string[] | null;
}

/** A read of a rail as a page has it: the rail, or why it could not be read. */
type Read<T> = { status: 'ok'; value: T } | { status: 'unavailable'; reason: string };

const UNREAD = { symbol: 'the token', decimals: 6 };
const NO_ACCOUNT = 'The organisation has no Tempo account yet. Create it above: a run is drafted for the account it pays from.';
const NO_WALLET = 'The organisation has no Solana wallet yet. Connect and record it above: a run is drafted for the wallet it pays from.';
const LATER = 'A run can be drafted now and paid once';

/**
 * The server drafts a run for the account it pays from, so a rail without
 * one cannot take a draft. A key that may pay nothing is no reason not to
 * draft: the run waits until the key allows it.
 */
export function tempoForRuns(rail: Read<TempoRailShown>): RailForRuns {
  if (rail.status !== 'ok') return { token: UNREAD, blocked: `The Tempo rail could not be read: ${rail.reason}.`, standing: 'The rail could not be read.', remaining: null, recipients: null };
  const { key, token, account, accessKey } = rail.value;
  const base = { token: { symbol: token.symbol, decimals: token.decimals }, remaining: null, recipients: null };
  if (account === null) return { ...base, blocked: NO_ACCOUNT, standing: 'There is no Tempo account yet.' };
  if (accessKey === null) return { ...base, blocked: 'The organisation has no Tempo access key.', standing: 'There is no access key.' };
  switch (key.state) {
    case 'authorized': {
      const payees = key.recipients === null ? 'any address' : key.recipients.length === 1 ? 'the one address it lists' : `the ${key.recipients.length} addresses it lists`;
      return {
        ...base,
        blocked: null,
        standing: `The access key has ${tokenText(key.remaining, token)} left${key.periodEnd === null ? '' : ' in this period'} and may pay ${payees}.`,
        remaining: key.remaining.toString(),
        recipients: key.recipients,
      };
    }
    case 'unavailable':
      return { ...base, blocked: null, standing: `What the access key may pay could not be read from Tempo: ${key.reason}. A run can be drafted; whether it can be paid is checked when it is previewed.` };
    case 'not_authorized':
      return { ...base, blocked: null, standing: `The access key is not authorized on the account, so the chain would refuse any run. ${LATER} the key is authorized.` };
    case 'revoked':
      return { ...base, blocked: null, standing: `The access key was revoked, so the chain would refuse any run. ${LATER} a new key is authorized.` };
    case 'expired':
      return { ...base, blocked: null, standing: `The access key has expired, so the chain would refuse any run. ${LATER} a new key is authorized.` };
    case 'broader':
      return { ...base, blocked: null, standing: `The access key is not a bounded payout key, and the service does not pay with it. ${LATER} a bounded key is authorized.` };
    case 'no_account':
      return { ...base, blocked: NO_ACCOUNT, standing: 'There is no Tempo account yet.' };
  }
}

export function solanaForRuns(rail: Read<SolanaRailShown>): RailForRuns {
  if (rail.status !== 'ok') return { token: UNREAD, blocked: `The Solana rail could not be read: ${rail.reason}.`, standing: 'The rail could not be read.', remaining: null, recipients: null };
  const { allowance, token, owner, delegate } = rail.value;
  const base = { token: { symbol: token.symbol, decimals: token.decimals }, remaining: null, recipients: null };
  if (owner === null) return { ...base, blocked: NO_WALLET, standing: 'There is no Solana wallet yet.' };
  if (delegate === null) return { ...base, blocked: 'The organisation has no Solana service key.', standing: 'There is no service key.' };
  switch (allowance.state) {
    case 'approved':
      return { ...base, blocked: null, standing: `The delegate has ${tokenText(allowance.remaining, token)} of allowance left.`, remaining: allowance.remaining.toString() };
    case 'nothing':
      return { ...base, blocked: null, standing: `The delegate has no allowance, so the chain would refuse any run. ${LATER} an amount is approved.` };
    case 'unavailable':
      return { ...base, blocked: null, standing: `The allowance could not be read from Solana: ${allowance.reason}. A run can be drafted; whether it can be paid is checked when it is previewed.` };
    case 'no_wallet':
      return { ...base, blocked: NO_WALLET, standing: 'There is no Solana wallet yet.' };
  }
}
