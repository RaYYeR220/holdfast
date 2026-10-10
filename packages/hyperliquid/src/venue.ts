import type { HedgeVenue, OrderRequest } from '@holdfast/core';
import { type Fill, type FundingPayment, fetchFundingAprBps, fetchUserFills, fetchUserFunding } from './books';
import { createTransport, type Network } from './client';
import { createOrderPlacer, type PlaceResult } from './orders';
import { agentAccount } from './signing';
import { type HyperliquidState, readState } from './state';

export interface HedgeVenueConfig {
  network: Network;
  /** Perp to hedge with. Its size step must be 0.01, which is what a lot means. */
  coin?: string | undefined;
  /** Agent (API wallet) key. Only `place` needs it; every read works without. */
  agentPrivateKey?: `0x${string}` | undefined;
  fetch?: typeof fetch | undefined;
  now?: (() => number) | undefined;
  /** Per-request timeout, 10 seconds unless set. */
  timeoutMs?: number | undefined;
}

export interface HyperliquidVenue extends HedgeVenue {
  state(user: string): Promise<HyperliquidState>;
  place(order: OrderRequest): Promise<PlaceResult>;
  /** Funding paid to (positive) or by (negative) the account since `sinceMs`. */
  userFunding(user: string, sinceMs: number): Promise<FundingPayment[]>;
  userFills(user: string, sinceMs: number): Promise<Fill[]>;
}

export function createHedgeVenue(config: HedgeVenueConfig): HyperliquidVenue {
  const transport = createTransport(config);
  const coin = config.coin ?? 'ZEC';
  const agent = config.agentPrivateKey === undefined ? null : agentAccount(config.agentPrivateKey);
  const orders = createOrderPlacer(transport, coin, agent);

  return {
    state: (user) => readState(transport, coin, user),
    fundingAprBps: (hours) => fetchFundingAprBps(transport, coin, hours),
    place: (order) => orders.place(order),
    userFunding: (user, sinceMs) => fetchUserFunding(transport, user, sinceMs),
    userFills: (user, sinceMs) => fetchUserFills(transport, user, sinceMs),
  };
}
