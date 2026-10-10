import type { OrderRequest, OrderResult } from '@holdfast/core';
import type { LocalAccount } from 'viem/accounts';
import { type Fill, fetchUserFills } from './books';
import { type ExchangeReply, isExchangeRefusal, postExchange, postInfo, type Transport } from './client';
import { HyperliquidResponseError } from './errors';
import { LOT_DECIMALS, lotsToSize, sizeToLots } from './helpers';
import { asDecimalText, asInteger, asRecord, asText, excerpt, isRecord } from './parse';
import { signL1 } from './signing';
import { fetchMarket, normalizeUser } from './state';

/**
 * - `filled` / `partial`: the order traded, fully or in part (the rest of an IOC is cancelled).
 * - `rejected`: Hyperliquid answered and nothing traded, which includes an IOC that found no match.
 * - `resting`: the order sits on the book; an IOC should never end up here.
 * - `notSent`: stopped before anything reached the exchange endpoint.
 * - `unknown`: sent, but no usable answer came back; the order may have traded.
 */
export type PlaceStatus = 'filled' | 'partial' | 'rejected' | 'resting' | 'notSent' | 'unknown';

export interface PlaceResult extends OrderResult {
  status: PlaceStatus;
  /** True when this cloid had been used before, so the earlier order is reported and nothing new was sent. */
  replayed: boolean;
}

export interface IocOrder {
  asset: number;
  isBuy: boolean;
  px: string;
  size: string;
  reduceOnly: boolean;
  cloid?: `0x${string}`;
}

const CLOID = /^0x[0-9a-fA-F]{32}$/;
const MAX_REMEMBERED_NONCES = 1024;
const FILL_LOOKBACK_MS = 60_000;
const AVG_PX_DECIMALS = 8;
/**
 * How long an unanswered attempt is retried with its original nonce. The
 * lookup by cloid can trail the exchange by a moment; minutes later an order
 * that did land is visible to it and a fresh nonce is safe again.
 */
const RESEND_WINDOW_MS = 10 * 60_000;

/** Hyperliquid signs numbers as strings without trailing zeros: "1.50" must go out as "1.5". */
function wireDecimal(text: string): string {
  return text.includes('.') ? text.replace(/0+$/, '').replace(/\.$/, '') : text;
}

/**
 * The order action exactly as it is hashed and sent. Field order matters: the
 * signature covers the msgpack encoding of this object as written, and
 * Hyperliquid rebuilds the same bytes from its own parse of the request.
 */
export function iocOrderAction(order: IocOrder): Record<string, unknown> {
  return {
    type: 'order',
    orders: [
      {
        a: order.asset,
        b: order.isBuy,
        p: wireDecimal(order.px),
        s: wireDecimal(order.size),
        r: order.reduceOnly,
        t: { limit: { tif: 'Ioc' } },
        ...(order.cloid === undefined ? {} : { c: order.cloid.toLowerCase() }),
      },
    ],
    grouping: 'na',
  };
}

function result(status: PlaceStatus, fields: Partial<OrderResult> & { replayed?: boolean }): PlaceResult {
  return {
    ok: status === 'filled' || status === 'partial',
    filledLots: 0,
    avgPx: null,
    oid: null,
    error: null,
    replayed: false,
    ...fields,
    status,
  };
}

function oidOf(value: unknown): string | null {
  return typeof value === 'number' || typeof value === 'string' ? String(value) : null;
}

/** Turn the exchange's answer to a single-order request into a result. Never throws. */
export function mapOrderReply(reply: ExchangeReply, requestedLots: number): PlaceResult {
  if (!reply.delivered) {
    return result('unknown', { error: `${reply.error}; the order may or may not have reached the exchange` });
  }
  if (reply.httpStatus !== 200) {
    // A 4xx (malformed request, rate limit) is turned away before execution; a 5xx says nothing either way.
    const turnedAway = reply.httpStatus !== null && reply.httpStatus >= 400 && reply.httpStatus < 500;
    return result(turnedAway ? 'rejected' : 'unknown', { error: reply.error ?? `HTTP ${reply.httpStatus}` });
  }
  if (isExchangeRefusal(reply)) return result('rejected', { error: reply.error ?? 'rejected by the exchange' });

  const statuses = isRecord(reply.response) && isRecord(reply.response.response) && isRecord(reply.response.response.data)
    ? reply.response.response.data.statuses
    : undefined;
  if (!reply.ok || !Array.isArray(statuses) || statuses.length !== 1) {
    return result('unknown', { error: `unexpected order response: ${excerpt(reply.response)}` });
  }

  const status: unknown = statuses[0];
  if (isRecord(status) && typeof status.error === 'string') return result('rejected', { error: status.error });

  if (isRecord(status) && isRecord(status.resting)) {
    return result('resting', {
      oid: oidOf(status.resting.oid),
      error: 'the order is resting on the book, which an IOC order should never do',
    });
  }

  if (isRecord(status) && isRecord(status.filled)) {
    const oid = oidOf(status.filled.oid);
    let filledLots: number;
    try {
      filledLots = sizeToLots(asDecimalText(status.filled.totalSz, 'filled.totalSz'));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return result('unknown', { oid, error: `the order filled but its size is unreadable: ${reason}` });
    }
    if (filledLots <= 0) return result('unknown', { oid, error: 'the exchange reported a fill of zero size' });
    const avgPx = Number(status.filled.avgPx);
    return result(filledLots >= requestedLots ? 'filled' : 'partial', {
      filledLots,
      avgPx: Number.isFinite(avgPx) && avgPx > 0 ? avgPx : null,
      oid,
    });
  }

  return result('unknown', { error: `unexpected order status: ${excerpt(status)}` });
}

