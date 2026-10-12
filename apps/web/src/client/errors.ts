/**
 * The one error this side of the application throws.
 *
 * A refusal by the server carries the HTTP status and the server's own `code`
 * and `message`, with whatever else its answer held in `details`. A failure
 * on this side has no status and one of the codes in `LocalErrorCode`.
 */
export type LocalErrorCode =
  /** The request did not reach the server, or its answer did not arrive. */
  | 'network'
  /** The caller gave up on the request. */
  | 'aborted'
  /** The answer was not one the API sends. */
  | 'bad_response'
  /** There is nothing to sign with: no wallet, no account in it, or a wallet that lacks what the step needs. */
  | 'wallet_unavailable'
  /** The treasurer declined in the wallet. */
  | 'wallet_rejected'
  /** The wallet failed for a reason of its own. */
  | 'wallet_failed'
  /** The wallet holds another account than the one that has to sign. */
  | 'wrong_account'
  /** The page is served from another host than the one the service signs in for. */
  | 'wrong_site'
  /** What the server asked to have signed is not what was asked of it. Nothing was signed. */
  | 'unexpected_request'
  /** The server offers nothing to sign for this step as things stand. */
  | 'nothing_to_sign'
  /** A value given to a function of this side cannot be used. */
  | 'invalid_argument'
  /** The chain did not show the change within the time allowed. It may still arrive. */
  | 'not_confirmed';

export class ClientError extends Error {
  /** The server's code (`unauthenticated`, `not_found`, `invalid_input`, `refused`, `unavailable`, …) or a `LocalErrorCode`. */
  readonly code: string;
  /** The HTTP status of the server's refusal; null when the failure is this side's. */
  readonly status: number | null;
  /** Further fields of the server's answer, such as `problems` or `source`. */
  readonly details: Readonly<Record<string, unknown>>;

  constructor(code: string, message: string, options: { status?: number | null; details?: Record<string, unknown>; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ClientError';
    this.code = code;
    this.status = options.status ?? null;
    this.details = options.details ?? {};
  }
}

export function isClientError(error: unknown): error is ClientError {
  return error instanceof ClientError;
}

/** Nobody is signed in, or the session has run out: sign in and ask again. */
export function isUnauthenticated(error: unknown): boolean {
  return isClientError(error) && error.status === 401;
}

/** There is no such thing, or it is not the caller's: the server gives one answer for both. */
export function isNotFound(error: unknown): boolean {
  return isClientError(error) && error.status === 404;
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'object' && error !== null && typeof (error as { message?: unknown }).message === 'string') return (error as { message: string }).message;
  return String(error);
}

/** Whatever was thrown, as a `ClientError`; one that already is stays as it is. */
export function toClientError(error: unknown, code: LocalErrorCode = 'wallet_failed'): ClientError {
  if (isClientError(error)) return error;
  return new ClientError(code, messageOf(error), { cause: error });
}

const DECLINED_CODES: readonly unknown[] = [4001, 'ACTION_REJECTED'];
const DECLINED_NAMES: readonly string[] = ['UserRejectedRequestError', 'NotAllowedError', 'AbortError'];
const DECLINED_WORDS = /\buser (rejected|denied|declined|cancell?ed)\b/i;

/**
 * Whether the treasurer said no. Wallets report it as EIP-1193 code 4001, a
 * passkey prompt as `NotAllowedError`, and libraries wrap either in errors of
 * their own, so the causes are looked through as well.
 */
function declined(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 6 && typeof current === 'object' && current !== null; depth += 1) {
    const { code, name, message, cause } = current as { code?: unknown; name?: unknown; message?: unknown; cause?: unknown };
    if (DECLINED_CODES.includes(code)) return true;
    if (typeof name === 'string' && DECLINED_NAMES.includes(name)) return true;
    if (typeof message === 'string' && DECLINED_WORDS.test(message)) return true;
    current = cause;
  }
  return false;
}

/** What a wallet or a passkey prompt threw, as `wallet_rejected` when the treasurer declined and `wallet_failed` otherwise. */
export function walletError(error: unknown, doing: string): ClientError {
  if (isClientError(error)) return error;
  if (declined(error)) return new ClientError('wallet_rejected', `${doing} was declined in the wallet`, { cause: error });
  return new ClientError('wallet_failed', `${doing} failed in the wallet: ${messageOf(error)}`, { cause: error });
}
