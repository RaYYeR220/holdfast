/**
 * What went wrong with something the treasurer was asked to sign or the
 * server was asked to do, as the page states it: a refusal in the wallet, a
 * refusal by the server or by a venue, and a failure to reach either are
 * told apart, and the reason is always the wallet's, the client's or the
 * server's own.
 */

export interface Failed {
  /** The server's code or a code of this side: see `ClientError`. */
  code: string;
  message: string;
  /** The HTTP status of the server's refusal; null when the failure is this side's. */
  status: number | null;
}

export interface FailureShown {
  /** `refusal` for anything that was turned down; `warning` for anything that could not be done or checked. */
  kind: 'refusal' | 'warning';
  /** The word that names it in the notice. */
  word: string;
  title: string;
  /** The reason, as a sentence. */
  reason: string;
  /** What is true now and what the next step is. */
  next: string;
}

function sentence(text: string): string {
  const trimmed = text.trim();
  if (trimmed === '') return '';
  const capital = trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
  return /[.!?]$/.test(capital) ? capital : `${capital}.`;
}

/**
 * `doing` names what was attempted, as it reads after "Nothing was" or in a
 * title: "signing in", "the approval", "the quote". `nothing` says what is
 * true after a failure before anything was sent.
 */
export function failureShown(error: Failed, doing: { title: string; nothing: string }): FailureShown {
  const reason = sentence(error.message);
  switch (error.code) {
    case 'wallet_rejected':
      return { kind: 'refusal', word: 'Declined', title: `${doing.title} was declined in the wallet`, reason, next: `${doing.nothing} You can ask the wallet again.` };
    case 'wallet_unavailable':
      return { kind: 'warning', word: 'Warning', title: 'The wallet has nothing to sign with', reason, next: `${doing.nothing} Unlock the wallet, select the account and ask again.` };
    case 'wrong_account':
      return { kind: 'refusal', word: 'Refused', title: 'The wallet holds another account', reason, next: `${doing.nothing} Select the right account in the wallet and ask again.` };
    case 'wrong_site':
      return { kind: 'refusal', word: 'Refused', title: 'This page is served from another host', reason, next: `${doing.nothing} The wallet was not opened: a signature collected here would be refused by the server. Open the application at the address the service signs in for.` };
    case 'unexpected_request':
      return { kind: 'refusal', word: 'Refused', title: 'The request the server prepared was not what was asked for', reason, next: `${doing.nothing} The wallet was not opened.` };
    case 'nothing_to_sign':
      return { kind: 'warning', word: 'Warning', title: 'There is nothing to sign', reason, next: doing.nothing };
    case 'wallet_failed':
      return { kind: 'warning', word: 'Warning', title: 'The wallet failed', reason, next: `${doing.nothing} You can ask again.` };
    case 'network':
      return { kind: 'warning', word: 'Warning', title: 'The server could not be reached', reason, next: 'Whether the request arrived is not known. Reload the page to see what is true before asking again.' };
    case 'aborted':
      return { kind: 'warning', word: 'Warning', title: 'The request was given up', reason, next: 'Reload the page to see what is true before asking again.' };
    case 'sign_in_failed':
      return { kind: 'refusal', word: 'Refused', title: 'The server refused the sign-in', reason, next: 'You are not signed in. Each attempt uses a fresh challenge, so asking again is safe; a challenge waits ten minutes to be signed.' };
    case 'unauthenticated':
      return { kind: 'warning', word: 'Warning', title: 'The session has ended', reason, next: 'Sign in again on the Overview page, then repeat this.' };
    case 'invalid_input':
      return { kind: 'refusal', word: 'Refused', title: `The server refused ${doing.title.toLowerCase()}`, reason, next: doing.nothing };
    case 'refused':
      return { kind: 'refusal', word: 'Refused', title: `${doing.title} was refused`, reason, next: doing.nothing };
    case 'unavailable':
      return { kind: 'warning', word: 'Unavailable', title: 'A source could not be read', reason, next: `${doing.nothing} Nothing stands in for the missing answer; ask again when the source answers.` };
    case 'not_found':
      return { kind: 'warning', word: 'Warning', title: 'The server knows no such thing', reason, next: 'Either it does not exist or it is not this account’s. Reload the page.' };
    case 'bad_origin':
      return { kind: 'refusal', word: 'Refused', title: 'The server took the request for another site’s', reason, next: doing.nothing };
    default:
      return { kind: 'warning', word: 'Warning', title: `${doing.title} failed`, reason, next: error.status === null ? doing.nothing : `The server answered HTTP ${error.status}. ${doing.nothing}` };
  }
}