interface PriorOrder {
  oid: number;
  /** Hyperliquid's processing status, e.g. "filled" or "iocCancelRejected". */
  status: string;
  placedAt: number;
  origSz: string;
  remainingSz: string;
}

function parseOrderStatus(raw: unknown): PriorOrder | null {
  const body = asRecord(raw, 'orderStatus');
  if (body.status === 'unknownOid') return null;
  if (body.status !== 'order') throw new HyperliquidResponseError(`orderStatus: unexpected answer ${excerpt(raw)}`);
  const wrapper = asRecord(body.order, 'orderStatus.order');
  const order = asRecord(wrapper.order, 'orderStatus.order.order');
  return {
    oid: asInteger(order.oid, 'orderStatus.order.order.oid'),
    status: asText(wrapper.status, 'orderStatus.order.status'),
    placedAt: asInteger(order.timestamp, 'orderStatus.order.order.timestamp'),
    origSz: asDecimalText(order.origSz, 'orderStatus.order.order.origSz'),
    remainingSz: asDecimalText(order.sz, 'orderStatus.order.order.sz'),
  };
}

/** Report an order that already exists under this cloid, taking size and price from its fills. */
export function replayResult(prior: PriorOrder, fills: readonly Fill[], requestedLots: number): PlaceResult {
  const oid = String(prior.oid);
  const own = fills.filter((fill) => fill.oid === oid);
  const size = own.reduce((sum, fill) => sum + fill.size, 0);
  const notional = own.reduce((sum, fill) => sum + fill.px * fill.size, 0);
  let filledLots = Math.round(size * 10 ** LOT_DECIMALS);
  let avgPx = size > 0 ? Number((notional / size).toFixed(AVG_PX_DECIMALS)) : null;

  if (filledLots === 0 && prior.status === 'filled') {
    // The order is known to have filled but its fills are not served yet; the size is still certain.
    filledLots = sizeToLots(prior.origSz) - sizeToLots(prior.remainingSz);
    avgPx = null;
  }
  if (filledLots > 0) {
    return result(filledLots >= requestedLots ? 'filled' : 'partial', { filledLots, avgPx, oid, replayed: true });
  }
  return result(prior.status === 'open' ? 'resting' : 'rejected', {
    oid,
    replayed: true,
    error: `cloid already used by order ${oid} (${prior.status}), which has not traded; nothing was sent`,
  });
}

function validate(order: OrderRequest): string | null {
  if (order.side !== 'buy' && order.side !== 'sell') return `unknown side "${String(order.side)}"`;
  if (!Number.isSafeInteger(order.lots) || order.lots <= 0) return `lots must be a positive integer, got ${order.lots}`;
  if (!Number.isFinite(order.limitPx) || order.limitPx <= 0) return `limit price must be positive, got ${order.limitPx}`;
  if (/e/i.test(String(order.limitPx))) return `limit price ${order.limitPx} cannot be written as a plain decimal`;
  if (typeof order.reduceOnly !== 'boolean') return 'reduceOnly must be a boolean';
  if (typeof order.cloid !== 'string' || !CLOID.test(order.cloid)) return 'cloid must be 16 bytes of hex';
  return null;
}

export interface OrderPlacer {
  place(order: OrderRequest): Promise<PlaceResult>;
}

/**
 * Sends IOC limit orders for one coin with one agent key. Sells open or grow
 * the short, buys reduce it.
 *
 * A cloid stands for one attempt, and Hyperliquid does not enforce that for
 * us: once an order is done its cloid can be used again, and on mainnet one
 * cloid can be found on several filled IOC orders of the same account. So the
 * guarantee is built here from two things Hyperliquid does provide: an order
 * can be looked up by cloid, and a nonce is accepted only once per signer.
 * Before sending, the cloid is looked up and an existing order is reported
 * instead of repeated. When an attempt ends without an answer, its nonce is
 * kept, so a retry in the same process is the same signed bytes and
 * Hyperliquid itself refuses to run them twice.
 */
