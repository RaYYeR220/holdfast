import { DEFAULT_POLICY, type Hex, type OutgoingPayment, type OwnedNote, ZERO_ROOT, type Zat, digest } from '@holdfast/core';
import { type JournalEntry, type OrderRecord, type ScanCommit, type Store, cloidFor, entryDigest, verifyChain } from '@holdfast/engine';
import { expect, it } from 'vitest';
import { BIRTHDAY, HIGH_HALF, LOW_HALF, NUL, PX, contend, note } from './support/fakes';
import { ORG } from './support/stores';

/** A store, and the few things a test has to do to it that the engine never does. */
export interface StoreUnderTest {
  store: Store;
  /** Register an organisation under a new id, or under the one given. */
  addOrg(id?: string): Promise<string>;
  notes(orgId: string): Promise<OwnedNote[]>;
  outgoing(orgId: string): Promise<OutgoingPayment[]>;
  untrackedBalance(orgId: string): Promise<Zat>;
  journal(orgId: string): Promise<JournalEntry[]>;
}

const T0 = 1_800_000_000_000;

const byId = <T extends { id: string }>(items: T[]): T[] => [...items].sort((a, b) => a.id.localeCompare(b.id));

export const scanOf = (from: number, to: number, over: Partial<ScanCommit> = {}): ScanCommit => ({
  from,
  to,
  tip: { height: to, since: T0 },
  notes: [],
  outgoing: [],
  fees: [],
  spentNullifiers: [],
  ...over,
});

export const payment = (height: number, zat: bigint, over: Partial<OutgoingPayment> = {}): OutgoingPayment => ({
  id: `tx${height}:out:${zat}`,
  txid: `tx${height}`,
  height,
  time: T0 + height,
  zat,
  memo: 'October payroll',
  pool: 'transparent',
  ...over,
});

export const orderOf = (orgId: string, seq: number): OrderRecord => ({
  seq,
  cloid: cloidFor(orgId, seq, 0),
  side: 'sell',
  lots: 5,
  limitPx: 1_219.6,
  reduceOnly: false,
  result: { ok: true, filledLots: 5, avgPx: 1_219.6, oid: 'oid-1', error: null },
});

/** An entry shaped and digested the way a tick writes one. */
export function entryOf(
  orgId: string,
  seq: number,
  prev: Hex,
  over: Partial<Omit<JournalEntry, 'orgId' | 'seq' | 'prev' | 'digest'>> = {},
): JournalEntry {
  const at = T0 + seq * 60_000;
  const body = {
    orgId,
    seq,
    at,
    snapshot: {
      now: at,
      treasury: { zat: 5_000_000n, asOf: at },
      hl: { asOf: at, markPx: PX, oraclePx: PX, shortLots: 5, accountValueUsd: 100, fundingAprBps: 1_190 },
      ref: { px: PX, asOf: at },
    },
    policyDigest: digest(DEFAULT_POLICY),
    decision: { mode: 'HOLD' as const, targetLots: 5, marginRatioBps: 16_349, actions: [], refusals: [], reasons: ['short matches the treasury'] },
    advisories: [],
    order: null,
    errors: [],
    scan: { from: BIRTHDAY, to: BIRTHDAY + 100, tip: BIRTHDAY + 100, caughtUp: true },
    ...over,
  };
  return { ...body, prev, digest: digest({ prev, body }) };
}

/**
 * What every store has to do, whatever it keeps its data in. The database
 * store is held to exactly what the in-memory one does.
 */
