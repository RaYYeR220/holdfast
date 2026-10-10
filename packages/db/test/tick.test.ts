import { ZERO_ROOT } from '@holdfast/core';
import { type JournalEntry, MemoryStore, type Store, type TickDeps, cloidFor, entryDigest, tick, verifyChain } from '@holdfast/engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_LEASE_MS, LeaseLostError, type PgliteConnection } from '../src';
import { BIRTHDAY, Chain, Clock, Venue, note, reference } from './support/fakes';
import { ORG, STARTUP_TIMEOUT_MS, migratedPglite, pgStore } from './support/stores';

let connection: PgliteConnection;

beforeAll(async () => {
  connection = await migratedPglite();
}, STARTUP_TIMEOUT_MS);

afterAll(() => connection.close());

/** The engine with a chain, a venue and a price of the test's own, on whichever store it is given. */
function world(store: Store, orgId: string, clock = new Clock()) {
  const chain = new Chain();
  const venue = new Venue(clock.now);
  const deps: TickDeps = { store, scanner: chain, venue, reference: reference(clock.now), now: clock.now };
  const run = async (): Promise<JournalEntry> => {
    clock.advance(60_000);
    const outcome = await tick(orgId, deps);
    if (!outcome.ran) throw new Error('tick did not run');
    return outcome.entry;
  };
  return { clock, chain, venue, deps, run };
}

async function onPostgres(orgId: string) {
  const store = pgStore(connection.db);
  await store.createOrg({ id: orgId, name: 'Acme Labs', ...ORG });
  return { store, ...world(store, orgId) };
}

function inMemory(orgId: string) {
  const store = new MemoryStore();
  store.addOrg({ id: orgId, ...ORG });
  return { store, ...world(store, orgId) };
}

/** A fortnight in the life of a treasury: every path a tick can take through the store. */
async function fortnight(t: ReturnType<typeof world>, switchOff: () => Promise<void>) {
  const entries: JournalEntry[] = [];
  const step = async () => entries.push(await t.run());

  t.chain.notes = [note(BIRTHDAY + 10, 3_000_000n), note(BIRTHDAY + 11, 2_000_000n)];
  await step(); // opens the lock
  await step(); // holds

  t.chain.height += 30;
  t.chain.notes.push(note(BIRTHDAY + 125, 4_000_000n));
  await step(); // follows the treasury up

  t.chain.height += 5;
  t.chain.spends = [{ height: t.chain.height, nullifier: `nf${BIRTHDAY + 11}-2000000` }];
  await step(); // follows it down after a spend

  t.chain.notes = t.chain.notes.filter((n) => n.height !== BIRTHDAY + 125);
  t.chain.height += 1;
  await step(); // a reorganisation takes the last payment away

  t.chain.height -= 60;
  await step(); // an endpoint that is behind is not believed
  t.chain.height += 61;

  await switchOff();
  await step(); // the lock is switched off and the short unwound
  return entries;
}

