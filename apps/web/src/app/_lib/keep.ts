/**
 * Answers kept for a short while. The public pages read chains, a venue and
 * the whole journal for anyone who asks; kept answers mean that the same
 * question asked again at once costs the server one read, not one each. Every
 * figure still carries the time it was read, so a kept answer is never shown
 * as newer than it is.
 *
 * Requests that arrive while the first is still being answered share its
 * work. A failure is kept as well, for the same time: an unreadable source
 * is not asked again on every request.
 */
export function keep<T>(ttlMs: number, max = 64): (key: string, work: () => Promise<T>) => Promise<T> {
  const kept = new Map<string, { at: number; value: Promise<T> }>();
  return (key, work) => {
    const now = Date.now();
    const hit = kept.get(key);
    if (hit !== undefined && now - hit.at < ttlMs) return hit.value;
    const value = work();
    // Re-inserted so that the map stays in order of last write; the oldest goes when there are too many.
    kept.delete(key);
    kept.set(key, { at: now, value });
    while (kept.size > max) {
      const oldest = kept.keys().next();
      if (oldest.done === true) break;
      kept.delete(oldest.value);
    }
    return value;
  };
}

type Handler<C> = (request: Request, context: C) => Promise<Response>;

/**
 * A public GET route whose answers are kept for a short while, by path and
 * query. Only for routes that answer everyone alike: nothing here looks at a
 * cookie, so a kept answer must not depend on who asked.
 */
export function keepResponses<C>(handler: Handler<C>, ttlMs: number, max = 256): Handler<C> {
  const kept = keep<{ status: number; headers: [string, string][]; body: string }>(ttlMs, max);
  return async (request, context) => {
    const url = new URL(request.url);
    const answer = await kept(`${url.pathname}${url.search}`, async () => {
      const response = await handler(request, context);
      return { status: response.status, headers: [...response.headers], body: await response.text() };
    });
    return new Response(answer.body, { status: answer.status, headers: answer.headers });
  };
}
