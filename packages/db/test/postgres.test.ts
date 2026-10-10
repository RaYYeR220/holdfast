import { ZERO_ROOT } from '@holdfast/core';
import { type TickDeps, tick, verifyChain } from '@holdfast/engine';
import { inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  LeaseLostError,
  type PgStoreOptions,
  type PostgresConnection,
  connect,
  journal,
  migrate,
  orders,
  orgs,
  zcashFees,
  zcashNotes,
  zcashOutgoing,
} from '../src';
import { entryOf, scanOf, storeContract } from './store-contract';
import { BIRTHDAY, Chain, Clock, Venue, contend, note, occupy, reference } from './support/fakes';
import { STARTUP_TIMEOUT_MS, pgUnderTest } from './support/stores';

/**
 * The same contract on a real server, through the driver production uses and
 * with connections that really do run side by side. It runs only when
 * HOLDFAST_TEST_DATABASE_URL names a database kept for tests: it refuses one
 * that already holds organisations, and removes the ones it creates.
 */
const url = process.env.HOLDFAST_TEST_DATABASE_URL;
const WRITERS = 8;

describe.skipIf(url === undefined)('PgStore on Postgres', () => {
  let connection: PostgresConnection;
  const created: string[] = [];

  const underTest = (options: Partial<PgStoreOptions> = {}) => {
    const under = pgUnderTest(connection.db, options);
    return {
      ...under,
      async addOrg(id?: string) {
        const made = await under.addOrg(id);
        created.push(made);
        return made;
      },
    };
  };

  beforeAll(async () => {
    connection = connect(url ?? '', { max: WRITERS });
    await migrate(connection.db);
    const existing = await connection.db.select({ id: orgs.id }).from(orgs).limit(1);
    if (existing.length > 0) throw new Error('refusing to run the tests against a database that already holds organisations');
  }, STARTUP_TIMEOUT_MS);

  afterAll(async () => {
    if (created.length > 0) {
      const { db } = connection;
      await db.delete(orders).where(inArray(orders.orgId, created));
      await db.delete(journal).where(inArray(journal.orgId, created));
      await db.delete(zcashFees).where(inArray(zcashFees.orgId, created));
      await db.delete(zcashOutgoing).where(inArray(zcashOutgoing.orgId, created));
      await db.delete(zcashNotes).where(inArray(zcashNotes.orgId, created));
      await db.delete(orgs).where(inArray(orgs.id, created));
    }
    await connection?.close();
  });

  storeContract(async () => underTest());

  it('applies its migrations once and has row level security on every table', async () => {
    expect(await migrate(connection.db)).toEqual([]);
    const tables = await connection.sql<{ relname: string; relrowsecurity: boolean }[]>`
      select c.relname, c.relrowsecurity
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'holdfast' and c.relkind in ('r', 'p')`;
    expect(tables).toHaveLength(13);
    expect(tables.filter((table) => !table.relrowsecurity)).toEqual([]);
  });

  it('runs the engine and leaves a journal that verifies', async () => {
    const clock = new Clock();
    const { store, addOrg } = underTest();
    const org = await addOrg();
    const chain = new Chain();
    chain.notes = [note(BIRTHDAY + 10, 5_000_000n)];
    const deps: TickDeps = { store, scanner: chain, venue: new Venue(clock.now), reference: reference(clock.now), now: clock.now };

    const entries = [];
    for (let i = 0; i < 2; i++) {
      clock.advance(60_000);
      const outcome = await tick(org, deps);
      if (outcome.ran) entries.push(outcome.entry);
    }

    expect(entries.map((e) => e.decision.mode)).toEqual(['REBALANCE', 'HOLD']);
    const stored = await store.journalRange(org, 1, 2);
    expect(stored).toEqual(entries);
    expect(typeof stored[0]?.snapshot.treasury?.zat).toBe('bigint');
    expect(verifyChain(stored, ZERO_ROOT)).toEqual({ ok: true });
    expect(await store.orders(org)).toEqual([entries[0]?.order]);
  });

  it('runs one of many ticks that start at the same moment', async () => {
    const clock = new Clock();
    const { store, addOrg } = underTest();
    const org = await addOrg();
    const chain = new Chain();
    chain.notes = [note(BIRTHDAY + 10, 5_000_000n)];
    const venue = new Venue(clock.now);
    const deps: TickDeps = { store, scanner: chain, venue, reference: reference(clock.now), now: clock.now };

    const outcomes = await contend(WRITERS, (hold) => {
      const scanner: TickDeps['scanner'] = {
        async tip() {
          await hold();
          return chain.tip();
        },
        scan: (i) => chain.scan(i),
      };
      return tick(org, { ...deps, scanner });
    });
    expect(outcomes.filter((o) => o.ran)).toHaveLength(1);
    expect(venue.orders).toHaveLength(1);
    expect(await store.journalRange(org, 1, WRITERS)).toHaveLength(1);
  });

  it('lets in one of many writers of the same entry', async () => {
    const { store, addOrg } = underTest();
    const org = await addOrg();
    const entry = entryOf(org, 1, ZERO_ROOT);

    const outcomes = await Promise.allSettled(Array.from({ length: WRITERS }, () => store.appendJournal(entry)));
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    for (const outcome of outcomes) {
      if (outcome.status === 'rejected') expect(String(outcome.reason)).toContain('journal entry 1 is out of sequence, expected 2');
    }
    expect(await store.journalRange(org, 1, WRITERS)).toEqual([entry]);
    expect(await store.loadOrg(org)).toMatchObject({ nextSeq: 2, lastDigest: entry.digest });
  });

  it('gives a lease left by a dead tick to exactly one of those waiting, once the server says it has run out', async () => {
    const { store, addOrg } = underTest({ leaseMs: 1_000 });
    const org = await addOrg();
    await occupy(store, org);
    expect(await store.withOrgLock(org, async () => 1)).toEqual({ ran: false });

    await new Promise((resolve) => setTimeout(resolve, 1_300));
    const outcomes = await contend(WRITERS, (hold) => store.withOrgLock(org, hold));
    expect(outcomes.filter((o) => o.ran)).toHaveLength(1);
  });

  it('times the lease by the server, whatever this process believes the time to be', async () => {
    const { store, addOrg } = underTest({ leaseMs: 1_000 });
    const org = await addOrg();
    const started = Date.now();
    const believed = vi.spyOn(Date, 'now');
    try {
      const holder = await occupy(store, org);

      // A day ahead: by its own clock the lease ran out long ago.
      believed.mockReturnValue(started + 86_400_000);
      expect(await store.withOrgLock(org, async () => 'stolen')).toEqual({ ran: false });
      await holder.run(() => store.commitScan(org, scanOf(BIRTHDAY, BIRTHDAY + 50, { notes: [note(BIRTHDAY + 10, 1_000n)] })));

      // A day behind: by its own clock the lease has hardly begun.
      believed.mockReturnValue(started - 86_400_000);
      await new Promise((resolve) => setTimeout(resolve, 1_300));
      await expect(holder.run(() => store.appendJournal(entryOf(org, 1, ZERO_ROOT)))).rejects.toBeInstanceOf(LeaseLostError);
      await expect(holder.run(() => store.commitScan(org, scanOf(BIRTHDAY, BIRTHDAY + 90)))).rejects.toBeInstanceOf(LeaseLostError);
      expect(await store.withOrgLock(org, async () => 'taken over')).toEqual({ ran: true, value: 'taken over' });

      expect(await store.journalRange(org, 1, 9)).toEqual([]);
      expect(await store.notes(org)).toHaveLength(1);
      expect(await store.loadOrg(org)).toMatchObject({ scannedTo: BIRTHDAY + 50, nextSeq: 1 });
    } finally {
      believed.mockRestore();
    }
  });

  it('refuses the writes of a tick whose lease another tick has taken, on separate connections', async () => {
    const clock = new Clock();
    const { store, addOrg } = underTest({ clockForTests: clock.now });
    const org = await addOrg();
    const late = await occupy(store, org);
    clock.advance(120_001);
    const successor = await occupy(store, org);

    const entry = entryOf(org, 1, ZERO_ROOT);
    const outcomes = await Promise.allSettled([
      ...Array.from({ length: WRITERS - 1 }, () => late.run(() => store.appendJournal(entry))),
      successor.run(() => store.appendJournal(entry)),
    ]);
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.at(-1)?.status).toBe('fulfilled');
    for (const refused of outcomes.slice(0, -1)) {
      expect(refused.status === 'rejected' ? refused.reason : null).toBeInstanceOf(LeaseLostError);
    }
    expect(await store.journalRange(org, 1, 9)).toEqual([entry]);
  });
});
