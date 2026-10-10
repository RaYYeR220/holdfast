import type { ReferencePrice } from '@holdfast/core';
import { ASSETS, ONECLICK_URL } from './oneclick';

/**
 * An independent ZEC/USD price to hold against the hedge venue's own oracle.
 * Several public sources are read together; the answer is their median, and
 * sources that disagree are treated as no answer at all.
 */
export interface PriceSource {
  name: string;
  read(doFetch: typeof fetch, now: () => number): Promise<{ px: number; asOf: number }>;
}

export class ReferencePriceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReferencePriceError';
  }
}

async function json(doFetch: typeof fetch, url: string): Promise<unknown> {
  const res = await doFetch(url, { headers: { accept: 'application/json', 'user-agent': 'holdfast' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function price(v: unknown): number {
  const n = typeof v === 'string' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) throw new Error('no usable price');
  return n;
}

export const coinbase: PriceSource = {
  name: 'coinbase',
  async read(doFetch) {
    const b = (await json(doFetch, 'https://api.exchange.coinbase.com/products/ZEC-USD/ticker')) as {
      price?: unknown;
      time?: unknown;
    };
    const asOf = typeof b.time === 'string' ? Date.parse(b.time) : Number.NaN;
    if (Number.isNaN(asOf)) throw new Error('no timestamp');
    return { px: price(b.price), asOf };
  },
};

export const kraken: PriceSource = {
  name: 'kraken',
  async read(doFetch, now) {
    const requested = now();
    const b = (await json(doFetch, 'https://api.kraken.com/0/public/Ticker?pair=ZECUSD')) as {
      error?: unknown[];
      result?: Record<string, { c?: unknown[] }>;
    };
    if (Array.isArray(b.error) && b.error.length > 0) throw new Error(String(b.error[0]));
    const ticker = Object.values(b.result ?? {})[0];
    // The ticker carries no timestamp; the moment of asking is the oldest it can honestly be.
    return { px: price(ticker?.c?.[0]), asOf: requested };
  },
};

export const oneClickFeed: PriceSource = {
  name: '1click',
  async read(doFetch) {
    const tokens = (await json(doFetch, `${ONECLICK_URL}/v0/tokens`)) as {
      assetId?: unknown;
      price?: unknown;
      priceUpdatedAt?: unknown;
    }[];
    const zec = Array.isArray(tokens) ? tokens.find((t) => t.assetId === ASSETS.ZEC) : undefined;
    const asOf = typeof zec?.priceUpdatedAt === 'string' ? Date.parse(zec.priceUpdatedAt) : Number.NaN;
    if (zec === undefined || Number.isNaN(asOf)) throw new Error('ZEC is missing from the token list');
    return { px: price(zec.price), asOf };
  },
};

export const DEFAULT_SOURCES: PriceSource[] = [coinbase, kraken, oneClickFeed];

export interface ReferenceConfig {
  sources?: PriceSource[];
  /** Sources further apart than this are not believed. */
  maxSpreadBps?: number;
  /** How many sources must answer. */
  minSources?: number;
  timeoutMs?: number;
  fetch?: typeof fetch;
  now?: () => number;
}

export interface ReferenceReading {
  px: number;
  /** The oldest timestamp among the sources used. */
  asOf: number;
  sources: { name: string; px: number; asOf: number }[];
}

function median(sorted: number[]): number {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[mid] as number) : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

export function createReferencePrice(config: ReferenceConfig = {}): ReferencePrice & { read(): Promise<ReferenceReading> } {
  const sources = config.sources ?? DEFAULT_SOURCES;
  const maxSpreadBps = config.maxSpreadBps ?? 100;
  const minSources = config.minSources ?? 2;
  const timeoutMs = config.timeoutMs ?? 6_000;
  const doFetch = config.fetch ?? fetch;
  const now = config.now ?? Date.now;
  if (sources.length < minSources) throw new RangeError(`${minSources} price sources are required, ${sources.length} configured`);

  async function read(): Promise<ReferenceReading> {
    const settled = await Promise.allSettled(
      sources.map(async (s) => {
        const reading = await Promise.race([
          s.read(doFetch, now),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timed out')), timeoutMs)),
        ]);
        return { name: s.name, ...reading };
      }),
    );
    const answered = settled.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
    if (answered.length < minSources) {
      const failures = settled.flatMap((r, k) =>
        r.status === 'rejected' ? [`${sources[k]?.name}: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`] : [],
      );
      throw new ReferencePriceError(`only ${answered.length} of ${sources.length} price sources answered (${failures.join('; ')})`);
    }

    const prices = answered.map((a) => a.px).sort((a, b) => a - b);
    const low = prices[0] as number;
    const high = prices[prices.length - 1] as number;
    const spreadBps = ((high - low) / low) * 10_000;
    if (spreadBps > maxSpreadBps) {
      throw new ReferencePriceError(
        `price sources disagree by ${spreadBps.toFixed(0)} bps: ${answered.map((a) => `${a.name} ${a.px}`).join(', ')}`,
      );
    }
    return { px: median(prices), asOf: Math.min(...answered.map((a) => a.asOf)), sources: answered };
  }

  return {
    read,
    async zecUsd() {
      const { px, asOf } = await read();
      return { px, asOf };
    },
  };
}
