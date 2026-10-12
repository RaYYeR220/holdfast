import { API_URL } from '@holdfast/hyperliquid';
import type { HoldfastNetwork } from '../config';

/**
 * Two reads of Hyperliquid's public info endpoint that the lock page shows
 * and the venue adapter does not make: what the account's ZEC position cost
 * and stands at, and which agents the account has approved. Both are asked
 * of the venue at the time of the request and need no key.
 */

/** How long one request waits for the venue, ms. */
const PATIENCE_MS = 8_000;
const COIN = 'ZEC';
const DECIMAL = /^-?\d+(\.\d+)?$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export interface VenueIo {
  network: HoldfastNetwork;
  /** Used in place of the global `fetch`. */
  fetch?: typeof fetch;
}

/** The account's position in the ZEC perpetual as the venue states it. */
export interface PositionDetail {
  /** Signed size in ZEC as the venue prints it; negative for a short. */
  szi: string;
  /** The average price the open position was entered at. */
  entryPx: number;
  /** The position's size at the mark, in dollars. */
  positionValueUsd: number;
  /** What the position has gained or lost since entry at the mark, in dollars; negative is a loss. */
  unrealizedPnlUsd: number;
  /** The mark at which the venue would liquidate the position as the account stands; null when it names none. */
  liquidationPx: number | null;
}

/** An agent the account has approved to sign trading actions for it. */
export interface ApprovedAgent {
  name: string;
  address: string;
  /** When the approval lapses, ms; null when the venue names no expiry. */
  validUntil: number | null;
}

function fail(what: string): never {
  throw new Error(`Hyperliquid answered ${what}`);
}

async function info(io: VenueIo, request: { type: string; user: string }): Promise<unknown> {
  const doFetch = io.fetch ?? globalThis.fetch;
  let response: Response;
  try {
    response = await doFetch(`${API_URL[io.network]}/info`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(PATIENCE_MS),
      cache: 'no-store',
    });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === 'TimeoutError';
    throw new Error(timedOut ? `Hyperliquid gave no answer within ${PATIENCE_MS / 1000} s` : 'Hyperliquid could not be reached');
  }
  if (response.status !== 200) fail(`HTTP ${response.status} to ${request.type}`);
  try {
    return (await response.json()) as unknown;
  } catch {
    return fail(`${request.type} with something other than JSON`);
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function decimal(value: unknown, what: string): number {
  if (typeof value !== 'string' || !DECIMAL.test(value)) fail(`${what} that is not a decimal`);
  return Number(value);
}

function account(user: string): string {
  if (!ADDRESS.test(user)) throw new Error('the account is not an address');
  return user.toLowerCase();
}

/** Pick the ZEC position out of a `clearinghouseState` answer; null when the account holds none. */
export function parsePosition(raw: unknown): PositionDetail | null {
  if (!isRecord(raw) || !Array.isArray(raw.assetPositions)) fail('clearinghouseState without a list of positions');
  for (const entry of raw.assetPositions) {
    const position = isRecord(entry) ? entry.position : undefined;
    if (!isRecord(position)) fail('a position that cannot be read');
    if (position.coin !== COIN) continue;
    const { szi, liquidationPx } = position;
    if (typeof szi !== 'string' || !DECIMAL.test(szi)) fail('a position size that is not a decimal');
    if (Number(szi) === 0) return null;
    return {
      szi,
      entryPx: decimal(position.entryPx, 'an entry price'),
      positionValueUsd: decimal(position.positionValue, 'a position value'),
      unrealizedPnlUsd: decimal(position.unrealizedPnl, 'an unrealised P&L'),
      liquidationPx: liquidationPx === null || liquidationPx === undefined ? null : decimal(liquidationPx, 'a liquidation price'),
    };
  }
  return null;
}

/** The agents of an `extraAgents` answer. */
export function parseAgents(raw: unknown): ApprovedAgent[] {
  if (!Array.isArray(raw)) fail('extraAgents with something other than a list');
  return raw.map((entry) => {
    if (!isRecord(entry) || typeof entry.name !== 'string' || typeof entry.address !== 'string' || !ADDRESS.test(entry.address)) fail('an agent that cannot be read');
    const { validUntil } = entry;
    return { name: entry.name, address: entry.address.toLowerCase(), validUntil: typeof validUntil === 'number' && Number.isSafeInteger(validUntil) && validUntil > 0 ? validUntil : null };
  });
}

/** The ZEC position of an account, read from the venue now; null when it holds none. */
export async function readPosition(io: VenueIo, user: string): Promise<PositionDetail | null> {
  return parsePosition(await info(io, { type: 'clearinghouseState', user: account(user) }));
}

/** The agents an account has approved, read from the venue now. An account the venue has never seen has none. */
export async function readAgents(io: VenueIo, user: string): Promise<ApprovedAgent[]> {
  return parseAgents(await info(io, { type: 'extraAgents', user: account(user) }));
}
