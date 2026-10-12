import { type Address, getAddress } from 'viem';
import { createSiweMessage } from 'viem/siwe';
import { type Api, type Me, type SignInChallenge, api as defaultApi } from './api';
import { ClientError, isUnauthenticated } from './errors';
import type { EvmConnection } from './evm';

/**
 * Signing in. The server issues a challenge, the wallet signs an EIP-4361
 * message around it, and the server answers the signed message with a session
 * cookie that scripts cannot read. Who is signed in is therefore always asked
 * of the server (`readSession`), never remembered here.
 */

export interface SignInFields {
  /** The account that signs. */
  address: string;
  /** The chain the wallet is on. The server accepts any; the wallet shows it. */
  chainId: number;
  /** The origin of the page, such as `https://app.example`: the message names it as its URI. */
  origin: string;
  /** When the message is written. */
  issuedAt: Date;
}

/**
 * The EIP-4361 message for a challenge, exactly as the server will rebuild
 * it from its fields: the domain, version and statement the challenge came
 * with, the page's origin as URI, the wallet's address and chain, the nonce
 * and the time of writing. The server refuses a message that carries anything
 * else, so nothing else is put in.
 */
export function buildSignInMessage(challenge: SignInChallenge, fields: SignInFields): string {
  return createSiweMessage({
    address: getAddress(fields.address),
    chainId: fields.chainId,
    domain: challenge.domain,
    nonce: challenge.nonce,
    uri: fields.origin,
    version: challenge.version,
    statement: challenge.statement,
    // The server refuses a message dated further ahead of its own clock than a challenge lives. The expiry of the
    // challenge is never that far ahead, so a browser whose clock runs fast dates the message with that instead.
    issuedAt: new Date(Math.min(fields.issuedAt.getTime(), challenge.expiresAt)),
  });
}

export interface SignInOptions {
  api?: Api;
  /** The page's origin; `window.location.origin` unless given. */
  origin?: string;
  now?: () => number;
}

function pageOrigin(options: SignInOptions): string {
  if (options.origin !== undefined) return options.origin;
  if (typeof window === 'undefined') throw new ClientError('invalid_argument', 'signing in needs the origin of the page');
  return window.location.origin;
}

/**
 * Sign in with the account the wallet has selected: fetch a challenge, have
 * the wallet sign the message for it (`personal_sign`), hand message and
 * signature to the server, and read back who is signed in.
 *
 * The server signs in for one host. A page served from another could only
 * collect a signature the server will refuse, so that is settled before the
 * wallet is opened.
 */
export async function signIn(connection: EvmConnection, options: SignInOptions = {}): Promise<Me> {
  const api = options.api ?? defaultApi;
  const origin = pageOrigin(options);
  const { address } = connection.state();
  if (address === null) throw new ClientError('wallet_unavailable', `${connection.wallet.name} has no account selected`);
  const chainId = await connection.readChainId();

  const challenge = await api.nonce();
  const host = new URL(origin).host.toLowerCase();
  if (host !== challenge.domain.toLowerCase()) {
    throw new ClientError('wrong_site', `this page is served from ${host}, and the service signs in for ${challenge.domain}`);
  }

  const message = buildSignInMessage(challenge, { address, chainId, origin, issuedAt: new Date((options.now ?? Date.now)()) });
  const signature = await connection.signMessage(message, address);
  const opened = await api.verify({ message, signature });
  if (opened.address.toLowerCase() !== address.toLowerCase()) {
    throw new ClientError('bad_response', 'the server opened a session for another address than the one that signed');
  }
  return api.me();
}

/** Who is signed in, asked of the server; null when nobody is or the session has run out. */
export async function readSession(options: { api?: Api; signal?: AbortSignal } = {}): Promise<Me | null> {
  try {
    return await (options.api ?? defaultApi).me(options.signal === undefined ? {} : { signal: options.signal });
  } catch (error) {
    if (isUnauthenticated(error)) return null;
    throw error;
  }
}

/** Drop the session. The wallet stays connected: it is the cookie that is given up. */
export async function signOut(options: { api?: Api } = {}): Promise<void> {
  await (options.api ?? defaultApi).logout();
}

/** Whether a session is that of the account a wallet has selected. A wallet that moved to another account has left the session behind. */
export function sessionMatches(session: Pick<Me, 'address'> | null, address: Address | string | null): boolean {
  return session !== null && address !== null && session.address.toLowerCase() === address.toLowerCase();
}
