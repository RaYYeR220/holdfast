import fundingHistory from './fixtures/fundingHistory.json';
import market from './fixtures/metaAndAssetCtxs.json';
import portfolioMargin from './fixtures/account-portfolio-margin.json';
import standardFlat from './fixtures/account-standard-flat.json';
import standardLong from './fixtures/account-standard-long.json';
import standardShort from './fixtures/account-standard-short.json';
import unifiedFlat from './fixtures/account-unified-flat.json';
import unifiedIsolated from './fixtures/account-unified-isolated.json';
import unifiedLong from './fixtures/account-unified-long.json';
import unifiedShort from './fixtures/account-unified-short.json';
import userFills from './fixtures/userFillsByTime.json';
import userFunding from './fixtures/userFunding.json';

/**
 * Everything under ./fixtures is a real answer of https://api.hyperliquid.xyz/info,
 * recorded on 2026-10-10 and trimmed: positions and balances in other coins were
 * cut to one or two, and the perp universe to four coins. ZEC is therefore asset 3
 * in these files; on mainnet it was asset 214 that day.
 */
export const fixtures = {
  market,
  fundingHistory,
  userFills,
  userFunding,
  accounts: {
    standardFlat,
    standardShort,
    standardLong,
    unifiedFlat,
    unifiedShort,
    unifiedLong,
    unifiedIsolated,
    portfolioMargin,
  },
};

export const ZEC_ASSET = 3;

export interface AccountFixture {
  user: string;
  userAbstraction: string;
  clearinghouseState: unknown;
  spotClearinghouseState: unknown;
}

/** The request body of one call, as the adapter sent it. Loosely typed so tests can reach into it. */
export type Body = Record<string, any>;

export interface Call {
  endpoint: 'info' | 'exchange';
  url: string;
  body: Body;
}

type Handler = (body: Body) => unknown;

export interface Routes {
  info?: Record<string, Handler>;
  exchange?: Handler;
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

export function text(body: string, status: number): Response {
  return new Response(body, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}

/** An in-memory Hyperliquid: routes info requests by `type`, records every call. */
export function fakeHyperliquid(routes: Routes) {
  const calls: Call[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input);
    const endpoint = url.endsWith('/exchange') ? 'exchange' : 'info';
    const body = JSON.parse(String(init?.body)) as Body;
    calls.push({ endpoint, url, body });
    const handler = endpoint === 'exchange' ? routes.exchange : routes.info?.[String(body.type)];
    if (handler === undefined) throw new Error(`unexpected ${endpoint} request: ${JSON.stringify(body)}`);
    const answer = await handler(body);
    return answer instanceof Response ? answer : json(answer);
  };
  return {
    fetch,
    calls,
    sent: (endpoint: Call['endpoint'], type?: string) =>
      calls.filter((call) => call.endpoint === endpoint && (type === undefined || call.body.type === type)),
  };
}

/** Info routes that serve one recorded account next to the recorded market. */
export function accountRoutes(account: AccountFixture): Record<string, Handler> {
  return {
    metaAndAssetCtxs: () => fixtures.market,
    clearinghouseState: () => account.clearinghouseState,
    spotClearinghouseState: () => account.spotClearinghouseState,
    userAbstraction: () => account.userAbstraction,
  };
}

export function clone<T>(value: T): T {
  return structuredClone(value);
}
