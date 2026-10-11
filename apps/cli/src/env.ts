import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { FundingPayment, HedgeFill } from '@holdfast/books';
import type { Bar, TreasuryScanner } from '@holdfast/core';

/** The reads `verify` makes on Hyperliquid; none of them needs a key. */
export interface VenueReader {
  state(user: string): Promise<{ shortLots: number }>;
  userFills(user: string, sinceMs: number): Promise<HedgeFill[]>;
  userFunding(user: string, sinceMs: number): Promise<FundingPayment[]>;
}

/** What a viewing key says about itself, or why it is not one. */
export type KeyDescription = { ok: true; network: 'mainnet' | 'testnet'; address: string } | { ok: false; error: string };

/**
 * Everything that reaches outside the process, so that it can be replaced.
 * `verify` only ever looks at Zcash and Hyperliquid mainnet: which chain a
 * statement is held against is not something the statement gets to choose.
 */
export interface Sources {
  /** Worked out from the key alone: the network it belongs to and the address it receives on. */
  describeKey(ufvk: string): Promise<KeyDescription>;
  zcash(endpoints: readonly string[]): Promise<TreasuryScanner>;
  hyperliquid(): Promise<VenueReader>;
}

/** What a command needs from the outside world. */
export interface Env {
  out(line: string): void;
  err(line: string): void;
  readFile(path: string): Promise<string>;
  now(): number;
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
  async describeKey(ufvk) {
    const { checkUfvk } = await import('@holdfast/zcash');
    const checked = checkUfvk(ufvk, ufvk.startsWith('uviewtest1') ? 'testnet' : 'mainnet');
    return checked.ok ? { ok: true, network: checked.network, address: checked.address } : { ok: false, error: checked.error };
  },
  async zcash(endpoints) {
    const { createTreasuryScanner, MAINNET_ENDPOINTS } = await import('@holdfast/zcash');
    return createTreasuryScanner({ network: 'mainnet', endpoints: endpoints.length > 0 ? [...endpoints] : MAINNET_ENDPOINTS });
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
    now: Date.now,
    loadBars: bundledBars,
    sources: liveSources,
  };
}
