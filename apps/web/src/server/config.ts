import { parseMasterKey } from '@holdfast/db';
import { TOKENS, type TempoNetwork } from '@holdfast/tempo';
import { MAINNET_ENDPOINTS } from '@holdfast/zcash';
import { type Address, type Hex, getAddress, isAddress, isHex, size } from 'viem';
import { ConfigError } from './errors';

/** Which Zcash chain the treasuries are on and which Hyperliquid the hedges are on. */
export type HoldfastNetwork = 'mainnet' | 'testnet';
export type SolanaCluster = 'mainnet-beta' | 'devnet';

export interface TempoSettings {
  network: TempoNetwork;
  /** Undefined for the network's public RPC. */
  rpcUrl: string | undefined;
  /** The stablecoin payouts are made in. */
  token: Address;
  tokenSymbol: string;
}

export interface SolanaSettings {
  cluster: SolanaCluster;
  rpcUrl: string;
  /** Mint of the stablecoin payouts are made in. */
  mint: string;
  decimals: number;
  tokenSymbol: string;
  /**
   * The slot from which every payout of this service has set a run marker.
   * Only the operator can know it; without it the rail has to prove a run
   * unpaid from the paying account's history before it sends.
   */
  markersFrom: bigint | undefined;
}

/**
 * The deployment's settings. Every one is read, checked and remembered the
 * first time something asks for it, so a part of the application that does
 * not need a setting works without it, and one that does says which variable
 * is missing or malformed. Values never appear in the message.
 */
export interface Config {
  network(): HoldfastNetwork;
  databaseUrl(): string;
  masterKey(): Uint8Array;
  tickSecret(): string;
  sessionSecret(): Uint8Array;
  tempoSponsorPrivateKey(): Hex;
  zcashEndpoints(): string[];
  tempo(): TempoSettings;
  solana(): SolanaSettings;
  oneClickApiKey(): string | undefined;
  /** Every configured value that must not be shown or logged, as it was written. */
  secrets(): string[];
}

export type Env = Readonly<Record<string, string | undefined>>;

const MIN_SECRET_CHARACTERS = 32;

const SOLANA_RPC: Record<SolanaCluster, string> = {
  'mainnet-beta': 'https://api.mainnet-beta.solana.com',
  devnet: 'https://api.devnet.solana.com',
};

/** USDC as Circle issues it on each cluster. */
export const SOLANA_USDC: Record<SolanaCluster, string> = {
  'mainnet-beta': 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  devnet: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
};
const SOLANA_USDC_DECIMALS = 6;
const MAX_MINT_DECIMALS = 18;

const TEMPO_DEFAULT_TOKEN: Record<TempoNetwork, Address> = {
  mainnet: TOKENS.mainnet.USDCe,
  moderato: TOKENS.moderato.AlphaUSD,
};

const BASE58_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** Whether `text` has the shape of a Solana address. The rail does the full check when it uses one. */
export function looksLikeSolanaAddress(text: string): boolean {
  return BASE58_ADDRESS.test(text);
}

function once<T>(read: () => T): () => T {
  let known: { value: T } | undefined;
  return () => {
    known ??= { value: read() };
    return known.value;
  };
}

function tempoTokenSymbol(network: TempoNetwork, token: Address): string {
  const listed = Object.entries(TOKENS[network]).find(([, address]) => address.toLowerCase() === token.toLowerCase());
  if (listed === undefined) return token;
  return listed[0] === 'USDCe' ? 'USDC.e' : listed[0];
}

