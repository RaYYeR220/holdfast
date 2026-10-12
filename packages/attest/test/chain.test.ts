import type { Hex } from '@holdfast/core';
import {
  type Address,
  createPublicClient,
  custom,
  decodeFunctionData,
  encodeErrorResult,
  encodeFunctionResult,
  isAddressEqual,
} from 'viem';
import { describe, expect, it } from 'vitest';
import {
  type HedgeSnapshot,
  attestationFor,
  commitTreasury,
  hedgeAttestorAbi,
  journalLeaf,
  proofFor,
  readSeries,
  readSnapshot,
  verifyOnChain,
} from '../src/index';
import { chainedJournal, contractVerifies, reforged } from './support';

const ATTESTOR: Address = '0x00000000000000000000000000000000000a77e5';
const TEAM: Address = '0xC7e7BAAFb0C822d0A934BbB2268F15A7eD8485bc';
const OTHER: Address = '0x3c71213434d56CC8ACDe9Fb1c6b3d4920e40E19A';
const SALT: Hex = `0x${'5a'.repeat(32)}`;
const CLOSED_AT = 1_791_689_000n;

type Stored = Omit<HedgeSnapshot, 'series' | 'number'>;

/**
 * A node that answers `eth_call` the way the contract's views do, for the
 * series of one team; the last series is the current one. Calls and answers
 * go through the real ABI encoding, so a mismatch between the ABI and what
 * these helpers expect shows up here.
 */
function nodeWith(seriesOfTeam: Stored[][]) {
  const calls: { to: Address; functionName: string }[] = [];
  const current = BigInt(seriesOfTeam.length - 1);

  function revert(data: Hex): never {
    throw Object.assign(new Error('execution reverted'), { code: 3, data });
  }

  /** Snapshots of one series, or the contract's refusal of a series the user has not reached. */
  function historyOf(user: Address, series: bigint): Stored[] {
    const history = isAddressEqual(user, TEAM) ? seriesOfTeam[Number(series)] : series === 0n ? [] : undefined;
    if (history === undefined) {
      revert(encodeErrorResult({ abi: hedgeAttestorAbi, errorName: 'UnknownSeries', args: [user, series] }));
    }
    return history;
  }

  function answer(to: Address, data: Hex): Hex {
    const call = decodeFunctionData({ abi: hedgeAttestorAbi, data });
    calls.push({ to, functionName: call.functionName });
    if (!isAddressEqual(to, ATTESTOR)) return '0x';

    if (call.functionName === 'currentSeries') {
      const [user] = call.args;
      const result = isAddressEqual(user, TEAM) ? current : 0n;
      return encodeFunctionResult({ abi: hedgeAttestorAbi, functionName: 'currentSeries', result });
    }
    if (call.functionName === 'snapshotCount') {
      const [user, series] = call.args;
      const result = BigInt(historyOf(user, series).length);
      return encodeFunctionResult({ abi: hedgeAttestorAbi, functionName: 'snapshotCount', result });
    }
    if (call.functionName === 'seriesEndedAt') {
      const [user, series] = call.args;
      historyOf(user, series);
      const result = isAddressEqual(user, TEAM) && series < current ? CLOSED_AT + series : 0n;
      return encodeFunctionResult({ abi: hedgeAttestorAbi, functionName: 'seriesEndedAt', result });
    }
    if (call.functionName === 'snapshot' || call.functionName === 'verifyEntry') {
      const [user, series, number] = call.args;
      const snapshot = historyOf(user, series)[Number(number)];
      if (snapshot === undefined) {
        revert(encodeErrorResult({ abi: hedgeAttestorAbi, errorName: 'UnknownSnapshot', args: [user, series, number] }));
      }
      if (call.functionName === 'snapshot') {
        return encodeFunctionResult({ abi: hedgeAttestorAbi, functionName: 'snapshot', result: snapshot });
      }
      const [, , , leaf, proof] = call.args;
      return encodeFunctionResult({
        abi: hedgeAttestorAbi,
        functionName: 'verifyEntry',
        result: contractVerifies(snapshot.journalRoot, snapshot.journalCount, leaf, proof),
      });
    }
    if (call.functionName === 'latestSnapshot') {
      const [user, series] = call.args;
      const history = historyOf(user, series);
      const latest = history.at(-1);
      if (latest === undefined) {
        revert(encodeErrorResult({ abi: hedgeAttestorAbi, errorName: 'NoSnapshots', args: [user, series] }));
      }
      return encodeFunctionResult({
        abi: hedgeAttestorAbi,
        functionName: 'latestSnapshot',
        result: [BigInt(history.length - 1), latest],
      });
    }
    throw new Error(`unexpected call to ${call.functionName}`);
  }

  const client = createPublicClient({
    transport: custom(
      {
        async request({ method, params }: { method: string; params?: unknown }) {
          if (method !== 'eth_call') throw new Error(`unexpected RPC method ${method}`);
          const [call] = params as [{ to: Address; data: Hex }];
          return answer(call.to, call.data);
        },
      },
      { retryCount: 0 },
    ),
  });
  return { client, calls, names: () => calls.map((call) => call.functionName) };
}

