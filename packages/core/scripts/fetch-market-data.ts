/**
 * Downloads hourly ZEC perp candles and funding from Hyperliquid's public
 * info API and writes them as one series for the backtest.
 *
 *   pnpm --filter @holdfast/core fetch-data [fromISO] [toISO]
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const API = 'https://api.hyperliquid.xyz/info';
const HOUR = 3_600_000;
const COIN = 'ZEC';

interface Candle { t: number; o: string; h: string; l: string; c: string }
interface Funding { time: number; fundingRate: string }

async function post<T>(body: unknown): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(API, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.ok) return (await res.json()) as T;
    if (attempt >= 4) throw new Error(`Hyperliquid info ${res.status}: ${await res.text()}`);
    await new Promise((r) => setTimeout(r, 1_000 * (attempt + 1)));
  }
}

async function candles(from: number, to: number): Promise<Candle[]> {
  const out = new Map<number, Candle>();
  let cursor = from;
  while (cursor < to) {
    const page = await post<Candle[]>({
      type: 'candleSnapshot',
      req: { coin: COIN, interval: '1h', startTime: cursor, endTime: to },
    });
    if (page.length === 0) break;
    for (const c of page) out.set(c.t, c);
    const last = page[page.length - 1] as Candle;
    if (last.t + HOUR <= cursor) break;
    cursor = last.t + HOUR;
  }
  return [...out.values()].sort((a, b) => a.t - b.t);
}

async function funding(from: number, to: number): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  let cursor = from;
  while (cursor < to) {
    const page = await post<Funding[]>({ type: 'fundingHistory', coin: COIN, startTime: cursor, endTime: to });
    if (page.length === 0) break;
    for (const f of page) out.set(Math.floor(f.time / HOUR) * HOUR, Number(f.fundingRate));
    const last = page[page.length - 1] as Funding;
    if (last.time + 1 <= cursor) break;
    cursor = last.time + 1;
  }
  return out;
}

const from = Date.parse(process.argv[2] ?? '2026-01-01T00:00:00Z');
const to = Date.parse(process.argv[3] ?? new Date().toISOString());

const [cs, fs] = await Promise.all([candles(from, to), funding(from, to)]);
const bars = cs.map((c) => ({
  t: c.t,
  o: Number(c.o),
  h: Number(c.h),
  l: Number(c.l),
  c: Number(c.c),
  // Funding is paid on the hour for the hour that just ended.
  fundingRate: fs.get(c.t + HOUR) ?? 0,
}));

const missing = bars.filter((b) => !fs.has(b.t + HOUR)).length;
const target = fileURLToPath(new URL('../data/zec-1h.json', import.meta.url));
writeFileSync(
  target,
  `${JSON.stringify({ coin: COIN, source: API, from: bars[0]?.t, to: bars.at(-1)?.t, bars })}\n`,
);
console.log(`${bars.length} bars, ${missing} without a funding print -> ${target}`);
