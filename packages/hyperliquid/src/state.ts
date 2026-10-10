import type { VenueState } from '@holdfast/core';
import { isAddress } from 'viem';
import { postInfo, type Transport } from './client';
import { HyperliquidError, HyperliquidResponseError, IsolatedPositionError, UnsupportedAccountModeError } from './errors';
import { LOT_DECIMALS, sizeToLots } from './helpers';
import { asDecimal, asDecimalText, asInteger, asList, asRecord, asText, excerpt } from './parse';

export type AccountMode = 'standard' | 'unified';

export interface HyperliquidState extends VenueState {
  coin: string;
  /** Which equity formula applied; see `accountEquity`. */
  mode: AccountMode;
  /** The raw answer of the `userAbstraction` info request. */
  abstraction: string;
}

/** Spot token index of USDC, the collateral of the validator-operated perp dex. */
const USDC_TOKEN = 0;

/**
 * "default" is what an account reports before it ever picks a mode. Live
 * accounts in that state keep their collateral in the perp balance, the same
 * as "disabled". The discontinued "dexAbstraction" also leaves USDC there.
 */
const MODE_BY_ABSTRACTION = new Map<string, AccountMode>([
  ['default', 'standard'],
  ['disabled', 'standard'],
  ['dexAbstraction', 'standard'],
  ['unifiedAccount', 'unified'],
]);

export function accountMode(abstraction: string): AccountMode {
  const mode = MODE_BY_ABSTRACTION.get(abstraction);
  if (mode === undefined) throw new UnsupportedAccountModeError(abstraction);
  return mode;
}

export function normalizeUser(user: string): `0x${string}` {
  if (!isAddress(user, { strict: false })) {
    throw new HyperliquidError('INVALID_ARGUMENT', `"${user}" is not an account address`);
  }
  return user.toLowerCase() as `0x${string}`;
}

export interface Market {
  /** Index in the perp universe; this is the `a` of an order. */
  asset: number;
  markPx: number;
  oraclePx: number;
}

function requirePrice(value: unknown, where: string): number {
  const px = asDecimal(value, where);
  if (!(px > 0)) throw new HyperliquidResponseError(`${where}: expected a positive price`);
  return px;
}

/** Pick one coin out of a `metaAndAssetCtxs` response. */
export function parseMarket(raw: unknown, coin: string): Market {
  const pair = asList(raw, 'metaAndAssetCtxs');
  const universe = asList(asRecord(pair[0], 'metaAndAssetCtxs[0]').universe, 'meta.universe');
  const contexts = asList(pair[1], 'metaAndAssetCtxs[1]');

  const asset = universe.findIndex((entry) => asRecord(entry, 'meta.universe[]').name === coin);
  if (asset < 0) throw new HyperliquidError('UNKNOWN_COIN', `${coin} is not listed on Hyperliquid perps`);
  const listing = asRecord(universe[asset], `meta.universe[${asset}]`);
  if (listing.isDelisted === true) throw new HyperliquidError('UNKNOWN_COIN', `${coin} is delisted`);

  const szDecimals = asInteger(listing.szDecimals, `${coin}.szDecimals`);
  if (szDecimals !== LOT_DECIMALS) {
    throw new HyperliquidError(
      'UNSUPPORTED_LOT_SIZE',
      `${coin} trades in steps of ${szDecimals} decimals; lots are fixed at ${LOT_DECIMALS}`,
    );
  }

  const context = asRecord(contexts[asset], `assetCtxs[${asset}]`);
  return {
    asset,
    markPx: requirePrice(context.markPx, `${coin}.markPx`),
    oraclePx: requirePrice(context.oraclePx, `${coin}.oraclePx`),
  };
}

export async function fetchMarket(transport: Transport, coin: string): Promise<Market> {
  return parseMarket(await postInfo(transport, { type: 'metaAndAssetCtxs' }), coin);
}

interface Position {
  coin: string;
  szi: string;
  isolated: boolean;
  marginUsed: number;
}

