import type { Hex } from '@holdfast/core';
import type { Address, PublicClient } from 'viem';
import { hedgeAttestorAbi } from './abi';

/** The one thing these reads need from a viem client. */
export type ContractReader = Pick<PublicClient, 'readContract'>;

/**
 * One snapshot as the contract stores it, in HyperCore's own units. With
 * `szDecimals` the size precision of the perpetual (2 for ZEC):
 *
 *   size in coins   = szi / 10^szDecimals
 *   price in USD    = px / 10^(6 - szDecimals)
 *   notional in USD = szi * px / 10^6, whatever szDecimals is
 *
 * For ZEC one unit of `szi` is one lot, so a short of five lots reads -5.
 *
 * A snapshot shows one moment, and the attester chose it. It says nothing
 * about the time before, after or between snapshots.
 */
export interface HedgeSnapshot {
  /** Series of the team the snapshot belongs to, counted from zero. */
  series: bigint;
  /** Position of the snapshot in that series, counted from zero. */
  number: bigint;
  /** Index of the perpetual in HyperCore's universe. */
  perpIndex: number;
  /** Signed position size: negative is short, zero is flat. */
  szi: bigint;
  oraclePx: bigint;
  markPx: bigint;
  /** HyperCore block the position and prices were read at. */
  l1BlockNumber: bigint;
  /** Timestamp, in seconds, of the HyperEVM block that recorded the snapshot. */
  timestamp: bigint;
  /** Number of journal entries under `journalRoot`. */
  journalCount: bigint;
  journalRoot: Hex;
  treasuryCommitment: Hex;
}

/**
 * Where one series of a team stands. A team closes a series by starting the
 * next one; the closed series keeps its snapshots and takes no more.
 */
export interface SeriesState {
  series: bigint;
  snapshotCount: bigint;
  /** True for the series new snapshots go into. */
  current: boolean;
  /** When the team abandoned the series, in seconds; null while it is the current one. */
  endedAt: bigint | null;
}

async function seriesNumber(
  client: ContractReader,
  address: Address,
  user: Address,
  series: bigint | 'current',
): Promise<bigint> {
  if (series !== 'current') return series;
  return client.readContract({ address, abi: hedgeAttestorAbi, functionName: 'currentSeries', args: [user] });
}

/**
 * Read the state of a series of `user` from the HedgeAttestor at `address`:
 * the one with the given number, or the current one. Every series below the
 * current one has been abandoned, and `endedAt` says when.
 */
export async function readSeries(
  client: ContractReader,
  address: Address,
  user: Address,
  series: bigint | 'current',
): Promise<SeriesState> {
  const number = await seriesNumber(client, address, user, series);
  const [snapshotCount, endedAt] = await Promise.all([
    client.readContract({ address, abi: hedgeAttestorAbi, functionName: 'snapshotCount', args: [user, number] }),
    client.readContract({ address, abi: hedgeAttestorAbi, functionName: 'seriesEndedAt', args: [user, number] }),
  ]);
  // Block timestamps are never zero, so zero can only mean the series is still open.
  return { series: number, snapshotCount, current: endedAt === 0n, endedAt: endedAt === 0n ? null : endedAt };
}

/**
 * Read a snapshot of `user`: number `n` of a series, or the most recent one in
 * it. The series is given by number or as the current one. The contract
 * reverts when there is no such series or snapshot, and so does this.
 */
export async function readSnapshot(
  client: ContractReader,
  address: Address,
  user: Address,
  series: bigint | 'current',
  n: bigint | 'latest',
): Promise<HedgeSnapshot> {
  const inSeries = await seriesNumber(client, address, user, series);
  if (n === 'latest') {
    const [number, snapshot] = await client.readContract({
      address,
      abi: hedgeAttestorAbi,
      functionName: 'latestSnapshot',
      args: [user, inSeries],
    });
    return { series: inSeries, number, ...snapshot };
  }
  const snapshot = await client.readContract({
    address,
    abi: hedgeAttestorAbi,
    functionName: 'snapshot',
    args: [user, inSeries, n],
  });
  return { series: inSeries, number: n, ...snapshot };
}

/**
 * Ask the contract whether `leaf` with `proof` is under the journal root of
 * snapshot `n` in the given series of `user`. The series is always named: a
 * proof belongs to one snapshot of one series.
 *
 * The contract accepts any node of the journal tree, so the answer is about an
 * entry only when `leaf` was computed from that entry with `journalLeaf`.
 * `proofFor` gives the proof.
 */
export async function verifyOnChain(
  client: ContractReader,
  address: Address,
  user: Address,
  series: bigint,
  n: bigint,
  leaf: Hex,
  proof: readonly Hex[],
): Promise<boolean> {
  return client.readContract({
    address,
    abi: hedgeAttestorAbi,
    functionName: 'verifyEntry',
    args: [user, series, n, leaf, proof],
  });
}
