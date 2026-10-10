import { describe, expect, it } from 'vitest';
import { type PriceSource, ReferencePriceError, coinbase, createReferencePrice, kraken, oneClickFeed } from '../src/reference';

const NOW = 1_791_635_000_000;
const now = () => NOW;

const fixed = (name: string, px: number, ageMs = 1_000): PriceSource => ({
  name,
  read: async () => ({ px, asOf: NOW - ageMs }),
});
const broken = (name: string, why = 'HTTP 503'): PriceSource => ({
  name,
  read: async () => {
    throw new Error(why);
  },
});
const hung = (name: string): PriceSource => ({ name, read: () => new Promise(() => {}) });

describe('reference price', () => {
  it('takes the median of the sources that answered', async () => {
    const ref = createReferencePrice({ sources: [fixed('a', 1227.4), fixed('b', 1227.8), fixed('c', 1225.7)], now });
    expect((await ref.zecUsd()).px).toBe(1227.4);
    const two = createReferencePrice({ sources: [fixed('a', 1227), fixed('b', 1229)], now });
    expect((await two.zecUsd()).px).toBe(1228);
  });

  it('dates the reading by its oldest source', async () => {
    const ref = createReferencePrice({ sources: [fixed('a', 1227, 500), fixed('b', 1227, 40_000)], now });
    expect((await ref.zecUsd()).asOf).toBe(NOW - 40_000);
  });

  it('works with one source down', async () => {
    const ref = createReferencePrice({ sources: [fixed('a', 1227), broken('b'), fixed('c', 1228)], now });
    const r = await ref.read();
    expect(r.px).toBe(1227.5);
    expect(r.sources.map((s) => s.name)).toEqual(['a', 'c']);
  });

  it('gives no answer when too few sources respond', async () => {
    const ref = createReferencePrice({ sources: [fixed('a', 1227), broken('b'), broken('c', 'no timestamp')], now });
    const failure = await ref.zecUsd().catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ReferencePriceError);
    expect((failure as Error).message).toMatch(/only 1 of 3 price sources answered \(b: HTTP 503; c: no timestamp\)/);
  });

  it('gives no answer when the sources disagree', async () => {
    const ref = createReferencePrice({ sources: [fixed('a', 1227), fixed('b', 1260)], now });
    await expect(ref.zecUsd()).rejects.toThrow(/disagree by 269 bps: a 1227, b 1260/);
  });

  it('does not wait for a source that never answers', async () => {
    const ref = createReferencePrice({ sources: [fixed('a', 1227), hung('b'), fixed('c', 1228)], timeoutMs: 20, now });
    expect((await ref.zecUsd()).px).toBe(1227.5);
  });

  it('refuses to be configured with fewer sources than it requires', () => {
    expect(() => createReferencePrice({ sources: [fixed('a', 1227)] })).toThrow(/2 price sources are required/);
    expect(createReferencePrice({ sources: [fixed('a', 1227)], minSources: 1 })).toBeDefined();
  });
});

describe('price sources', () => {
  const serve = (body: unknown, status = 200) =>
    (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

  it('reads the Coinbase ticker with its own timestamp', async () => {
    const body = { ask: '1227.74', bid: '1227.4', price: '1227.37', time: '2026-10-10T12:29:56.027124848Z' };
    expect(await coinbase.read(serve(body), now)).toEqual({ px: 1227.37, asOf: Date.parse('2026-10-10T12:29:56.027Z') });
  });

  it('reads the Kraken ticker and dates it by the request', async () => {
    const body = { error: [], result: { XZECZUSD: { c: ['1227.76000', '0.06275181'] } } };
    expect(await kraken.read(serve(body), now)).toEqual({ px: 1227.76, asOf: NOW });
  });

  it('reads ZEC from the 1Click token list', async () => {
    const body = [
      { assetId: 'nep141:wrap.near', price: 3.1, priceUpdatedAt: '2026-10-10T12:29:00.538Z' },
      { assetId: 'nep141:zec.omft.near', price: 1225.75, priceUpdatedAt: '2026-10-10T12:29:00.538Z' },
    ];
    expect(await oneClickFeed.read(serve(body), now)).toEqual({ px: 1225.75, asOf: Date.parse('2026-10-10T12:29:00.538Z') });
  });

  it('rejects answers without a usable price or timestamp', async () => {
    await expect(coinbase.read(serve({ price: '0', time: '2026-10-10T12:29:56Z' }), now)).rejects.toThrow();
    await expect(coinbase.read(serve({ price: '1227' }), now)).rejects.toThrow(/timestamp/);
    await expect(kraken.read(serve({ error: ['EQuery:Unknown asset pair'] }), now)).rejects.toThrow(/Unknown asset pair/);
    await expect(kraken.read(serve({ error: [], result: {} }), now)).rejects.toThrow();
    await expect(oneClickFeed.read(serve([]), now)).rejects.toThrow(/missing/);
    await expect(coinbase.read(serve({}, 500), now)).rejects.toThrow(/HTTP 500/);
  });
});
