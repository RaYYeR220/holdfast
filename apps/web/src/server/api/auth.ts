import { z } from 'zod';
import { clearedSessionCookie, sessionCookie } from '../auth/session';
import { issueNonce, signIn } from '../auth/sign-in';
import { hostOf, publicEndpoint, reply, sessionEndpoint } from '../http/endpoint';
import { listOrganisations } from '../orgs/service';

/** What a sign-in message says the signature is for. The wallet shows it; the service does not depend on it. */
const STATEMENT = 'Sign in to Holdfast. This proves you hold this address and moves no funds.';

/**
 * GET /api/auth/nonce: a challenge to put in an EIP-4361 message, with the
 * domain the message has to be written for.
 */
export const getNonce = publicEndpoint({}, async ({ deps, request, url }) => ({ ...(await issueNonce(deps)), domain: hostOf(request, url), version: '1', statement: STATEMENT }));

/**
 * POST /api/auth/verify { message, signature }: checks the signed message and
 * answers with the session cookie.
 */
export const postVerify = publicEndpoint(
  { body: z.strictObject({ message: z.string().min(1).max(4_000), signature: z.string().regex(/^0x[0-9a-fA-F]+$/).max(2_000) }) },
  async ({ deps, request, url, body }) => {
    const session = await signIn(deps, { message: body.message, signature: body.signature, host: hostOf(request, url) });
    return reply({ address: session.address, expiresAt: session.expiresAt }, { headers: { 'set-cookie': sessionCookie(session.token) } });
  },
);

/** POST /api/auth/logout: has the browser drop the session cookie. */
export const postLogout = publicEndpoint({}, async () => reply({ ok: true }, { headers: { 'set-cookie': clearedSessionCookie() } }));

/** GET /api/auth/me: who is signed in, and the organisations that address owns. */
export const getMe = sessionEndpoint({}, async ({ deps, session }) => ({
  address: session.address,
  expiresAt: session.expiresAt,
  orgs: await listOrganisations(deps, session.address),
}));
