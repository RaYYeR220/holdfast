import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SESSION_COOKIE } from '../../../src/server/auth/session';
import type { Endpoint } from '../../../src/server/http/endpoint';
import { HOST, ORIGIN, type World } from '../../support/world';

/**
 * The application's routes as its route files declare them, and a `fetch`
 * that serves them in this process the way the router and a browser on the
 * application's own pages would between them.
 */

/** Every endpoint module there is, by its name: whichever a route file imports from is found here without being listed. */
const MODULES = new Map(
  Object.entries(import.meta.glob<Record<string, unknown>>('../../../src/server/api/*.ts', { eager: true })).map(([path, module]) => [path.slice(path.lastIndexOf('/') + 1, -'.ts'.length), module]),
);
const API_ROOT = fileURLToPath(new URL('../../../src/app/api', import.meta.url));

export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface Route {
  method: Method;
  /** The path as the router has it, such as `/api/orgs/[orgId]/policy`. */
  pattern: string;
  segments: string[];
  endpoint: Endpoint;
}

function routeFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return routeFiles(path);
    return entry.name === 'route.ts' ? [path] : [];
  });
}

/**
 * Every operation of the API: read out of the route files, which say which
 * endpoint each method of each path is bound to. A route file that binds
 * something this cannot follow is an error, so that no route goes unnoticed.
 */
export function appRoutes(): Route[] {
  const routes: Route[] = [];
  for (const file of routeFiles(API_ROOT)) {
    const source = readFileSync(file, 'utf8');
    const segments = ['api', ...file.slice(API_ROOT.length).split(/[\\/]/).filter((part) => part !== '' && part !== 'route.ts')];
    const pattern = `/${segments.join('/')}`;

    const imported = new Map<string, Record<string, unknown>>();
    for (const [, names = '', module = ''] of source.matchAll(/import \{([^}]+)\} from '@\/server\/api\/([\w-]+)';/g)) {
      const from = MODULES.get(module);
      if (from === undefined) throw new Error(`${pattern} imports from src/server/api/${module}, which is not there`);
      for (const name of names.split(',').map((part) => part.trim()).filter((part) => part !== '')) imported.set(name, from);
    }
    // A public route may be bound through the keeper of short-lived answers; the endpoint behind it is the same.
    const bound = [...source.matchAll(/export const (GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) = (?:keepResponses\()?bind\((\w+)\)(?:, [\d_]+\))?;/g)];
    if (bound.length === 0) throw new Error(`${pattern} binds no endpoint`);
    for (const [, method = '', name = ''] of bound) {
      const endpoint = imported.get(name)?.[name];
      if (typeof endpoint !== 'function') throw new Error(`${pattern} binds ${name}, which is not an endpoint`);
      routes.push({ method: method as Method, pattern, segments, endpoint: endpoint as Endpoint });
    }
  }
  return routes;
}

/** The route a request goes to, with the path parameters the router would hand over; null when there is none. */
export function matchRoute(routes: readonly Route[], method: string, pathname: string): { route: Route; params: Record<string, string> } | null {
  const parts = pathname.split('/').filter((part) => part !== '');
  for (const route of routes) {
    if (route.method !== method || route.segments.length !== parts.length) continue;
    const params: Record<string, string> = {};
    const fits = route.segments.every((segment, i) => {
      const part = parts[i] ?? '';
      const named = /^\[(\w+)\]$/.exec(segment);
      if (named === null) return segment === part;
      params[named[1] ?? ''] = decodeURIComponent(part);
      return true;
    });
    if (fits) return { route, params };
  }
  return null;
}

export interface AppCall {
  method: string;
  /** Path and query, as requested. */
  url: string;
  /** The route that served it; null when none did. */
  pattern: string | null;
  status: number;
  contentType: string | null;
  credentials: string | undefined;
  body: unknown;
}

export interface App {
  fetch: typeof fetch;
  routes: Route[];
  calls: AppCall[];
  /** The cookies the browser holds for the application. */
  cookies: Map<string, string>;
  /** Whether the session cookie is held. */
  signedIn(): boolean;
}

/**
 * A browser's `fetch` on the application's own pages, served by the real
 * endpoints over the given world. It does what a browser does and a script
 * cannot: it names the page's origin on every state-changing request, keeps
 * the cookies the application sets, and sends them back only when the request
 * asks for credentials.
 */
export function app(w: World): App {
  const routes = appRoutes();
  const calls: AppCall[] = [];
  const cookies = new Map<string, string>();

  const fetch: typeof globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input), ORIGIN);
    if (url.origin !== ORIGIN) throw new TypeError(`the application was asked for ${url.origin}, which is not its origin`);
    const method = (init.method ?? 'GET').toUpperCase();
    const headers = new Headers(init.headers);
    headers.set('host', HOST);
    if (method !== 'GET' && method !== 'HEAD') headers.set('origin', ORIGIN);
    const withCredentials = init.credentials === undefined || init.credentials === 'same-origin' || init.credentials === 'include';
    if (withCredentials && cookies.size > 0) headers.set('cookie', [...cookies].map(([name, value]) => `${name}=${value}`).join('; '));

    const body = typeof init.body === 'string' ? init.body : undefined;
    const record = (pattern: string | null, response: Response): Response => {
      calls.push({
        method,
        url: `${url.pathname}${url.search}`,
        pattern,
        status: response.status,
        contentType: headers.get('content-type'),
        credentials: init.credentials,
        body: body === undefined ? undefined : (JSON.parse(body) as unknown),
      });
      return response;
    };

    const matched = matchRoute(routes, method, url.pathname);
    if (matched === null) return record(null, new Response('<!DOCTYPE html><title>404</title>', { status: 404, headers: { 'content-type': 'text/html' } }));
    const response = await matched.route.endpoint(new Request(url, { method, headers, ...(body === undefined ? {} : { body }) }), matched.params, w.deps);

    if (withCredentials) {
      for (const cookie of response.headers.getSetCookie()) {
        const [pair = '', ...attributes] = cookie.split(';').map((part) => part.trim());
        const at = pair.indexOf('=');
        const name = pair.slice(0, at);
        const value = pair.slice(at + 1);
        if (value === '' || attributes.includes('Max-Age=0')) cookies.delete(name);
        else cookies.set(name, value);
      }
    }
    return record(matched.route.pattern, response);
  };

  return { fetch, routes, calls, cookies, signedIn: () => cookies.has(SESSION_COOKIE) };
}
