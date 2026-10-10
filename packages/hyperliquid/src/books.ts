import { postInfo, type Transport } from './client';
import { HyperliquidError, HyperliquidResponseError } from './errors';
import { fundingAprFromHistory } from './helpers';
import { asDecimal, asInteger, asList, asRecord, asText } from './parse';
import { normalizeUser } from './state';

const HOUR_MS = 3_600_000;
/** Funding settles on the hour, so the newest sample should never be much older than that. */
const MAX_FUNDING_SAMPLE_AGE_MS = 2 * HOUR_MS;

/** Hyperliquid caps `fundingHistory` and `userFunding` at 500 rows and `userFillsByTime` at 2000. */
const FUNDING_PAGE = 500;
const FILLS_PAGE = 2000;
const MAX_PAGES = 40;

export interface FundingPayment {
  time: number;
  coin: string;
  /** Dollars credited to the account; negative when the account paid. */
  usd: number;
  /** Signed position the payment was computed on; negative for a short. */
  size: number;
  /** Hourly rate that was applied. */
  fundingRate: number;
}

export interface Fill {
  time: number;
  coin: string;
  side: 'buy' | 'sell';
  /** Hyperliquid's own label, e.g. "Open Short" or "Close Short". */
  direction: string;
  size: number;
  px: number;
  /** Total fee in `feeToken`, any builder fee included; negative when the fill earned a rebate. */
  fee: number;
  feeToken: string;
  closedPnlUsd: number;
  oid: string;
  cloid: `0x${string}` | null;
  /** Trade id, unique per fill. */
  tid: string;
  /** True when the fill took liquidity. */
  crossed: boolean;
}

function requireSince(sinceMs: number): void {
  if (!Number.isSafeInteger(sinceMs) || sinceMs < 0) {
    throw new HyperliquidError('INVALID_ARGUMENT', `sinceMs must be a millisecond timestamp, got ${sinceMs}`);
  }
}

/**
 * Walk a time-ordered info request forward page by page. A full page means
 * there may be more: the next request starts at the last timestamp seen, and
 * rows are keyed so the overlap at that millisecond is not counted twice.
 */
async function collect<T>(
  fetchPage: (startTime: number) => Promise<unknown>,
  parse: (row: unknown) => { key: string; time: number; row: T },
  sinceMs: number,
  pageSize: number,
): Promise<T[]> {
  const rows = new Map<string, { time: number; row: T }>();
  let startTime = sinceMs;
  for (let page = 0; page < MAX_PAGES; page++) {
    const batch = asList(await fetchPage(startTime), 'history page').map(parse);
    for (const item of batch) rows.set(item.key, item);
    if (batch.length < pageSize) {
      return [...rows.values()].sort((a, b) => a.time - b.time).map((item) => item.row);
    }
    const newest = Math.max(...batch.map((item) => item.time));
    startTime = newest > startTime ? newest : startTime + 1;
  }
  throw new HyperliquidResponseError(`history did not end within ${MAX_PAGES} pages`);
}

function parseFundingPayment(row: unknown): { key: string; time: number; row: FundingPayment } {
  const entry = asRecord(row, 'userFunding[]');
  const delta = asRecord(entry.delta, 'userFunding[].delta');
  const time = asInteger(entry.time, 'userFunding[].time');
  const coin = asText(delta.coin, 'userFunding[].delta.coin');
  return {
    key: `${time}:${coin}`,
    time,
    row: {
      time,
      coin,
      usd: asDecimal(delta.usdc, 'userFunding[].delta.usdc'),
      size: asDecimal(delta.szi, 'userFunding[].delta.szi'),
      fundingRate: asDecimal(delta.fundingRate, 'userFunding[].delta.fundingRate'),
    },
  };
}

/** Funding credited to or charged from the account since `sinceMs`, oldest first, all coins. */
export async function fetchUserFunding(transport: Transport, user: string, sinceMs: number): Promise<FundingPayment[]> {
  const account = normalizeUser(user);
  requireSince(sinceMs);
  return collect(
    (startTime) => postInfo(transport, { type: 'userFunding', user: account, startTime }),
    parseFundingPayment,
    sinceMs,
    FUNDING_PAGE,
  );
}

function parseFill(row: unknown): { key: string; time: number; row: Fill } {
  const fill = asRecord(row, 'userFills[]');
  const side = asText(fill.side, 'userFills[].side');
  if (side !== 'A' && side !== 'B') throw new HyperliquidResponseError(`userFills[].side: unknown side "${side}"`);
  const time = asInteger(fill.time, 'userFills[].time');
  const tid = String(asInteger(fill.tid, 'userFills[].tid'));
  return {
    key: tid,
    time,
    row: {
      time,
      coin: asText(fill.coin, 'userFills[].coin'),
      side: side === 'B' ? 'buy' : 'sell',
      direction: asText(fill.dir, 'userFills[].dir'),
      size: asDecimal(fill.sz, 'userFills[].sz'),
      px: asDecimal(fill.px, 'userFills[].px'),
      fee: asDecimal(fill.fee, 'userFills[].fee'),
      feeToken: asText(fill.feeToken, 'userFills[].feeToken'),
      closedPnlUsd: asDecimal(fill.closedPnl, 'userFills[].closedPnl'),
      oid: String(asInteger(fill.oid, 'userFills[].oid')),
      cloid: typeof fill.cloid === 'string' ? (fill.cloid.toLowerCase() as `0x${string}`) : null,
      tid,
      crossed: fill.crossed === true,
    },
  };
}

/**
 * Fills of the account since `sinceMs`, oldest first, all coins. Hyperliquid
 * only serves the 10 000 most recent fills of an account through this request.
 */
export async function fetchUserFills(transport: Transport, user: string, sinceMs: number): Promise<Fill[]> {
  const account = normalizeUser(user);
  requireSince(sinceMs);
  return collect(
    (startTime) => postInfo(transport, { type: 'userFillsByTime', user: account, startTime, aggregateByTime: false }),
    parseFill,
    sinceMs,
    FILLS_PAGE,
  );
}

/**
 * Trailing mean of the hourly funding rate of `coin`, annualised, in bps;
 * positive when shorts are paid. Throws when Hyperliquid has no recent sample,
 * so missing data cannot pass for a harmless rate.
 */
export async function fetchFundingAprBps(transport: Transport, coin: string, hours: number): Promise<number> {
  if (!Number.isFinite(hours) || hours <= 0) {
    throw new HyperliquidError('INVALID_ARGUMENT', `hours must be a positive number, got ${hours}`);
  }
  const now = transport.now();
  const samples = await collect(
    (startTime) => postInfo(transport, { type: 'fundingHistory', coin, startTime }),
    (row) => {
      const entry = asRecord(row, 'fundingHistory[]');
      const time = asInteger(entry.time, 'fundingHistory[].time');
      return { key: String(time), time, row: { time, rate: asDecimal(entry.fundingRate, 'fundingHistory[].fundingRate') } };
    },
    Math.floor(now - hours * HOUR_MS),
    FUNDING_PAGE,
  );

  const newest = samples.at(-1);
  if (newest === undefined || now - newest.time > MAX_FUNDING_SAMPLE_AGE_MS) {
    throw new HyperliquidResponseError(`no recent funding sample for ${coin} in the last ${hours} hours`);
  }
  return fundingAprFromHistory(samples.map((sample) => sample.rate));
}