const entries = chainedJournal(8);
/** The journal the abandoned series was committed to before it was rebuilt. */
const lost = chainedJournal(6).map((entry) => reforged(entry, { note: `${entry.note}, before the restore` }));
const lostEntry = lost[0] as (typeof lost)[number];

const base: Omit<Stored, 'journalRoot' | 'journalCount'> = {
  perpIndex: 214,
  szi: -1n,
  oraclePx: 12_347_810n,
  markPx: 12_339_000n,
  l1BlockNumber: 1_179_360_279n,
  timestamp: 1_791_685_480n,
  treasuryCommitment: commitTreasury(1_000_000n, SALT),
};

/**
 * Series 0 was abandoned after a snapshot that claimed more entries than any
 * journal holds. Series 1 is the current one: five entries, then eight.
 */
function series(): Stored[][] {
  const inflated: Stored = { ...base, journalRoot: `0x${'ee'.repeat(32)}`, journalCount: 2n ** 64n - 1n };
  return [
    [{ ...base, journalRoot: lostEntry.digest, journalCount: 1n }, inflated],
    [
      { ...base, ...attestationFor(entries.slice(0, 5)) },
      { ...base, szi: -5n, l1BlockNumber: 1_179_360_879n, timestamp: 1_791_689_540n, ...attestationFor(entries) },
    ],
  ];
}

describe('reading snapshots', () => {
  it('reads a snapshot by series and number', async () => {
    const node = nodeWith(series());
    const first = await readSnapshot(node.client, ATTESTOR, TEAM, 1n, 0n);

    expect(first).toEqual({ series: 1n, number: 0n, ...series()[1]?.[0] });
    expect(first.szi).toBe(-1n);
    expect(first.perpIndex).toBe(214);
    expect(first.journalCount).toBe(5n);
    expect(node.calls).toEqual([{ to: ATTESTOR, functionName: 'snapshot' }]);
  });

  it('reads the latest snapshot of the current series', async () => {
    const node = nodeWith(series());
    const latest = await readSnapshot(node.client, ATTESTOR, TEAM, 'current', 'latest');

    expect(latest).toEqual({ series: 1n, number: 1n, ...series()[1]?.[1] });
    expect(latest.szi).toBe(-5n);
    expect(node.names()).toEqual(['currentSeries', 'latestSnapshot']);
  });

  it('reads a numbered snapshot of the current series', async () => {
    const node = nodeWith(series());
    const first = await readSnapshot(node.client, ATTESTOR, TEAM, 'current', 0n);

    expect(first.series).toBe(1n);
    expect(first.journalCount).toBe(5n);
    expect(node.names()).toEqual(['currentSeries', 'snapshot']);
  });

  it('still reads the snapshots of an abandoned series', async () => {
    const node = nodeWith(series());

    expect((await readSnapshot(node.client, ATTESTOR, TEAM, 0n, 0n)).journalRoot).toBe(lostEntry.digest);
    const last = await readSnapshot(node.client, ATTESTOR, TEAM, 0n, 'latest');
    expect(last).toMatchObject({ series: 0n, number: 1n, journalCount: 2n ** 64n - 1n });
    expect(node.names()).toEqual(['snapshot', 'latestSnapshot']);
  });

  it('gives the notional of the hedge without knowing szDecimals', async () => {
    const node = nodeWith(series());
    const { szi, oraclePx } = await readSnapshot(node.client, ATTESTOR, TEAM, 1n, 0n);
    // 0.01 ZEC short at 1234.7810 dollars is 12.347810 dollars short.
    expect(Number(szi * oraclePx) / 1e6).toBe(-12.34781);
  });

  it('fails the way the contract does when there is no such series or snapshot', async () => {
    const node = nodeWith(series());
    await expect(readSnapshot(node.client, ATTESTOR, TEAM, 1n, 2n)).rejects.toThrow(/UnknownSnapshot/);
    await expect(readSnapshot(node.client, ATTESTOR, TEAM, 2n, 0n)).rejects.toThrow(/UnknownSeries/);
    await expect(readSnapshot(node.client, ATTESTOR, OTHER, 'current', 'latest')).rejects.toThrow(/NoSnapshots/);
  });

  it('fails when the address is not the contract', async () => {
    const node = nodeWith(series());
    await expect(readSnapshot(node.client, OTHER, TEAM, 0n, 0n)).rejects.toThrow();
  });
});

