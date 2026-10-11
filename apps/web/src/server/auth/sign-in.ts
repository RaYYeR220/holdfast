import { randomBytes } from 'node:crypto';
import { type Hex, verifyMessage } from 'viem';
import { createSiweMessage, parseSiweMessage, validateSiweMessage } from 'viem/siwe';
import type { Deps } from '../deps';
import { ApiError } from '../errors';
import { issueSession } from './session';

/** How long a challenge waits to be signed. */
export const NONCE_TTL_MS = 10 * 60_000;
const NONCE_BYTES = 16;

const failed = (why: string) => new ApiError(401, 'sign_in_failed', `sign-in failed: ${why}`);

/** A fresh challenge for a sign-in message. It is stored, expires, and can be used once. */
export async function issueNonce(deps: Pick<Deps, 'store'>): Promise<{ nonce: string; expiresAt: number }> {
  const nonce = randomBytes(NONCE_BYTES).toString('hex');
  return { nonce, expiresAt: await deps.store.issueNonce(nonce, NONCE_TTL_MS) };
}

function hostOf(uri: string): string | null {
  try {
    return new URL(uri).host;
  } catch {
    return null;
  }
}

export interface SignInInput {
  /** The EIP-4361 message, exactly as the wallet signed it. */
  message: string;
  signature: string;
  /** The host the request was made to: the message must have been written for it. */
  host: string;
}

/**
 * Check a signed EIP-4361 message and open a session for the address in it.
 *
 * The message has to be a well-formed one and nothing else, written for this
 * host, inside its own validity window, carrying a challenge this service
 * issued and nobody used, and signed by the key of the address it names. The
 * challenge is used up only once everything else holds, so a bad signature
 * does not burn it.
 */
export async function signIn(deps: Pick<Deps, 'store' | 'now' | 'secrets'>, input: SignInInput): Promise<{ address: `0x${string}`; token: string; expiresAt: number }> {
  const fields = parseSiweMessage(input.message);
  const { address, nonce, domain, uri, version, chainId, issuedAt } = fields;
  if (address === undefined || nonce === undefined || domain === undefined || uri === undefined || version !== '1' || chainId === undefined || issuedAt === undefined) {
    throw failed('the message is not a complete sign-in message');
  }

  // What was signed must be the message these fields make and not a word more.
  let canonical: string;
  try {
    canonical = createSiweMessage({ ...fields, address, nonce, domain, uri, version, chainId, issuedAt });
  } catch {
    throw failed('the message is not a well-formed sign-in message');
  }
  if (canonical !== input.message) throw failed('the message is not a well-formed sign-in message');

  const now = deps.now();
  if (!validateSiweMessage({ message: fields, domain: input.host, time: new Date(now) })) {
    throw failed('the message was written for another site or is outside the time it is valid for');
  }
  if (hostOf(uri) !== input.host) throw failed('the message names another site as its URI');
  if (issuedAt.getTime() > now + NONCE_TTL_MS) throw failed('the message is dated in the future');

  let signed: boolean;
  try {
    signed = await verifyMessage({ address, message: input.message, signature: input.signature as Hex });
  } catch {
    signed = false;
  }
  if (!signed) throw failed('the signature is not that of the address in the message');

  if (!(await deps.store.consumeNonce(nonce))) throw failed('the nonce is unknown, has expired or was used before');

  const session = await issueSession(deps.secrets.session, address, now);
  return { address: address.toLowerCase() as `0x${string}`, ...session };
}