function parsePositions(perp: Record<string, unknown>): Position[] {
  return asList(perp.assetPositions, 'clearinghouseState.assetPositions').map((entry, i) => {
    const where = `assetPositions[${i}].position`;
    const position = asRecord(asRecord(entry, `assetPositions[${i}]`).position, where);
    const leverage = asRecord(position.leverage, `${where}.leverage`);
    return {
      coin: asText(position.coin, `${where}.coin`),
      szi: asDecimalText(position.szi, `${where}.szi`),
      isolated: asText(leverage.type, `${where}.leverage.type`) === 'isolated',
      marginUsed: asDecimal(position.marginUsed, `${where}.marginUsed`),
    };
  });
}

function spotUsdcTotal(spot: unknown): number {
  const balances = asList(asRecord(spot, 'spotClearinghouseState').balances, 'spotClearinghouseState.balances');
  for (const entry of balances) {
    const balance = asRecord(entry, 'spotClearinghouseState.balances[]');
    if (balance.token === USDC_TOKEN) return asDecimal(balance.total, 'spot USDC total');
  }
  // An account that never held USDC has no entry for it at all.
  return 0;
}

/**
 * Equity that backs the cross position, in dollars.
 *
 * Standard account: perps have their own balance, so the answer is
 * `crossMarginSummary.accountValue` of the perp clearinghouse state. Isolated
 * positions carry their own margin and are not part of it.
 *
 * Unified account: there is one USDC balance and Hyperliquid reports it in the
 * spot clearinghouse state, already marked to market (it moves tick by tick
 * with unrealised PnL). The perp `accountValue` only shows the slice currently
 * set aside as margin for the open positions, so reading it would understate
 * the equity several times over and trip the de-risk ladder on a healthy
 * account. Following the unified account ratio in Hyperliquid's docs:
 *
 *   equity = spot USDC total - sum of marginUsed over isolated positions
 *
 * Only the validator-operated dex is read. USDC-margined positions on HIP-3
 * dexes draw on the same balance, so the hedge account should not hold any.
 */
export function accountEquity(mode: AccountMode, perp: unknown, spot: unknown): number {
  const state = asRecord(perp, 'clearinghouseState');
  if (mode === 'standard') {
    const summary = asRecord(state.crossMarginSummary, 'clearinghouseState.crossMarginSummary');
    return asDecimal(summary.accountValue, 'crossMarginSummary.accountValue');
  }
  const isolatedMargin = parsePositions(state)
    .filter((position) => position.isolated)
    .reduce((sum, position) => sum + position.marginUsed, 0);
  return spotUsdcTotal(spot) - isolatedMargin;
}

/** Signed position in `coin`, in lots, positive when short. */
function shortLots(perp: unknown, coin: string): number {
  const position = parsePositions(asRecord(perp, 'clearinghouseState')).find((p) => p.coin === coin);
  if (position === undefined) return 0;
  const lots = sizeToLots(position.szi);
  if (lots !== 0 && position.isolated) throw new IsolatedPositionError(coin);
  return lots === 0 ? 0 : -lots;
}

/**
 * The four reads go out together. They cannot be made atomic, so `asOf` is the
 * older of our clock when they left and Hyperliquid's own timestamp on the
 * position: a lagging API node shows up as stale data instead of fresh.
 */
export async function readState(transport: Transport, coin: string, user: string): Promise<HyperliquidState> {
  const account = normalizeUser(user);
  const requestedAt = transport.now();
  const [market, perp, abstractionRaw, spot] = await Promise.all([
    fetchMarket(transport, coin),
    postInfo(transport, { type: 'clearinghouseState', user: account }),
    postInfo(transport, { type: 'userAbstraction', user: account }),
    postInfo(transport, { type: 'spotClearinghouseState', user: account }),
  ]);

  if (typeof abstractionRaw !== 'string') {
    throw new HyperliquidResponseError(`userAbstraction: expected a string, got ${excerpt(abstractionRaw)}`);
  }
  const mode = accountMode(abstractionRaw);
  const venueTime = asInteger(asRecord(perp, 'clearinghouseState').time, 'clearinghouseState.time');

  return {
    asOf: Math.min(requestedAt, venueTime),
    markPx: market.markPx,
    oraclePx: market.oraclePx,
    shortLots: shortLots(perp, coin),
    accountValueUsd: accountEquity(mode, perp, spot),
    coin,
    mode,
    abstraction: abstractionRaw,
  };
}
