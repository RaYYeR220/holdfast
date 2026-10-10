import { type Address, type Hex, getAddress, isAddress, isHex, maxUint256, size } from 'viem';
import { privateKeyToAddress } from 'viem/accounts';
import { accessKeyAddressOf } from './authorization';
import { NETWORKS, type TempoNetwork } from './networks';
import type { TempoRailConfig } from './types';

/**
 * The nonce lane payouts use by default: the ASCII bytes of "HOLDFAST".
 * Tempo accounts have independent nonce sequences per lane, so payouts never
 * contend with whatever else the account signs on lane 0. One rail instance
 * should be the only writer on its lane.
 */
export const DEFAULT_NONCE_KEY = 0x484f4c4446415354n;

/**
 * About a week of Moderato blocks; public RPCs answer `eth_getLogs` for 100k
 * blocks at a time. A run that was paid longer ago than this is not found, so
 * a run id must not be retried after the window unless the caller's own
 * records say it is unpaid.
 */
export const DEFAULT_LOOKBACK_BLOCKS = 1_000_000n;

export class TempoRailError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TempoRailError';
  }
}

export interface RailSettings {
  network: TempoNetwork;
  chainId: number;
  rpcUrl: string | null;
  token: Address;
  feeToken: Address;
  nonceKey: bigint;
  lookbackBlocks: bigint;
  accessKeyPrivateKey: Hex;
  sponsorPrivateKey: Hex;
  accessKey: Address;
  sponsor: Address;
}

function privateKey(value: string, name: string): Hex {
  if (!isHex(value) || size(value) !== 32) throw new TempoRailError(`${name} must be a 32-byte hex private key`);
  return value;
}

function address(value: string, name: string): Address {
  if (!isAddress(value)) throw new TempoRailError(`${name} "${value}" is not a valid address`);
  return getAddress(value);
}

export function resolveConfig(config: TempoRailConfig): RailSettings {
  const network = NETWORKS[config.network];
  if (!network) throw new TempoRailError(`unknown network "${String(config.network)}"`);
  const nonceKey = config.nonceKey ?? DEFAULT_NONCE_KEY;
  // Lane 0 is the account's ordinary nonce; the top lane is reserved for expiring nonces.
  if (nonceKey <= 0n || nonceKey >= maxUint256) throw new TempoRailError('nonceKey must name a dedicated lane: greater than 0 and below 2^256 - 1');
  const lookbackBlocks = config.lookbackBlocks ?? DEFAULT_LOOKBACK_BLOCKS;
  if (lookbackBlocks <= 0n) throw new TempoRailError('lookbackBlocks must be positive');
  const accessKeyPrivateKey = privateKey(config.accessKeyPrivateKey, 'accessKeyPrivateKey');
  const sponsorPrivateKey = privateKey(config.sponsorPrivateKey, 'sponsorPrivateKey');
  const token = address(config.token, 'token');
  return {
    network: config.network,
    chainId: network.chainId,
    rpcUrl: config.rpcUrl ?? null,
    token,
    feeToken: config.feeToken === undefined ? token : address(config.feeToken, 'feeToken'),
    nonceKey,
    lookbackBlocks,
    accessKeyPrivateKey,
    sponsorPrivateKey,
    accessKey: accessKeyAddressOf(accessKeyPrivateKey),
    sponsor: privateKeyToAddress(sponsorPrivateKey),
  };
}