describe('reading series', () => {
  it('shows the current series as open', async () => {
    const node = nodeWith(series());

    expect(await readSeries(node.client, ATTESTOR, TEAM, 'current')).toEqual({
      series: 1n,
      snapshotCount: 2n,
      current: true,
      endedAt: null,
    });
    expect(node.names().sort()).toEqual(['currentSeries', 'seriesEndedAt', 'snapshotCount']);
  });

  it('shows that an earlier series was abandoned, and when', async () => {
    const node = nodeWith(series());

    expect(await readSeries(node.client, ATTESTOR, TEAM, 0n)).toEqual({
      series: 0n,
      snapshotCount: 2n,
      current: false,
      endedAt: CLOSED_AT,
    });
    expect(node.names()).not.toContain('currentSeries');
  });

  it('shows an account that never attested as an empty first series', async () => {
    const node = nodeWith(series());
    expect(await readSeries(node.client, ATTESTOR, OTHER, 'current')).toEqual({
      series: 0n,
      snapshotCount: 0n,
      current: true,
      endedAt: null,
    });
  });

  it('fails for a series the team has not reached', async () => {
    const node = nodeWith(series());
    await expect(readSeries(node.client, ATTESTOR, TEAM, 2n)).rejects.toThrow(/UnknownSeries/);
  });
});

describe('verifying an entry on chain', () => {
  it('accepts every entry the snapshot covers', async () => {
    const node = nodeWith(series());
    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index] as (typeof entries)[number];
      const proof = proofFor(entries, index);
      expect(await verifyOnChain(node.client, ATTESTOR, TEAM, 1n, 1n, journalLeaf(entry), proof)).toBe(true);
    }
  });

  it('checks against the journal as it was at that snapshot', async () => {
    const node = nodeWith(series());
    const prefix = entries.slice(0, 5);
    const early = entries[2] as (typeof entries)[number];
    const late = entries[6] as (typeof entries)[number];

    expect(await verifyOnChain(node.client, ATTESTOR, TEAM, 1n, 0n, journalLeaf(early), proofFor(prefix, 2))).toBe(true);
    // The proof against the longer journal does not fit the earlier root, and a later entry is not under it.
    expect(await verifyOnChain(node.client, ATTESTOR, TEAM, 1n, 0n, journalLeaf(early), proofFor(entries, 2))).toBe(false);
    expect(await verifyOnChain(node.client, ATTESTOR, TEAM, 1n, 0n, journalLeaf(late), proofFor(entries, 6))).toBe(false);
  });

  it('keeps verifying against a snapshot of an abandoned series, and only against that series', async () => {
    const node = nodeWith(series());
    const first = entries[0] as (typeof entries)[number];

    expect(await verifyOnChain(node.client, ATTESTOR, TEAM, 0n, 0n, journalLeaf(lostEntry), proofFor(lost.slice(0, 1), 0))).toBe(true);
    expect(await verifyOnChain(node.client, ATTESTOR, TEAM, 1n, 0n, journalLeaf(lostEntry), proofFor(lost.slice(0, 1), 0))).toBe(false);
    expect(await verifyOnChain(node.client, ATTESTOR, TEAM, 0n, 0n, journalLeaf(first), proofFor(entries.slice(0, 5), 0))).toBe(false);
  });

  it('rejects a tampered entry', async () => {
    const node = nodeWith(series());
    const target = entries[3] as (typeof entries)[number];
    const forged = reforged(target, { treasuryZat: 1n });

    expect(await verifyOnChain(node.client, ATTESTOR, TEAM, 1n, 1n, journalLeaf(forged), proofFor(entries, 3))).toBe(false);
  });

  it('fails when the series or the snapshot does not exist', async () => {
    const node = nodeWith(series());
    const target = entries[0] as (typeof entries)[number];
    const proof = proofFor(entries, 0);

    await expect(verifyOnChain(node.client, ATTESTOR, TEAM, 1n, 9n, journalLeaf(target), proof)).rejects.toThrow(/UnknownSnapshot/);
    await expect(verifyOnChain(node.client, ATTESTOR, TEAM, 4n, 0n, journalLeaf(target), proof)).rejects.toThrow(/UnknownSeries/);
  });
});
