import { createHash, timingSafeEqual } from 'node:crypto';
import type { OrgRecord } from '@holdfast/db';
import { z } from 'zod';
import { type Session, readSession, sessionTokenOf } from '../auth/session';
import type { Deps } from '../deps';
import { ApiError, ConfigError, badOrigin, invalid, notFound, unauthenticated } from '../errors';
import { toWire } from '../json';
import { messageOf } from '../redact';

/**
 * One operation of the API as a plain function: a request, the route's path
 * parameters and the dependencies in, a response out. The route files bind
 * these to the real dependencies; tests call them with fakes.
 */
export type Endpoint = (request: Request, params: unknown, deps: Deps) => Promise<Response>;

type Schema = z.ZodType;
const NOTHING = z.strictObject({});
type Nothing = typeof NOTHING;

export interface Shape<P extends Schema, B extends Schema, Q extends Schema> {
  /** The path parameters. One that does not fit names nothing, so the answer is "not found". */
  params?: P;
  /** The JSON body of a state-changing request. Unknown fields are refused unless the schema allows them. */
  body?: B;
  query?: Q;
}

export interface Context<P extends Schema, B extends Schema, Q extends Schema> {
  request: Request;
  url: URL;
  deps: Deps;
  params: z.infer<P>;
  body: z.infer<B>;
  query: z.infer<Q>;
}

const MAX_BODY_CHARACTERS = 256 * 1024;
const JSON_TYPE = /^application\/json\s*(;|$)/i;

/** A JSON response. Nothing the API answers may be kept by a cache. */
export function reply(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(toWire(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...init.headers },
  });
}

/**
 * The host the application answers as. It is the configured one: the Host
 * header is written by whoever sent the request, so a sign-in message or an
 * Origin is never compared with it where a host is configured.
 */
export function hostOf(request: Request, url: URL, deps: Pick<Deps, 'publicHost'>): string {
  return deps.publicHost ?? (request.headers.get('host') ?? url.host).toLowerCase();
}

/**
 * A state-changing request has to come from a page of the application
 * itself: its Origin must name the host the application is served on. A request
 * without an Origin is not one a browser made on a user's behalf through this
 * application, and is refused as well.
 */
function requireSameOrigin(request: Request, url: URL, deps: Deps): void {
  const origin = request.headers.get('origin');
  if (origin === null) throw badOrigin();
  let originHost: string;
  try {
    originHost = new URL(origin).host.toLowerCase();
  } catch {
    throw badOrigin();
  }
  if (originHost === '' || originHost !== hostOf(request, url, deps)) throw badOrigin();
}

async function jsonBody(request: Request): Promise<unknown> {
  if (!JSON_TYPE.test(request.headers.get('content-type') ?? '')) {
    throw new ApiError(415, 'unsupported_media_type', 'send the request body as application/json');
  }
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > MAX_BODY_CHARACTERS) throw new ApiError(413, 'too_large', 'the request body is too large');
  const text = await request.text();
  if (text.length > MAX_BODY_CHARACTERS) throw new ApiError(413, 'too_large', 'the request body is too large');
  if (text.trim() === '') return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw invalid('the request body is not valid JSON');
  }
}

function parse<S extends Schema>(schema: S, value: unknown, what: string): z.infer<S> {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  // Where the value is wrong and why; never the value itself.
  const problems = result.error.issues.map((issue) => `${[what, ...issue.path.map(String)].join('.')}: ${issue.message}`);
  throw invalid(`the ${what} is not valid`, problems);
}

function isDatabaseFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = String((error as { code?: unknown }).code ?? '');
  return error.name === 'DrizzleQueryError' || error.name === 'PostgresError' || /^(ECONN|ETIMEDOUT|ENOTFOUND|CONNECT_TIMEOUT|CONNECTION_)/.test(code);
}

function errorResponse(error: unknown, deps: Deps): Response {
  if (error instanceof ApiError) return reply({ error: error.code, message: error.message, ...error.details }, { status: error.status });
  if (error instanceof ConfigError) {
    deps.report(`configuration: ${error.message}`);
    return reply({ error: 'misconfigured', message: error.message }, { status: 500 });
  }
  deps.report(deps.redact(error instanceof Error ? (error.stack ?? error.message) : messageOf(error)));
  if (isDatabaseFailure(error)) {
    return reply({ error: 'unavailable', message: 'the database is unavailable', source: 'database' }, { status: 503 });
  }
  return reply({ error: 'internal', message: 'the server could not complete the request' }, { status: 500 });
}

interface Guard {
  /** Whether the request must come from the application's own pages when it changes state. */
  sameOrigin: boolean;
  /** Runs before any input is looked at; what it returns is handed to the operation. */
  admit(request: Request, deps: Deps): Promise<unknown>;
}