export function readConfig(env: Env): Config {
  const optional = (name: string): string | undefined => {
    const value = env[name]?.trim();
    return value === undefined || value === '' ? undefined : value;
  };
  const required = (name: string): string => {
    const value = optional(name);
    if (value === undefined) throw new ConfigError(name, 'is not set');
    return value;
  };
  const oneOf = <T extends string>(name: string, value: string, allowed: readonly T[]): T => {
    if (!(allowed as readonly string[]).includes(value)) throw new ConfigError(name, `must be one of: ${allowed.join(', ')}`);
    return value as T;
  };
  const url = (name: string, value: string, protocols: readonly string[]): string => {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      throw new ConfigError(name, 'is not a URL');
    }
    if (!protocols.includes(parsed.protocol)) throw new ConfigError(name, `must be a ${protocols.map((p) => `${p}//`).join(' or ')} URL`);
    return value;
  };
  const longSecret = (name: string): string => {
    const value = required(name);
    if (value.length < MIN_SECRET_CHARACTERS) throw new ConfigError(name, `must be at least ${MIN_SECRET_CHARACTERS} characters`);
    return value;
  };

  const network = once(() => oneOf<HoldfastNetwork>('HOLDFAST_NETWORK', required('HOLDFAST_NETWORK'), ['mainnet', 'testnet']));

  return {
    network,

    databaseUrl: once(() => url('DATABASE_URL', required('DATABASE_URL'), ['postgres:', 'postgresql:'])),

    masterKey: once(() => {
      const text = required('HOLDFAST_MASTER_KEY');
      try {
        return parseMasterKey(text);
      } catch {
        throw new ConfigError('HOLDFAST_MASTER_KEY', 'must be 32 bytes, written as 64 hex characters or as base64');
      }
    }),

    tickSecret: once(() => longSecret('TICK_SECRET')),

    sessionSecret: once(() => new TextEncoder().encode(longSecret('SESSION_SECRET'))),

    tempoSponsorPrivateKey: once(() => {
      const value = required('TEMPO_SPONSOR_PRIVATE_KEY');
      if (!isHex(value) || size(value) !== 32) {
        throw new ConfigError('TEMPO_SPONSOR_PRIVATE_KEY', 'must be a 32-byte private key written as 0x and 64 hex characters');
      }
      return value;
    }),

    zcashEndpoints: once(() => {
      const listed = optional('ZCASH_ENDPOINTS');
      if (listed === undefined) {
        if (network() === 'mainnet') return [...MAINNET_ENDPOINTS];
        throw new ConfigError('ZCASH_ENDPOINTS', 'is not set, and no public lightwalletd endpoint is known for testnet');
      }
      const endpoints = listed
        .split(',')
        .map((endpoint) => endpoint.trim())
        .filter((endpoint) => endpoint !== '');
      if (endpoints.length === 0) throw new ConfigError('ZCASH_ENDPOINTS', 'lists no endpoint');
      return endpoints.map((endpoint) => url('ZCASH_ENDPOINTS', endpoint, ['https:', 'http:']));
    }),

    tempo: once(() => {
      const chosen = optional('TEMPO_NETWORK');
      const tempoNetwork = chosen === undefined ? (network() === 'mainnet' ? 'mainnet' : 'moderato') : oneOf<TempoNetwork>('TEMPO_NETWORK', chosen, ['mainnet', 'moderato']);
      const rpcUrl = optional('TEMPO_RPC_URL');
      const tokenText = optional('TEMPO_TOKEN');
      if (tokenText !== undefined && !isAddress(tokenText)) throw new ConfigError('TEMPO_TOKEN', 'is not a token address');
      const token = tokenText === undefined ? TEMPO_DEFAULT_TOKEN[tempoNetwork] : getAddress(tokenText);
      return {
        network: tempoNetwork,
        rpcUrl: rpcUrl === undefined ? undefined : url('TEMPO_RPC_URL', rpcUrl, ['https:', 'http:']),
        token: getAddress(token),
        tokenSymbol: tempoTokenSymbol(tempoNetwork, token),
      };
    }),

    solana: once(() => {
      const chosen = optional('SOLANA_CLUSTER');
      const cluster = chosen === undefined ? (network() === 'mainnet' ? 'mainnet-beta' : 'devnet') : oneOf<SolanaCluster>('SOLANA_CLUSTER', chosen, ['mainnet-beta', 'devnet']);
      const rpcUrl = optional('SOLANA_RPC_URL');
      const mint = optional('SOLANA_MINT');
      if (mint !== undefined && !looksLikeSolanaAddress(mint)) throw new ConfigError('SOLANA_MINT', 'is not a mint address');
      const decimalsText = optional('SOLANA_MINT_DECIMALS');
      const decimals = decimalsText === undefined ? SOLANA_USDC_DECIMALS : Number(decimalsText);
      if (!Number.isInteger(decimals) || decimals < 0 || decimals > MAX_MINT_DECIMALS) {
        throw new ConfigError('SOLANA_MINT_DECIMALS', `must be a whole number from 0 to ${MAX_MINT_DECIMALS}`);
      }
      const markersFrom = optional('SOLANA_MARKERS_FROM');
      if (markersFrom !== undefined && !/^\d+$/.test(markersFrom)) throw new ConfigError('SOLANA_MARKERS_FROM', 'must be a slot number');
      const known = mint === undefined || Object.values(SOLANA_USDC).includes(mint);
      return {
        cluster,
        rpcUrl: rpcUrl === undefined ? SOLANA_RPC[cluster] : url('SOLANA_RPC_URL', rpcUrl, ['https:', 'http:']),
        mint: mint ?? SOLANA_USDC[cluster],
        decimals,
        tokenSymbol: known ? 'USDC' : (mint ?? 'USDC'),
        markersFrom: markersFrom === undefined ? undefined : BigInt(markersFrom),
      };
    }),

    oneClickApiKey: once(() => optional('ONECLICK_API_KEY')),

    secrets: () =>
      ['DATABASE_URL', 'HOLDFAST_MASTER_KEY', 'TICK_SECRET', 'SESSION_SECRET', 'TEMPO_SPONSOR_PRIVATE_KEY', 'ONECLICK_API_KEY', 'TEMPO_RPC_URL', 'SOLANA_RPC_URL']
        .map((name) => optional(name))
        .filter((value): value is string => value !== undefined),
  };
}
