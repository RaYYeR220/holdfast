import { runtime } from '../runtime';
import type { Endpoint } from './endpoint';

/** The second argument Next.js gives a route handler: the path parameters, as a promise. */
export interface RouteContext {
  params: Promise<unknown>;
}

/** Turn an endpoint into a Next.js route handler that runs on the real dependencies. */
export function bind(endpoint: Endpoint): (request: Request, context: RouteContext) => Promise<Response> {
  return async (request, context) => endpoint(request, await context.params, runtime());
}
