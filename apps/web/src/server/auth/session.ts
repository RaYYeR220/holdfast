import { SignJWT, jwtVerify } from 'jose';

/**
 * The `__Host-` prefix makes the browser refuse the cookie unless it is
 * Secure, has Path=/ and names no Domain, so a sibling subdomain cannot plant
 * one.
 */
export const SESSION_COOKIE = '__Host-holdfast-session';
/** A session lasts a working day. Signing in again takes one signature. */
export const SESSION_TTL_SECONDS = 12 * 60 * 60;

const ALGORITHM = 'HS256';
const AUDIENCE = 'holdfast';
const ADDRESS = /^0x[0-9a-f]{40}$/;
const ATTRIBUTES = 'Path=/; HttpOnly; Secure; SameSite=Lax';

export interface Session {
  /** The address that signed in, in lower case. */
  address: `0x${string}`;
  expiresAt: number;
}

/** A signed statement that `address` signed in at `now`. Whoever holds it is that address until it expires. */
export async function issueSession(secret: Uint8Array, address: string, now: number): Promise<{ token: string; expiresAt: number }> {
  const subject = address.toLowerCase();
  if (!ADDRESS.test(subject)) throw new RangeError('a session is for an account address');
  const issuedAt = Math.floor(now / 1000);
  const expires = issuedAt + SESSION_TTL_SECONDS;
  const token = await new SignJWT({})
    .setProtectedHeader({ alg: ALGORITHM })
    .setSubject(subject)
    .setAudience(AUDIENCE)
    .setIssuedAt(issuedAt)
    .setExpirationTime(expires)
    .sign(secret);
  return { token, expiresAt: expires * 1000 };
}

/** The session a token stands for, or null when it was not signed with this secret, is not a session, or has expired. */
export async function readSession(secret: Uint8Array, token: string, now: number): Promise<Session | null> {
  try {
    const { payload } = await jwtVerify(token, secret, { algorithms: [ALGORITHM], audience: AUDIENCE, currentDate: new Date(now) });
    if (typeof payload.sub !== 'string' || !ADDRESS.test(payload.sub) || typeof payload.exp !== 'number') return null;
    return { address: payload.sub as `0x${string}`, expiresAt: payload.exp * 1000 };
  } catch {
    return null;
  }
}

export function sessionCookie(token: string): string {
  return `${SESSION_COOKIE}=${token}; Max-Age=${SESSION_TTL_SECONDS}; ${ATTRIBUTES}`;
}

export function clearedSessionCookie(): string {
  return `${SESSION_COOKIE}=; Max-Age=0; ${ATTRIBUTES}`;
}

/** The session token a request carries in its cookies, if it carries one. */
export function sessionTokenOf(request: Request): string | null {
  const header = request.headers.get('cookie');
  if (header === null) return null;
  for (const part of header.split(';')) {
    const at = part.indexOf('=');
    if (at > 0 && part.slice(0, at).trim() === SESSION_COOKIE) {
      const value = part.slice(at + 1).trim();
      return value === '' ? null : value;
    }
  }
  return null;
}