export function createOrderPlacer(transport: Transport, coin: string, agent: LocalAccount | null): OrderPlacer {
  let asset: number | null = null;
  let lastNonce = 0;
  const verifiedUsers = new Set<string>();
  const unansweredNonces = new Map<string, number>();

  async function assetIndex(): Promise<number> {
    asset ??= (await fetchMarket(transport, coin)).asset;
    return asset;
  }

  /**
   * An agent trades for whichever account approved it, and the order itself
   * does not name that account. Asking Hyperliquid who the agent belongs to
   * keeps an order for one team from landing on another team's account.
   */
  async function agentMismatch(agentAddress: string, user: string): Promise<string | null> {
    if (verifiedUsers.has(user)) return null;
    const role = asRecord(await postInfo(transport, { type: 'userRole', user: agentAddress }), 'userRole');
    const master = role.role === 'agent' && isRecord(role.data) ? role.data.user : undefined;
    if (typeof master === 'string' && master.toLowerCase() === user) {
      verifiedUsers.add(user);
      return null;
    }
    return `agent ${agentAddress} is not approved to trade for ${user} (Hyperliquid reports ${excerpt(role)})`;
  }

  function nonceFor(cloid: string): { nonce: number; resent: boolean } {
    const now = transport.now();
    const kept = unansweredNonces.get(cloid);
    if (kept !== undefined && now - kept <= RESEND_WINDOW_MS) return { nonce: kept, resent: true };
    lastNonce = Math.max(now, lastNonce + 1);
    return { nonce: lastNonce, resent: false };
  }

  function remember(cloid: string, nonce: number): void {
    unansweredNonces.set(cloid, nonce);
    if (unansweredNonces.size > MAX_REMEMBERED_NONCES) {
      const oldest = unansweredNonces.keys().next();
      if (!oldest.done) unansweredNonces.delete(oldest.value);
    }
  }

  /** Everything that has to hold before an order may go out: either a reason to stop, or the asset to trade. */
  async function prepare(order: OrderRequest, account: LocalAccount): Promise<PlaceResult | { asset: number }> {
    const user = normalizeUser(order.user);
    const index = await assetIndex();
    const mismatch = await agentMismatch(account.address.toLowerCase(), user);
    if (mismatch !== null) return result('notSent', { error: mismatch });

    const prior = parseOrderStatus(await postInfo(transport, { type: 'orderStatus', user, oid: order.cloid.toLowerCase() }));
    if (prior !== null) {
      // A minute of slack, so nothing depends on how the order and fill timestamps line up.
      const fills = await fetchUserFills(transport, user, Math.max(0, prior.placedAt - FILL_LOOKBACK_MS));
      return replayResult(prior, fills, order.lots);
    }
    return { asset: index };
  }

  async function place(order: OrderRequest): Promise<PlaceResult> {
    const invalid = validate(order);
    if (invalid !== null) return result('notSent', { error: invalid });
    if (agent === null) return result('notSent', { error: 'no agent key is configured, so orders cannot be signed' });

    let ready: PlaceResult | { asset: number };
    try {
      ready = await prepare(order, agent);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return result('notSent', { error: `not sent: ${reason}` });
    }
    if ('status' in ready) return ready;

    const cloid = order.cloid.toLowerCase() as `0x${string}`;
    const action = iocOrderAction({
      asset: ready.asset,
      isBuy: order.side === 'buy',
      px: String(order.limitPx),
      size: lotsToSize(order.lots),
      reduceOnly: order.reduceOnly,
      cloid,
    });
    const { nonce, resent } = nonceFor(cloid);

    let reply: ExchangeReply;
    try {
      const signature = await signL1(agent, transport.network, action, nonce);
      remember(cloid, nonce);
      reply = await postExchange(transport, { action, nonce, signature });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return result(unansweredNonces.has(cloid) ? 'unknown' : 'notSent', { error: `could not send the order: ${reason}` });
    }

    const mapped = mapOrderReply(reply, order.lots);
    if (resent && isExchangeRefusal(reply)) {
      // The same signed bytes went out before without an answer. A refusal now may only mean that
      // the first copy was accepted, so this is not proof that nothing traded.
      return result('unknown', {
        error: `resent with its original nonce and refused (${mapped.error}); the first attempt may have traded`,
      });
    }
    if (mapped.status !== 'unknown') unansweredNonces.delete(cloid);
    return mapped;
  }

  return { place };
}
