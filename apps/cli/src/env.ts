import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { FundingPayment, HedgeFill, PublishedOrg } from '@holdfast/books';
import type { Bar, TreasuryScanner } from '@holdfast/core';

/** The reads `verify` makes on Hyperliquid; none of them needs a key. */
export interface VenueReader {
  state(user: string): Promise<{ shortLots: number }>;
  userFills(user: string, sinceMs: number): Promise<HedgeFill[]>;
  userFunding(user: string, sinceMs: number): Promise<FundingPayment[]>;
}

/** Everything that reaches the network, so that it can be replaced. */
export interface Sources {
  zcash(network: PublishedOrg['zcash']['network'], endpoints: readonly string[]): Promise<TreasuryScanner>;
  hyperliquid(): Promise<VenueReader>;
}

/** What a command needs from the outside world. */
export interface Env {
  out(line: string): void;
  err(line: string): void;
  readFile(path: string): Promise<string>;
  /** The hourly ZEC history the scenarios are graded on. */
  loadBars(): Promise<Bar[]>;
  sources: Sources;
}

/** The market data ships inside the core package, beside its sources. */
async function bundledBars(): Promise<Bar[]> {
  const core = createRequire(import.meta.url).resolve('@holdfast/core');
  const file = join(dirname(core), '..', 'data', 'zec-1h.json');
  return (JSON.parse(await readFile(file, 'utf8')) as { bars: Bar[] }).bars;
}

/**
 * The chain adapters are loaded only when a command is about to use them:
 * the Zcash one brings a native scanner with it, and nothing offline should
 * have to load that.
 */
const liveSources: Sources = {
  async zcash(network, endpoints) {
    const { createTreasuryScanner, MAINNET_ENDPOINTS } = await import('@holdfast/zcash');
    const known = endpoints.length > 0 ? endpoints : network === 'mainnet' ? MAINNET_ENDPOINTS : [];
    if (known.length === 0) throw new Error(`no lightwalletd endpoint is known for ${network}; name one with --zcash-endpoint`);
    return createTreasuryScanner({ network, endpoints: [...known] });
  },
  async hyperliquid() {
    const { createHedgeVenue } = await import('@holdfast/hyperliquid');
    return createHedgeVenue({ network: 'mainnet' });
  },
};

export function nodeEnv(): Env {
  return {
    out: (line) => void process.stdout.write(`${line}\n`),
    err: (line) => void process.stderr.write(`${line}\n`),
    readFile: (path) => readFile(path, 'utf8'),
    loadBars: bundledBars,
    sources: liveSources,
  };
}
