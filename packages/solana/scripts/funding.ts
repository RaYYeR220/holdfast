import { spawnSync } from 'node:child_process';
import {
  isSolanaError,
  lamports,
  SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR,
  type Address,
  type KeyPairSigner,
} from '@solana/kit';
import { getTransferSolInstruction } from '@solana-program/system';
import { sleep } from '../src/confirm';
import type { SolanaRpc } from '../src/connection';
import { submit } from './chain';

/**
 * One proof costs the owner the rent of a mint and a token account and the
 * delegate the rent of three payee token accounts, a few thousandths of a
 * SOL each at most; fees are a rounding error next to rent. This covers a
 * few runs.
 */
export const MIN_BALANCE = 20_000_000n;
/** Kept small: a faucet that is nearly dry still serves small requests. */
const AIRDROP = 100_000_000n;
const AIRDROP_SOL = '0.1';
const TOP_UP = 30_000_000n;
/** Covers one key's own needs and a top-up for the other. */
const MANUAL_FUNDING_SOL = '0.1';
const RPC_AIRDROP_BACKOFF_MS = [0, 3_000, 8_000, 20_000];

export interface FundingRecord {
  address: string;
  method: 'already funded' | 'rpc airdrop' | 'solana cli airdrop' | 'transfer between proof keys';
  signature: string | null;
  /** What was tried and refused before something worked. */
  refusals: string[];
}

export class FundingError extends Error {
  constructor(
    readonly addresses: string[],
    readonly refusals: string[],
  ) {
    super(
      `no faucet would fund the proof keys. Send ${MANUAL_FUNDING_SOL} devnet SOL to ${addresses[0]} ` +
        '(one funded key is enough, it tops up the others) and run the proof again; it reuses these keys.',
    );
  }
}

async function balanceOf(rpc: SolanaRpc, address: Address): Promise<bigint> {
  return (await rpc.getBalance(address, { commitment: 'confirmed' }).send()).value;
}

async function waitForBalance(rpc: SolanaRpc, address: Address, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await balanceOf(rpc, address)) >= MIN_BALANCE) return true;
    await sleep(2_000);
  }
  return false;
}

/** A 429 that asks to come back in more than a minute is a quota, not a hiccup; retrying only burns time. */
function describeRefusal(error: unknown): { text: string; final: boolean } {
  if (isSolanaError(error, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR)) {
    const { statusCode, headers } = error.context;
    const retryAfter = Number(headers.get('retry-after') ?? 0);
    return {
      text: `HTTP ${statusCode}${retryAfter ? `, retry-after ${retryAfter}s` : ''}`,
      final: statusCode === 429 && retryAfter > 60,
    };
  }
  return { text: error instanceof Error ? error.message : String(error), final: false };
}

async function airdropOverRpc(rpc: SolanaRpc, address: Address, refusals: string[]): Promise<string | null> {
  for (const [attempt, delay] of RPC_AIRDROP_BACKOFF_MS.entries()) {
    await sleep(delay);
    try {
      const signature = await rpc.requestAirdrop(address, lamports(AIRDROP), { commitment: 'confirmed' }).send();
      if (await waitForBalance(rpc, address, 45_000)) return signature;
      refusals.push(`requestAirdrop attempt ${attempt + 1}: accepted as ${signature} but no SOL arrived`);
    } catch (error) {
      const refusal = describeRefusal(error);
      refusals.push(`requestAirdrop attempt ${attempt + 1}: ${refusal.text}`);
      if (refusal.final) break;
    }
  }
  return null;
}

async function airdropOverCli(rpc: SolanaRpc, rpcUrl: string, address: Address, refusals: string[]): Promise<boolean> {
  const result = spawnSync('solana', ['airdrop', AIRDROP_SOL, address, '--url', rpcUrl], {
    encoding: 'utf8',
    timeout: 90_000,
  });
  if (result.status === 0 && (await waitForBalance(rpc, address, 30_000))) return true;
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim().split('\n').at(-1) ?? '';
  refusals.push(`solana airdrop: ${result.error?.message ?? output}`);
  return false;
}

async function airdrop(
  rpc: SolanaRpc,
  rpcUrl: string,
  address: Address,
  refusals: string[],
): Promise<FundingRecord | null> {
  const signature = await airdropOverRpc(rpc, address, refusals);
  if (signature) return { address, method: 'rpc airdrop', signature, refusals };
  if (await airdropOverCli(rpc, rpcUrl, address, refusals)) {
    return { address, method: 'solana cli airdrop', signature: null, refusals };
  }
  return null;
}

/** Top a key up from another proof key that has SOL to spare, if there is one. */
async function topUp(
  rpc: SolanaRpc,
  keys: KeyPairSigner[],
  key: KeyPairSigner,
  refusals: string[],
): Promise<FundingRecord | null> {
  for (const donor of keys) {
    if (donor === key || (await balanceOf(rpc, donor.address)) < MIN_BALANCE + TOP_UP) continue;
    const signature = await submit(rpc, donor, [
      getTransferSolInstruction({ source: donor, destination: key.address, amount: TOP_UP }),
    ]);
    return { address: key.address, method: 'transfer between proof keys', signature, refusals };
  }
  return null;
}

/**
 * Get SOL to every key. Faucets hand out very little per caller, so a key is
 * topped up from another proof key whenever one has SOL to spare, and a
 * faucet is only asked when none does: first the RPC faucet with backoff,
 * then the Solana CLI.
 */
export async function fundAll(rpc: SolanaRpc, rpcUrl: string, keys: KeyPairSigner[]): Promise<FundingRecord[]> {
  const records = new Map<KeyPairSigner, FundingRecord>();
  const refusals = new Map<KeyPairSigner, string[]>();
  for (const key of keys) {
    if ((await balanceOf(rpc, key.address)) >= MIN_BALANCE) {
      records.set(key, { address: key.address, method: 'already funded', signature: null, refusals: [] });
      continue;
    }
    const refused: string[] = [];
    const record = (await topUp(rpc, keys, key, refused)) ?? (await airdrop(rpc, rpcUrl, key.address, refused));
    if (record) records.set(key, record);
    else refusals.set(key, refused);
  }
  // A key that came up empty may be helped by one that was funded after it.
  for (const [key, refused] of refusals) {
    const record = await topUp(rpc, keys, key, refused);
    if (!record) {
      throw new FundingError(
        keys.map(candidate => candidate.address),
        [...refusals.values()].flat(),
      );
    }
    records.set(key, record);
  }
  return keys.flatMap(key => records.get(key) ?? []);
}
