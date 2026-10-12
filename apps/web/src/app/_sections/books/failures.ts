import type { ClientError } from '@/client/errors';

/**
 * How a failed action is said on a page. The server's own message, or the
 * wallet's, is always shown; what is added is which kind of failure it was
 * and what it leaves the reader to do.
 */

export interface Failed {
  /** A refusal is something that will not be done as things stand; a warning is something that could not be done now. */
  kind: 'refusal' | 'warning';
  title: string;
  body: string;
  /** The whole of a message too long to read as a sentence, for whoever wants it; null when `body` already holds it all. */
  detail: string | null;
}

/** A message longer than this is a dump of a request, not a sentence: its first sentence is shown and the rest is kept behind it. */
const LONG = 220;

const capital = (text: string): string => (text === '' ? text : `${text[0]?.toUpperCase() ?? ''}${text.slice(1)}`);
const sentence = (text: string): string => (/[.!?]$/.test(text.trim()) ? capital(text.trim()) : `${capital(text.trim())}.`);

function problemsOf(error: ClientError): string {
  const { problems } = error.details;
  if (!Array.isArray(problems) || problems.length === 0) return '';
  return ` ${problems.filter((problem): problem is string => typeof problem === 'string').map(sentence).join(' ')}`;
}

/** What was said, as one sentence to show and, when it ran long, the whole of it to keep. */
function said(message: string): { short: string; detail: string | null } {
  const text = message.trim().replace(/\s+/g, ' ');
  if (text.length <= LONG) return { short: sentence(text), detail: null };
  // As many whole sentences as fit; failing that, as many whole words.
  const head = text.slice(0, LONG);
  const last = [...head.matchAll(/\.\s(?=[A-Z])/g)].at(-1)?.index;
  const first = last === undefined ? `${head.replace(/\s+\S*$/, '')} …` : head.slice(0, last);
  return { short: sentence(first), detail: text };
}

/**
 * The words for a failure. `reader` is who is acting: the owner of an
 * organisation, or the holder of an auditor link, for whom "not found" means
 * the link has stopped working.
 */
export function failureCopy(error: ClientError, reader: 'owner' | 'audit' = 'owner'): Failed {
  const { short, detail } = said(error.message);
  const answer = (kind: Failed['kind'], title: string, body: string, kept: string | null = detail): Failed => ({ kind, title, body, detail: kept });
  switch (error.code) {
    case 'wallet_rejected':
      return answer('refusal', 'Declined in the wallet', `${short} Nothing was signed and nothing was sent.`);
    case 'wrong_account':
      return answer('refusal', 'Another account is selected in the wallet', `${short} Nothing was sent.`);
    case 'unexpected_request':
      return answer('refusal', 'Stopped before the wallet was asked', short);
    case 'wallet_unavailable':
      return answer('warning', 'There is no wallet to sign with', short);
    case 'nothing_to_sign':
      return answer('warning', 'There is nothing to send', short);
    case 'wallet_failed':
      return answer('warning', 'The wallet did not send it', `${short} Nothing changed on chain.`);
    case 'not_confirmed':
      return answer('warning', 'Sent, and not shown by the chain yet', `${short} It may still arrive; nothing needs to be sent again.`);
    case 'network':
      return answer('warning', 'The server could not be reached', 'Whether the request arrived is not known. Look at the page again before repeating it.', null);
    case 'aborted':
      return answer('warning', 'Given up', short);
    default:
      break;
  }
  if (error.status === 401) return answer('warning', 'The session has run out', 'Sign in again on the first page of the application, then repeat this.', null);
  if (error.status === 404) {
    return reader === 'audit'
      ? answer('refusal', 'This link no longer opens anything', 'It was revoked or has expired since this page was opened.', null)
      : answer('refusal', 'Not found', 'The server knows nothing by that name that belongs to the signed-in account.', null);
  }
  if (error.code === 'refused') return answer('refusal', 'The server would not do it', short);
  if (error.code === 'unavailable') return answer('warning', 'It could not be done now', `${short} Nothing was changed.`);
  if (error.code === 'invalid_input') return answer('warning', 'The server did not accept what was sent', `${short}${problemsOf(error)}`);
  if (error.code === 'bad_origin') return answer('refusal', 'Refused: wrong origin', short);
  return answer('warning', 'It did not work', short);
}
