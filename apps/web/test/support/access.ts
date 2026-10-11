import { expect } from 'vitest';
import type { Endpoint } from '../../src/server/http/endpoint';
import { STRANGER, type World, call, sessionOf } from './world';

export interface Guarded {
  name: string;
  endpoint: Endpoint;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Path parameters beside the organisation's id. */
  params?: Record<string, string>;
  query?: Record<string, string>;
  /** A body the endpoint would accept from the owner. */
  body?: unknown;
}

/**
 * Hold a group of organisation routes to the rule they all share: nobody gets
 * in without a session, and somebody who is signed in but does not own the
 * organisation gets, byte for byte, the answer an organisation that does not
 * exist gets. `untouched` is called after every attempt to prove nothing happened.
 */
export async function expectOwnerOnly(w: World, orgId: string, routes: readonly Guarded[], untouched: () => Promise<void> = async () => undefined): Promise<void> {
  const stranger = await sessionOf(w, STRANGER.address);
  for (const route of routes) {
    const options = { query: route.query ?? {}, body: route.body };
    const params = { ...route.params, orgId };

    const anonymous = await call(w, route.endpoint, route.method, { ...options, params });
    expect(anonymous.status, `${route.name}: without a session`).toBe(401);
    expect(anonymous.body, route.name).toEqual({ error: 'unauthenticated', message: 'sign in first' });

    const theirs = await call(w, route.endpoint, route.method, { ...options, params, cookie: stranger });
    const nobodys = await call(w, route.endpoint, route.method, { ...options, params: { ...route.params, orgId: 'no-such-organisation' }, cookie: stranger });
    expect(theirs.status, `${route.name}: as someone who does not own it`).toBe(404);
    expect(theirs.body, route.name).toEqual({ error: 'not_found', message: 'not found' });
    expect(theirs.text, `${route.name}: the same answer as for no organisation at all`).toBe(nobodys.text);

    // The refusal comes before the input is looked at: a malformed request from a stranger learns nothing more.
    if (route.method !== 'GET') {
      const malformed = await call(w, route.endpoint, route.method, { params, cookie: stranger, body: { certainly: 'not what the endpoint takes' } });
      expect(malformed.text, `${route.name}: malformed, from a stranger`).toBe(nobodys.text);
      const foreign = await call(w, route.endpoint, route.method, { ...options, params, cookie: await sessionOf(w), origin: 'https://evil.example' });
      expect(foreign.status, `${route.name}: from another origin`).toBe(403);
    }
    await untouched();
  }
}