describe('tick on PgStore', () => {
  it('opens the lock, holds, and leaves a journal that verifies', async () => {
    const t = await onPostgres('tick-open-hold');
    t.chain.notes = [note(BIRTHDAY + 10, 5_000_000n)];

    const first = await t.run();
    expect(first.snapshot.treasury?.zat).toBe(5_000_000n);
    expect(first.scan).toEqual({ from: BIRTHDAY, to: BIRTHDAY + 100, tip: BIRTHDAY + 100, caughtUp: true });
    expect(first.decision.mode).toBe('REBALANCE');
    expect(first.order).toMatchObject({ seq: 1, side: 'sell', lots: 5, reduceOnly: false, result: { ok: true, filledLots: 5 } });
    expect(first.order?.cloid).toBe(cloidFor('tick-open-hold', 1, 0));
    expect(first.prev).toBe(ZERO_ROOT);
    expect(first.errors).toEqual([]);
    expect(t.venue.shortLots).toBe(5);

    const second = await t.run();
    expect(second.decision.mode).toBe('HOLD');
    expect(second.order).toBeNull();
    expect(second.prev).toBe(first.digest);
    expect(t.venue.orders).toHaveLength(1);

    const stored = await t.store.journalRange('tick-open-hold', 1, 2);
    expect(verifyChain(stored, ZERO_ROOT)).toEqual({ ok: true });
    expect(stored).toEqual([first, second]);
    expect(stored.map(entryDigest)).toEqual([first.digest, second.digest]);
    expect(typeof stored[0]?.snapshot.treasury?.zat).toBe('bigint');

    expect(await t.store.orders('tick-open-hold')).toEqual([first.order]);
    expect(await t.store.loadOrg('tick-open-hold')).toMatchObject({
      scannedTo: BIRTHDAY + 100,
      tip: { height: BIRTHDAY + 100 },
      nextSeq: 3,
      lastDigest: second.digest,
    });
  });

  it('notices an entry changed in the database', async () => {
    const t = await onPostgres('tick-tamper');
    t.chain.notes = [note(BIRTHDAY + 10, 5_000_000n)];
    await t.run();
    await t.run();

    await connection.client.query(
      `update holdfast.journal set entry = jsonb_set(entry, '{snapshot,treasury,zat}', '{"$bigint":"5000001"}') where org_id = $1 and seq = 2`,
      ['tick-tamper'],
    );
    expect(verifyChain(await t.store.journalRange('tick-tamper', 1, 2), ZERO_ROOT)).toEqual({
      ok: false,
      seq: 2,
      reason: 'content does not match its digest',
    });
  });

  it('leaves the same journal, entry for entry, as the in-memory store', async () => {
    const pg = await onPostgres('tick-parity');
    const memory = inMemory('tick-parity');
    const onPg = await fortnight(pg, () => pg.store.updateOrg('tick-parity', { lockEnabled: false }));
    const inMem = await fortnight(memory, async () => memory.store.update('tick-parity', { lockEnabled: false }));

    expect(onPg.map((e) => e.decision.mode)).toEqual(['REBALANCE', 'HOLD', 'REBALANCE', 'REBALANCE', 'REBALANCE', 'HOLD', 'REBALANCE']);
    expect(onPg.map((e) => e.digest)).toEqual(inMem.map((e) => e.digest));
    expect(onPg).toEqual(inMem);

    const stored = await pg.store.journalRange('tick-parity', 1, onPg.length);
    expect(stored).toEqual(memory.store.journal('tick-parity'));
    expect(verifyChain(stored, ZERO_ROOT)).toEqual({ ok: true });
    expect(await pg.store.trackedBalance('tick-parity')).toBe(await memory.store.trackedBalance('tick-parity'));
    expect(pg.venue.orders).toEqual(memory.venue.orders);
  });

  it('runs one of two ticks that start together', async () => {
    const t = await onPostgres('tick-twice');
    t.chain.notes = [note(BIRTHDAY + 10, 5_000_000n)];
    t.clock.advance(60_000);

    const outcomes = await Promise.all([tick('tick-twice', t.deps), tick('tick-twice', t.deps)]);
    expect(outcomes.map((o) => o.ran).sort()).toEqual([false, true]);
    expect(outcomes.find((o) => !o.ran)).toEqual({ ran: false, reason: 'locked' });
    expect(t.venue.orders).toHaveLength(1);
    expect(await t.store.journalRange('tick-twice', 1, 10)).toHaveLength(1);

    const next = await t.run();
    expect(next.seq).toBe(2);
    expect(next.order).toBeNull();
  });

  it('repeats a tick under the same order id after a failed write', async () => {
    const t = await onPostgres('tick-retry');
    t.chain.notes = [note(BIRTHDAY + 10, 5_000_000n)];
    const append = t.store.appendJournal.bind(t.store);
    let failures = 1;
    t.store.appendJournal = async (entry) => {
      if (failures-- > 0) throw new Error('database unavailable');
      return append(entry);
    };

    await expect(t.run()).rejects.toThrow('database unavailable');
    expect(t.venue.shortLots).toBe(5);

    const repeated = await t.run();
    expect(repeated.seq).toBe(1);
    expect(repeated.order).toBeNull();
    expect(t.venue.orders.map((o) => o.cloid)).toEqual([cloidFor('tick-retry', 1, 0)]);
    expect(verifyChain(await t.store.journalRange('tick-retry', 1, 1), ZERO_ROOT)).toEqual({ ok: true });
  });

  it('fails a tick that outlived its lease instead of letting it write after the one that took over', async () => {
    const clock = new Clock();
    const store = pgStore(connection.db, { clockForTests: clock.now });
    await store.createOrg({ id: 'tick-overrun', name: 'Acme Labs', ...ORG });
    const t = world(store, 'tick-overrun', clock);
    t.chain.notes = [note(BIRTHDAY + 10, 5_000_000n)];

    // The first tick's scan takes longer than the lease lasts. While it is
    // away another tick takes the organisation over and runs to the end.
    const scan = t.chain.scan.bind(t.chain);
    let successor: JournalEntry | undefined;
    let stalls = 1;
    t.chain.scan = async (range) => {
      const found = await scan(range);
      if (stalls-- > 0) {
        clock.advance(DEFAULT_LEASE_MS + 1);
        successor = await t.run();
      }
      return found;
    };

    await expect(t.run()).rejects.toBeInstanceOf(LeaseLostError);

    expect(successor).toMatchObject({ seq: 1, order: { side: 'sell', lots: 5 } });
    const stored = await store.journalRange('tick-overrun', 1, 9);
    expect(stored).toEqual([successor]);
    expect(verifyChain(stored, ZERO_ROOT)).toEqual({ ok: true });
    expect(t.venue.orders).toHaveLength(1);
    expect(await store.loadOrg('tick-overrun')).toMatchObject({ scannedTo: BIRTHDAY + 100, nextSeq: 2, lastDigest: successor?.digest });

    // Nothing is left held: the next tick runs and carries the journal on.
    const next = await t.run();
    expect(next).toMatchObject({ seq: 2, prev: successor?.digest, order: null });
  });
});