function build<P extends Schema, B extends Schema, Q extends Schema, A, C>(
  shape: Shape<P, B, Q>,
  guard: Guard,
  prepare: (admitted: unknown, context: Context<P, B, Q>) => Promise<A>,
  run: (context: Context<P, B, Q> & A) => Promise<C>,
): Endpoint {
  return async (request, rawParams, deps) => {
    try {
      const url = new URL(request.url);
      const changesState = request.method !== 'GET' && request.method !== 'HEAD';
      if (changesState && guard.sameOrigin) requireSameOrigin(request, url, deps);
      const admitted = await guard.admit(request, deps);

      let params: unknown = {};
      if (shape.params !== undefined) {
        const parsed = shape.params.safeParse(rawParams);
        if (!parsed.success) throw notFound();
        params = parsed.data;
      }
      const context = { request, url, deps, params, body: undefined, query: undefined } as Context<P, B, Q>;
      const extra = await prepare(admitted, context);

      context.query = parse(shape.query ?? NOTHING, Object.fromEntries(url.searchParams), 'query') as z.infer<Q>;
      if (changesState) context.body = parse(shape.body ?? NOTHING, await jsonBody(request), 'body') as z.infer<B>;

      const result = await run({ ...context, ...extra });
      return result instanceof Response ? result : reply(result);
    } catch (error) {
      return errorResponse(error, deps);
    }
  };
}

const OPEN: Guard = { sameOrigin: true, admit: async () => undefined };

async function sessionOf(request: Request, deps: Deps): Promise<Session> {
  const token = sessionTokenOf(request);
  const session = token === null ? null : await readSession(deps.secrets.session, token, deps.now());
  if (session === null) throw unauthenticated();
  return session;
}

const SIGNED_IN: Guard = { sameOrigin: true, admit: sessionOf };

/** An operation anyone may call. It still refuses a state-changing request from another origin. */
export function publicEndpoint<P extends Schema = Nothing, B extends Schema = Nothing, Q extends Schema = Nothing>(
  shape: Shape<P, B, Q>,
  run: (context: Context<P, B, Q>) => Promise<unknown>,
): Endpoint {
  return build(shape, OPEN, async () => ({}), run);
}

/** An operation for whoever is signed in. */
export function sessionEndpoint<P extends Schema = Nothing, B extends Schema = Nothing, Q extends Schema = Nothing>(
  shape: Shape<P, B, Q>,
  run: (context: Context<P, B, Q> & { session: Session }) => Promise<unknown>,
): Endpoint {
  return build(shape, SIGNED_IN, async (session) => ({ session: session as Session }), run);
}

/** Organisation ids are whatever they were created with; this only keeps out what could not be one. */
export const orgId = z.string().regex(/^[\w.-]{1,128}$/);

/** Whether an address that signed in is the one that owns an organisation. Both are hex, compared without case. */
export function owns(session: Session, org: Pick<OrgRecord, 'hlUser'>): boolean {
  return org.hlUser.toLowerCase() === session.address.toLowerCase();
}

/**
 * An operation on one organisation, for its owner only: the signed-in address
 * has to be the organisation's Hyperliquid account. An organisation the
 * caller does not own gets the answer one that does not exist gets, and it
 * gets it before any other input is examined.
 */
export function ownerEndpoint<P extends z.ZodType<{ orgId: string }>, B extends Schema = Nothing, Q extends Schema = Nothing>(
  shape: Shape<P, B, Q> & { params: P },
  run: (context: Context<P, B, Q> & { session: Session; org: OrgRecord }) => Promise<unknown>,
): Endpoint {
  return build(
    shape,
    SIGNED_IN,
    async (admitted, context) => {
      const session = admitted as Session;
      const org = await context.deps.store.findOrg((context.params as { orgId: string }).orgId);
      if (org === null || !owns(session, org)) throw notFound();
      return { session, org };
    },
    run,
  );
}

/** Compare two secrets without the time taken saying where they first differ, or how long either is. */
export function sameSecret(a: string, b: string): boolean {
  const digest = (text: string) => createHash('sha256').update(text, 'utf8').digest();
  return timingSafeEqual(digest(a), digest(b));
}

/**
 * An operation for the scheduler: it presents the tick secret as a bearer
 * token. It carries no cookie and is not called from a page, so no origin is
 * asked of it.
 */
export function scheduledEndpoint(run: (context: { request: Request; deps: Deps }) => Promise<unknown>): Endpoint {
  const guard: Guard = {
    sameOrigin: false,
    async admit(request, deps) {
      const header = request.headers.get('authorization') ?? '';
      const presented = /^Bearer (.+)$/.exec(header)?.[1];
      // The configured secret is read first, so a missing one is reported as such rather than as a wrong token.
      const expected = deps.secrets.tick;
      if (presented === undefined || !sameSecret(presented, expected)) throw unauthenticated('the tick secret is missing or wrong');
      return undefined;
    },
  };
  return async (request, _params, deps) => {
    try {
      await guard.admit(request, deps);
      const result = await run({ request, deps });
      return result instanceof Response ? result : reply(result);
    } catch (error) {
      return errorResponse(error, deps);
    }
  };
}
