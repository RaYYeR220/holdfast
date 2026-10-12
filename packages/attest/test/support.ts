import { DEFAULT_POLICY, type Hex, type OwnedNote, ZERO_ROOT, digest } from '@holdfast/core';
import { type JournalEntry, MemoryStore, type TickDeps, tick } from '@holdfast/engine';
import { concat, keccak256 } from 'viem';
import type { ChainedEntry } from '../src/index';

/**
 * `verifyEntry` of the contract, written out again from the Solidity: bytes32
 * values compare as unsigned 256-bit numbers, a pair is hashed smaller first,
 * and nothing is under the root of an empty journal.
 */
export function contractVerifies(journalRoot: Hex, journalCount: bigint, leaf: Hex, proof: readonly Hex[]): boolean {
  if (journalCount === 0n) return false;
  let node = leaf;
  for (const partner of proof) {
    node = BigInt(node) <= BigInt(partner) ? keccak256(concat([node, partner])) : keccak256(concat([partner, node]));
  }
  return node === journalRoot;
}

export interface TestEntry extends ChainedEntry {
  orgId: string;
  seq: number;
  at: number;
  treasuryZat: bigint;
  note: string;
}

/** A journal of `length` entries chained by the engine's rule, without running the engine. */
export function chainedJournal(length: number): TestEntry[] {
  const entries: TestEntry[] = [];
  let prev: Hex = ZERO_ROOT;
  for (let i = 0; i < length; i++) {
    const body = {
      orgId: 'org',
      seq: i + 1,
      at: 1_800_000_000_000 + i * 60_000,
      treasuryZat: 5_000_000n + BigInt(i),
      note: `tick ${i + 1}`,
    };
    const entry = { ...body, prev, digest: digest({ prev, body }) };
    entries.push(entry);
    prev = entry.digest;
  }
  return entries;
}

/** The same entry with its content changed and its digest brought up to date, as a forger would leave it. */
export function reforged(entry: TestEntry, change: Partial<Omit<TestEntry, 'prev' | 'digest'>>): TestEntry {
  const { prev, digest: _stale, ...body } = { ...entry, ...change };
  return { ...body, prev, digest: digest({ prev, body }) };
}

const BIRTHDAY = 3_512_000;
const PX = 1_223.3;

/** Journal entries written by the engine itself: `ticks` passes over one organisation with a funded treasury. */
export async function engineJournal(ticks: number): Promise<JournalEntry[]> {
  let clock = 1_800_000_000_000;
  const now = () => clock;
  const note: OwnedNote = {
    id: 'tx1:ironwood',
    txid: 'tx1',
    height: BIRTHDAY + 10,
    time: 0,
    zat: 5_000_000n,
    memo: '',
    pool: 'ironwood',
    kind: 'incoming',
    nullifier: 'nf1',
    spent: false,
  };
  let shortLots = 0;

  const store = new MemoryStore();
  store.addOrg({
    id: 'org',
    ufvk: 'uview1test',
    birthday: BIRTHDAY,
    hlUser: '0xabc',
    policy: DEFAULT_POLICY,
    lockEnabled: true,
  });
  const deps: TickDeps = {
    store,
    now,
    scanner: {
      tip: async () => BIRTHDAY + 100,
      scan: async ({ fromHeight, toHeight }) => ({
        notes: note.height >= fromHeight && note.height <= toHeight ? [note] : [],
        outgoing: [],
        fees: [],
        spentNullifiers: [],
      }),
    },
    venue: {
      state: async () => ({ asOf: now(), markPx: PX, oraclePx: PX, shortLots, accountValueUsd: 100 }),
      fundingAprBps: async () => 1_190,
      place: async (order) => {
        shortLots += order.side === 'sell' ? order.lots : -order.lots;
        return { ok: true, filledLots: order.lots, avgPx: order.limitPx, oid: `oid-${order.cloid}`, error: null };
      },
    },
    reference: { zecUsd: async () => ({ px: PX, asOf: now() }) },
  };

  for (let i = 0; i < ticks; i++) {
    clock += 60_000;
    const outcome = await tick('org', deps);
    if (!outcome.ran) throw new Error('tick did not run');
  }
  return store.journal('org');
}