export function storeContract(makeStore: () => Promise<StoreUnderTest>): void {
  const setup = async () => {
    const under = await makeStore();
    return { ...under, org: await under.addOrg() };
  };

  it('starts an organisation at the beginning of its journal', async () => {
    const { store, org } = await setup();
    expect(await store.loadOrg(org)).toEqual({ id: org, ...ORG, scannedTo: null, tip: null, nextSeq: 1, lastDigest: ZERO_ROOT });
  });

  it('refuses a second organisation under the same id', async () => {
    const { addOrg, org } = await setup();
    await expect(addOrg(org)).rejects.toThrow(`organisation ${org} already exists`);
  });

  it('hands out a copy of the state, not the state', async () => {
    const { store, org } = await setup();
    const state = await store.loadOrg(org);
    state.policy.bandLots = 99;
    state.nextSeq = 7;
    expect(await store.loadOrg(org)).toMatchObject({ policy: DEFAULT_POLICY, nextSeq: 1 });
  });

  it('rejects an organisation it has never heard of', async () => {
    const { store } = await setup();
    const unknown = 'unknown organisation nobody';
    await expect(store.withOrgLock('nobody', async () => 1)).rejects.toThrow(unknown);
    await expect(store.loadOrg('nobody')).rejects.toThrow(unknown);
    await expect(store.commitScan('nobody', scanOf(BIRTHDAY, BIRTHDAY + 1))).rejects.toThrow(unknown);
    await expect(store.unspentNullifiers('nobody')).rejects.toThrow(unknown);
    await expect(store.trackedBalance('nobody')).rejects.toThrow(unknown);
    await expect(store.appendJournal(entryOf('nobody', 1, ZERO_ROOT))).rejects.toThrow(unknown);
  });

  it('lets one caller in and turns the second away', async () => {
    const { store, org } = await setup();
    let second: unknown;
    const first = await store.withOrgLock(org, async () => {
      second = await store.withOrgLock(org, async () => 'second');
      return 'first';
    });
    expect(first).toEqual({ ran: true, value: 'first' });
    expect(second).toEqual({ ran: false });
  });

  it('runs exactly one of two callers that arrive together', async () => {
    const { store, org } = await setup();
    let runs = 0;
    const outcomes = await contend(2, (hold) =>
      store.withOrgLock(org, async () => {
        runs += 1;
        await hold();
      }),
    );
    expect(outcomes.map((o) => o.ran).sort()).toEqual([false, true]);
    expect(runs).toBe(1);
  });

  it('frees the lock when the work is done', async () => {
    const { store, org } = await setup();
    await store.withOrgLock(org, async () => 1);
    expect(await store.withOrgLock(org, async () => 2)).toEqual({ ran: true, value: 2 });
  });

  it('frees the lock when the work throws, and passes the error on', async () => {
    const { store, org } = await setup();
    await expect(
      store.withOrgLock(org, async () => {
        throw new Error('venue timeout');
      }),
    ).rejects.toThrow('venue timeout');
    expect(await store.withOrgLock(org, async () => 2)).toEqual({ ran: true, value: 2 });
  });

  it('locks one organisation without holding up another', async () => {
    const { store, addOrg, org } = await setup();
    const other = await addOrg();
    const outcome = await store.withOrgLock(org, () => store.withOrgLock(other, async () => 'other'));
    expect(outcome).toEqual({ ran: true, value: { ran: true, value: 'other' } });
  });

  it('records a scanned range and how far the scan got', async () => {
    const { store, org, notes, outgoing } = await setup();
    const received = note(BIRTHDAY + 10, 3_000_000n, { memo: 'invoice 14' });
    const change = note(BIRTHDAY + 20, 2_000_000n, { kind: 'change', pool: 'orchard' });
    const paid = payment(BIRTHDAY + 20, 1_500_000n);
    await store.commitScan(
      org,
      scanOf(BIRTHDAY, BIRTHDAY + 100, { notes: [received, change], outgoing: [paid], tip: { height: BIRTHDAY + 140, since: T0 + 9 } }),
    );

    expect(byId(await notes(org))).toEqual(byId([received, change]));
    expect(await outgoing(org)).toEqual([paid]);
    expect(await store.loadOrg(org)).toMatchObject({ scannedTo: BIRTHDAY + 100, tip: { height: BIRTHDAY + 140, since: T0 + 9 } });
  });

  it('replaces what it held for a range that is scanned again', async () => {
    const { store, org, notes, outgoing } = await setup();
    const settled = note(BIRTHDAY + 10, 3_000_000n);
    const ghost = note(BIRTHDAY + 95, 2_000_000n);
    await store.commitScan(
      org,
      scanOf(BIRTHDAY, BIRTHDAY + 100, { notes: [settled, ghost], outgoing: [payment(BIRTHDAY + 96, 400_000n)] }),
    );

    const mined = note(BIRTHDAY + 97, 2_500_000n);
    await store.commitScan(org, scanOf(BIRTHDAY + 81, BIRTHDAY + 101, { notes: [mined] }));

    expect(byId(await notes(org))).toEqual(byId([settled, mined]));
    expect(await outgoing(org)).toEqual([]);
    expect(await store.trackedBalance(org)).toBe(5_500_000n);
    expect(await store.loadOrg(org)).toMatchObject({ scannedTo: BIRTHDAY + 101 });
  });

  it('counts both ends of the range as part of it', async () => {
    const { store, org, notes, outgoing } = await setup();
    const heights = [BIRTHDAY + 49, BIRTHDAY + 50, BIRTHDAY + 60, BIRTHDAY + 61];
    await store.commitScan(
      org,
      scanOf(BIRTHDAY, BIRTHDAY + 100, {
        notes: heights.map((h) => note(h, 1_000_000n)),
        outgoing: heights.map((h) => payment(h, 1_000n)),
      }),
    );
    await store.commitScan(org, scanOf(BIRTHDAY + 50, BIRTHDAY + 60));

    expect((await notes(org)).map((n) => n.height).sort()).toEqual([BIRTHDAY + 49, BIRTHDAY + 61]);
    expect((await outgoing(org)).map((o) => o.height).sort()).toEqual([BIRTHDAY + 49, BIRTHDAY + 61]);
  });

  it('keeps one copy of a note that comes back at another height', async () => {
    const { store, org, notes } = await setup();
    const before = note(BIRTHDAY + 10, 3_000_000n);
    await store.commitScan(org, scanOf(BIRTHDAY, BIRTHDAY + 50, { notes: [before] }));

    const after = { ...before, height: BIRTHDAY + 70 };
    await store.commitScan(org, scanOf(BIRTHDAY + 60, BIRTHDAY + 80, { notes: [after] }));

    expect(await notes(org)).toEqual([after]);
    expect(await store.trackedBalance(org)).toBe(3_000_000n);
  });

  it('keeps the last of two notes that share an id', async () => {
    const { store, org, notes } = await setup();
    const first = note(BIRTHDAY + 10, 3_000_000n);
    const last = { ...first, memo: 'seen again', zat: 4_000_000n };
    await store.commitScan(org, scanOf(BIRTHDAY, BIRTHDAY + 50, { notes: [first, last] }));
    expect(await notes(org)).toEqual([last]);
  });

  it('marks a known note spent wherever it was received', async () => {
    const { store, org, notes } = await setup();
    const kept = note(BIRTHDAY + 10, 3_000_000n);
    const spent = note(BIRTHDAY + 11, 2_000_000n);
    await store.commitScan(org, scanOf(BIRTHDAY, BIRTHDAY + 50, { notes: [kept, spent] }));
    expect((await store.unspentNullifiers(org)).sort()).toEqual([kept.nullifier, spent.nullifier].sort());

    await store.commitScan(org, scanOf(BIRTHDAY + 51, BIRTHDAY + 90, { spentNullifiers: [spent.nullifier ?? '', 'nf-of-someone-else'] }));

    expect(await store.unspentNullifiers(org)).toEqual([kept.nullifier]);
    expect(byId(await notes(org))).toEqual(byId([kept, { ...spent, spent: true }]));
    expect(await store.trackedBalance(org)).toBe(3_000_000n);
  });

  it('does not count a note that was spent within the scan that found it', async () => {
    const { store, org } = await setup();
    await store.commitScan(org, scanOf(BIRTHDAY, BIRTHDAY + 50, { notes: [note(BIRTHDAY + 10, 3_000_000n, { spent: true })] }));
    expect(await store.unspentNullifiers(org)).toEqual([]);
    expect(await store.trackedBalance(org)).toBe(0n);
  });

  it('believes the latest scan of a block about a spend', async () => {
    const { store, org } = await setup();
    const coin = note(BIRTHDAY + 10, 3_000_000n);
    await store.commitScan(org, scanOf(BIRTHDAY, BIRTHDAY + 50, { notes: [{ ...coin, spent: true }] }));
    await store.commitScan(org, scanOf(BIRTHDAY, BIRTHDAY + 50, { notes: [coin] }));
    expect(await store.unspentNullifiers(org)).toEqual([coin.nullifier]);
    expect(await store.trackedBalance(org)).toBe(3_000_000n);
  });

  it('keeps apart the notes whose spends it cannot follow', async () => {
    const { store, org, untrackedBalance } = await setup();
    const followed = note(BIRTHDAY + 10, 5_000_000n);
    const blind = note(BIRTHDAY + 11, 7_000_000n, { pool: 'sapling', nullifier: null });
    await store.commitScan(org, scanOf(BIRTHDAY, BIRTHDAY + 50, { notes: [followed, blind] }));

    expect(await store.trackedBalance(org)).toBe(5_000_000n);
    expect(await untrackedBalance(org)).toBe(7_000_000n);
    expect(await store.unspentNullifiers(org)).toEqual([followed.nullifier]);
  });

  it('holds nothing before the first scan', async () => {
    const { store, org, untrackedBalance, notes } = await setup();
    expect(await store.trackedBalance(org)).toBe(0n);
    expect(await untrackedBalance(org)).toBe(0n);
    expect(await store.unspentNullifiers(org)).toEqual([]);
    expect(await notes(org)).toEqual([]);
  });

  it('adds up amounts no double could hold', async () => {
    const { store, org, notes } = await setup();
    const huge = 9_007_199_254_740_993n;
    const coins = [note(BIRTHDAY + 10, huge), note(BIRTHDAY + 11, huge + 2n)];
    await store.commitScan(org, scanOf(BIRTHDAY, BIRTHDAY + 50, { notes: coins }));
    expect(await store.trackedBalance(org)).toBe(18_014_398_509_481_988n);
    expect(byId(await notes(org)).map((n) => n.zat)).toEqual(byId(coins).map((n) => n.zat));
  });

  it('keeps one organisation out of another', async () => {
    const { store, addOrg, org, notes } = await setup();
    const other = await addOrg();
    const coin = note(BIRTHDAY + 10, 3_000_000n);
    await store.commitScan(org, scanOf(BIRTHDAY, BIRTHDAY + 50, { notes: [coin] }));
    await store.commitScan(other, scanOf(BIRTHDAY, BIRTHDAY + 50, { notes: [coin], spentNullifiers: [coin.nullifier ?? ''] }));
    await store.appendJournal(entryOf(other, 1, ZERO_ROOT));

    expect(await notes(org)).toEqual([coin]);
    expect(await store.trackedBalance(org)).toBe(3_000_000n);
    expect(await store.trackedBalance(other)).toBe(0n);
    expect(await store.loadOrg(org)).toMatchObject({ nextSeq: 1, lastDigest: ZERO_ROOT });
  });

  it('appends entries in order and moves the organisation along', async () => {
    const { store, org, journal } = await setup();
    const first = entryOf(org, 1, ZERO_ROOT, { order: orderOf(org, 1) });
    await store.appendJournal(first);
    expect(await store.loadOrg(org)).toMatchObject({ nextSeq: 2, lastDigest: first.digest });

    const second = entryOf(org, 2, first.digest);
    await store.appendJournal(second);
    expect(await store.loadOrg(org)).toMatchObject({ nextSeq: 3, lastDigest: second.digest });

    const stored = await journal(org);
    expect(stored).toEqual([first, second]);
    expect(verifyChain(stored, ZERO_ROOT)).toEqual({ ok: true });
  });

  it('gives a journal entry back with the types it was written with', async () => {
    const { store, org, journal } = await setup();
    const written = entryOf(org, 1, ZERO_ROOT, {
      snapshot: { now: T0, treasury: { zat: 2_099_999_997_690_000n, asOf: T0 }, hl: null, ref: null },
      errors: [{ source: 'venue', message: '{"$bigint":"1"} is only text here' }],
    });
    await store.appendJournal(written);

    const [read] = await journal(org);
    expect(read).toEqual(written);
    expect(typeof read?.snapshot.treasury?.zat).toBe('bigint');
    expect(read === undefined ? null : entryDigest(read)).toBe(written.digest);
  });

  it('keeps every number of an entry exactly', async () => {
    const { store, org, journal } = await setup();
    const hl = { asOf: T0, markPx: 0.1 + 0.2, oraclePx: 1e21, shortLots: Number.MAX_SAFE_INTEGER, accountValueUsd: 1e-7, fundingAprBps: -1_190.000000000001 };
    const written = entryOf(org, 1, ZERO_ROOT, {
      snapshot: { now: T0, treasury: null, hl, ref: { px: Number.MAX_VALUE, asOf: 5e-324 } },
    });
    await store.appendJournal(written);

    const [read] = await journal(org);
    expect(read).toEqual(written);
    expect(read === undefined ? null : entryDigest(read)).toBe(written.digest);
  });

  it('keeps text a database would rather not hold', async () => {
    const { store, org, journal } = await setup();
    const written = entryOf(org, 1, ZERO_ROOT, {
      errors: [
        { source: 'venue', message: `a NUL ${NUL} in the answer` },
        { source: 'reference', message: `half a pair ${HIGH_HALF} and the other half ${LOW_HALF}` },
      ],
    });
    await store.appendJournal(written);

    const [read] = await journal(org);
    expect(read).toEqual(written);
    expect(read === undefined ? null : entryDigest(read)).toBe(written.digest);
  });

  it('refuses an entry that is out of sequence', async () => {
    const { store, org } = await setup();
    const first = entryOf(org, 1, ZERO_ROOT);
    await store.appendJournal(first);
    await expect(store.appendJournal(first)).rejects.toThrow('journal entry 1 is out of sequence, expected 2');
    await expect(store.appendJournal(entryOf(org, 3, first.digest))).rejects.toThrow('journal entry 3 is out of sequence, expected 2');
  });

  it('refuses an entry that does not follow the last one', async () => {
    const { store, org } = await setup();
    await store.appendJournal(entryOf(org, 1, ZERO_ROOT));
    await expect(store.appendJournal(entryOf(org, 2, ZERO_ROOT))).rejects.toThrow('journal entry 2 does not follow the last entry');
  });

  it('writes nothing when it refuses an entry', async () => {
    const { store, org, journal } = await setup();
    const first = entryOf(org, 1, ZERO_ROOT);
    await store.appendJournal(first);
    await expect(store.appendJournal(entryOf(org, 2, ZERO_ROOT, { order: orderOf(org, 2) }))).rejects.toThrow();
    await expect(store.appendJournal(entryOf(org, 5, first.digest))).rejects.toThrow();

    expect(await store.loadOrg(org)).toMatchObject({ nextSeq: 2, lastDigest: first.digest });
    expect(await journal(org)).toEqual([first]);
  });

  it('lets in exactly one of two writers of the same entry', async () => {
    const { store, org, journal } = await setup();
    const entry = entryOf(org, 1, ZERO_ROOT, { order: orderOf(org, 1) });
    const outcomes = await Promise.allSettled([store.appendJournal(entry), store.appendJournal(entry)]);

    expect(outcomes.map((o) => o.status).sort()).toEqual(['fulfilled', 'rejected']);
    const refused = outcomes.find((o) => o.status === 'rejected');
    expect(String(refused?.reason)).toContain('journal entry 1 is out of sequence, expected 2');
    expect(await journal(org)).toEqual([entry]);
    expect(await store.loadOrg(org)).toMatchObject({ nextSeq: 2, lastDigest: entry.digest });
  });
}
