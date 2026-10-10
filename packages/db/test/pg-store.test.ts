import { DEFAULT_POLICY, ZERO_ROOT } from '@holdfast/core';
import type { JournalEntry } from '@holdfast/engine';
import { drizzle } from 'drizzle-orm/pglite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DEFAULT_LEASE_MS, LeaseLostError, type PgliteConnection } from '../src';
import { entryOf, orderOf, payment, scanOf } from './store-contract';
import { BIRTHDAY, Clock, GAP, HIGH_HALF, LOW_HALF, NUL, note, occupy } from './support/fakes';
import { ORG, STARTUP_TIMEOUT_MS, migratedPglite, pgStore, pgUnderTest } from './support/stores';

let connection: PgliteConnection;

beforeAll(async () => {
  connection = await migratedPglite();
}, STARTUP_TIMEOUT_MS);

afterAll(() => connection.close());

const one = async <T>(query: string, params: unknown[]): Promise<T> => {
  const { rows } = await connection.client.query<T>(query, params);
  if (rows[0] === undefined) throw new Error('no such row');
  return rows[0];
};

/** A store whose leases run on a clock the test moves, standing in for the database's. */
const setup = async (options: { leaseMs?: number } = {}) => {
  const clock = new Clock();
  const under = pgUnderTest(connection.db, { clockForTests: clock.now, ...options });
  return { ...under, clock, org: await under.addOrg() };
};

const leaseOn = (org: string) =>
  one<{ until: Date | null; token: string | null }>(
    'select tick_lease_until as until, tick_lease_token as token from holdfast.orgs where id = $1',
    [org],
  );

describe('the tick lease', () => {
  it('is written on the row under a fresh token while the work runs, and cleared after', async () => {
    const { store, org, clock } = await setup();
    const first = await store.withOrgLock(org, () => leaseOn(org));
    const second = await store.withOrgLock(org, () => leaseOn(org));
    if (!first.ran || !second.ran) throw new Error('the lock was not taken');

    expect(first.value.until).toEqual(new Date(clock.ms + DEFAULT_LEASE_MS));
    expect(first.value.token).toMatch(/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
    expect(second.value.token).not.toBe(first.value.token);
    expect(await leaseOn(org)).toEqual({ until: null, token: null });
  });

  it('asks the database what time it is, and sends it none', async () => {
    const queries: { query: string; params: unknown[] }[] = [];
    const logged = drizzle(connection.client, { logger: { logQuery: (query, params) => queries.push({ query, params }) } });
    const { store, addOrg } = pgUnderTest(logged);
    const org = await addOrg();
    queries.length = 0;

    await store.withOrgLock(org, () => store.appendJournal(entryOf(org, 1, ZERO_ROOT)));

    const [take, guard] = queries.filter((q) => q.query.startsWith('update') && q.query.includes('tick_lease_until'));
    expect(take?.query).toContain('"tick_lease_until" = clock_timestamp() + ');
    expect(take?.query).toContain('"tick_lease_until" < clock_timestamp()');
    // The length of the lease, the organisation and the new token: no moment in time.
    const sent = take?.params ?? [];
    expect(sent).toHaveLength(3);
    expect(sent).toContain(DEFAULT_LEASE_MS);
    expect(sent).toContain(org);
    expect(sent.filter((value) => typeof value === 'string' && /^[0-9a-f-]{36}$/.test(value))).toHaveLength(2);
    expect(guard?.query).toContain('"tick_lease_token" = ');
    expect(guard?.query).toContain('"tick_lease_until" > clock_timestamp()');
    expect(await leaseOn(org)).toEqual({ until: null, token: null });
  });

  it('runs on the database clock when no other is given', async () => {
    const { store, addOrg } = pgUnderTest(connection.db, { leaseMs: 400 });
    const org = await addOrg();
    const dead = await occupy(store, org);
    expect(await store.withOrgLock(org, async () => 'early')).toEqual({ ran: false });

    await new Promise((resolve) => setTimeout(resolve, 600));
    await expect(dead.run(() => store.appendJournal(entryOf(org, 1, ZERO_ROOT)))).rejects.toBeInstanceOf(LeaseLostError);
    expect(await store.withOrgLock(org, async () => 'after')).toEqual({ ran: true, value: 'after' });
  });

  it('cannot be taken early by an instance whose clock runs fast, nor held late by one whose clock runs slow', async () => {
    const { store, org, clock, journal } = await setup();
    // A second instance on the same database. What the two of them believe
    // the time to be is Date.now; the lease must not care.
    const other = pgUnderTest(connection.db, { clockForTests: clock.now }).store;
    const believed = vi.spyOn(Date, 'now');
    try {
      const holder = await occupy(store, org);

      believed.mockReturnValue(clock.ms + 10 * DEFAULT_LEASE_MS);
      expect(await other.withOrgLock(org, async () => 'stolen')).toEqual({ ran: false });
      await holder.run(() => store.appendJournal(entryOf(org, 1, ZERO_ROOT)));

      believed.mockReturnValue(clock.ms - 10 * DEFAULT_LEASE_MS);
      clock.advance(DEFAULT_LEASE_MS + 1);
      const [first] = await journal(org);
      await expect(holder.run(() => store.appendJournal(entryOf(org, 2, first?.digest ?? ZERO_ROOT)))).rejects.toBeInstanceOf(LeaseLostError);
      expect(await other.withOrgLock(org, async () => 'taken over')).toEqual({ ran: true, value: 'taken over' });
      expect(await journal(org)).toHaveLength(1);
    } finally {
      believed.mockRestore();
    }
  });

  it('runs out, so a tick that died holding it does not hold it for ever', async () => {
    const { store, org, clock } = await setup();
    await occupy(store, org);
    expect(await store.withOrgLock(org, async () => 'early')).toEqual({ ran: false });

    clock.advance(DEFAULT_LEASE_MS);
    expect(await store.withOrgLock(org, async () => 'on the dot')).toEqual({ ran: false });

    clock.advance(1);
    expect(await store.withOrgLock(org, async () => 'after')).toEqual({ ran: true, value: 'after' });
  });

  it('lasts as long as the store was told', async () => {
    const { store, org, clock } = await setup({ leaseMs: 5_000 });
    await occupy(store, org);
    clock.advance(5_000);
    expect(await store.withOrgLock(org, async () => 1)).toEqual({ ran: false });
    clock.advance(1);
    expect(await store.withOrgLock(org, async () => 1)).toEqual({ ran: true, value: 1 });
  });

  it('is not released by a tick that outlived it and lost it to another', async () => {
    const { store, org, clock } = await setup();
    const slow = await occupy(store, org);
    clock.advance(DEFAULT_LEASE_MS + 1);
    const next = await occupy(store, org);

    expect(await slow.leave()).toMatchObject({ ran: true });
    expect(await store.withOrgLock(org, async () => 'third')).toEqual({ ran: false });

    expect(await next.leave()).toMatchObject({ ran: true });
    expect(await store.withOrgLock(org, async () => 'third')).toEqual({ ran: true, value: 'third' });
  });

  describe('once a tick has outlived it', () => {
    const coin = note(BIRTHDAY + 10, 3_000_000n);
    const firstScan = scanOf(BIRTHDAY, BIRTHDAY + 50, { notes: [coin] });
    const laterScan = scanOf(BIRTHDAY, BIRTHDAY + 90, { notes: [note(BIRTHDAY + 60, 9_000_000n)] });

    it('refuses that tick a scan or a journal entry after another has taken over, and changes nothing', async () => {
      const { store, org, clock, notes, journal } = await setup();
      const first = entryOf(org, 1, ZERO_ROOT);
      const late = await occupy(store, org);
      await late.run(() => store.commitScan(org, firstScan));
      await late.run(() => store.appendJournal(first));

      clock.advance(DEFAULT_LEASE_MS + 1);
      const successor = await occupy(store, org);

      await expect(late.run(() => store.commitScan(org, laterScan))).rejects.toBeInstanceOf(LeaseLostError);
      await expect(late.run(() => store.appendJournal(entryOf(org, 2, first.digest, { order: orderOf(org, 2) })))).rejects.toBeInstanceOf(LeaseLostError);
      expect(await notes(org)).toEqual([coin]);
      expect(await journal(org)).toEqual([first]);
      expect(await store.orders(org)).toEqual([]);
      expect(await store.loadOrg(org)).toMatchObject({ scannedTo: BIRTHDAY + 50, nextSeq: 2, lastDigest: first.digest });

      // The successor is on the very same store, and writes under its own lease.
      const second = entryOf(org, 2, first.digest);
      await successor.run(() => store.commitScan(org, laterScan));
      await successor.run(() => store.appendJournal(second));
      expect(await journal(org)).toEqual([first, second]);
      expect(await store.loadOrg(org)).toMatchObject({ scannedTo: BIRTHDAY + 90, nextSeq: 3, lastDigest: second.digest });

      // The late tick ending does not hand back a lease that is no longer its own.
      const token = (await leaseOn(org)).token;
      expect(await late.leave()).toMatchObject({ ran: true });
      expect((await leaseOn(org)).token).toBe(token);
      await successor.run(() => store.appendJournal(entryOf(org, 3, second.digest)));
      expect(await successor.leave()).toMatchObject({ ran: true });
      expect(await leaseOn(org)).toEqual({ until: null, token: null });
    });

    it('refuses it across two stores on the same database as well', async () => {
      const { store, org, clock, journal } = await setup();
      const elsewhere = pgUnderTest(connection.db, { clockForTests: clock.now }).store;
      const late = await occupy(store, org);
      clock.advance(DEFAULT_LEASE_MS + 1);
      const successor = await occupy(elsewhere, org);

      await expect(late.run(() => store.appendJournal(entryOf(org, 1, ZERO_ROOT)))).rejects.toBeInstanceOf(LeaseLostError);
      const entry = entryOf(org, 1, ZERO_ROOT);
      await successor.run(() => elsewhere.appendJournal(entry));
      expect(await journal(org)).toEqual([entry]);
    });

    it('refuses it even before anyone else has come for the lease', async () => {
      const { store, org, clock, notes, journal } = await setup();
      const late = await occupy(store, org);

      clock.advance(DEFAULT_LEASE_MS - 1);
      await late.run(() => store.commitScan(org, firstScan));

      // On the dot the lease is nobody's: too late to write, too early to take.
      clock.advance(1);
      await expect(late.run(() => store.commitScan(org, laterScan))).rejects.toBeInstanceOf(LeaseLostError);
      await expect(late.run(() => store.appendJournal(entryOf(org, 1, ZERO_ROOT)))).rejects.toBeInstanceOf(LeaseLostError);
      expect(await store.withOrgLock(org, async () => 'on the dot')).toEqual({ ran: false });

      expect(await notes(org)).toEqual([coin]);
      expect(await journal(org)).toEqual([]);
      expect(await store.loadOrg(org)).toMatchObject({ scannedTo: BIRTHDAY + 50, nextSeq: 1, lastDigest: ZERO_ROOT });
    });

    it('says the lease was lost, by name, whatever else is wrong with the write', async () => {
      const { store, org, clock } = await setup();
      const late = await occupy(store, org);
      const first = entryOf(org, 1, ZERO_ROOT);
      await late.run(() => store.appendJournal(first));
      clock.advance(DEFAULT_LEASE_MS + 1);

      const refused = await late.run(() => store.appendJournal(first)).catch((error: unknown) => error);
      expect(refused).toBeInstanceOf(LeaseLostError);
      expect(refused).toMatchObject({ name: 'LeaseLostError', orgId: org, message: `the tick lease on ${org} was lost; nothing was written` });
    });
  });

  describe('while a tick still holds it', () => {
    it('reports the ordinary refusals as before', async () => {
      const { store, org } = await setup();
      const tick = await occupy(store, org);
      const first = entryOf(org, 1, ZERO_ROOT);
      await tick.run(() => store.appendJournal(first));

      await expect(tick.run(() => store.appendJournal(first))).rejects.toThrow('journal entry 1 is out of sequence, expected 2');
      await expect(tick.run(() => store.appendJournal(entryOf(org, 2, ZERO_ROOT)))).rejects.toThrow('journal entry 2 does not follow the last entry');
      await expect(tick.run(() => store.commitScan('nobody', scanOf(BIRTHDAY, BIRTHDAY + 1)))).rejects.toThrow('unknown organisation nobody');
      expect(await tick.leave()).toMatchObject({ ran: true });
    });

    it('fences only the organisation the lease is for', async () => {
      const { store, org, addOrg, clock, journal } = await setup();
      const other = await addOrg();
      const tick = await occupy(store, org);
      const elsewhere = await occupy(store, other);

      clock.advance(DEFAULT_LEASE_MS - 1);
      const mine = entryOf(org, 1, ZERO_ROOT);
      const theirs = entryOf(other, 1, ZERO_ROOT);
      await tick.run(() => store.appendJournal(mine));
      await elsewhere.run(() => store.appendJournal(theirs));
      expect(await journal(org)).toEqual([mine]);
      expect(await journal(other)).toEqual([theirs]);
    });

    it('leaves a write made outside any tick to the sequence check alone, as the in-memory store does', async () => {
      const { store, org, journal } = await setup();
      const tick = await occupy(store, org);
      const entry = entryOf(org, 1, ZERO_ROOT);
      await store.appendJournal(entry);
      await store.commitScan(org, scanOf(BIRTHDAY, BIRTHDAY + 50));

      expect(await journal(org)).toEqual([entry]);
      await expect(tick.run(() => store.appendJournal(entry))).rejects.toThrow('journal entry 1 is out of sequence, expected 2');
    });
  });

  it('refuses a lease that is not a positive whole number of milliseconds', () => {
    for (const leaseMs of [0, -1, 1.5, Number.NaN]) {
      expect(() => pgStore(connection.db, { leaseMs })).toThrow('the lease must be a positive number of milliseconds');
    }
  });

  describe('when the database goes away before the lease is handed back', () => {
    /** A database that stops taking updates on demand. */
    const flaky = () => {
      const state = { down: false };
      const db = new Proxy(connection.db, {
        get(target, property) {
          if (property === 'update' && state.down) {
            return () => {
              throw new Error('connection lost');
            };
          }
          const value: unknown = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      return { db, state };
    };

    it('reports why the work failed, and the lease runs out on its own', async () => {
      const { db, state } = flaky();
      const clock = new Clock();
      const { store, addOrg } = pgUnderTest(db, { clockForTests: clock.now });
      const org = await addOrg();

      await expect(
        store.withOrgLock(org, async () => {
          state.down = true;
          throw new Error('venue timeout');
        }),
      ).rejects.toThrow('venue timeout');
      state.down = false;

      expect(await store.withOrgLock(org, async () => 1)).toEqual({ ran: false });
      clock.advance(DEFAULT_LEASE_MS + 1);
      expect(await store.withOrgLock(org, async () => 1)).toEqual({ ran: true, value: 1 });
    });

    it('reports the lost connection when the work itself succeeded', async () => {
      const { db, state } = flaky();
      const { store, addOrg } = pgUnderTest(db);
      const org = await addOrg();
      await expect(
        store.withOrgLock(org, async () => {
          state.down = true;
        }),
      ).rejects.toThrow('connection lost');
    });
  });
});

describe('organisations', () => {
  it('keeps the viewing key encrypted, and only for the row it was written to', async () => {
    const { store, addOrg, org } = await setup();
    const { ufvk_enc: sealed } = await one<{ ufvk_enc: string }>('select ufvk_enc from holdfast.orgs where id = $1', [org]);
    expect(sealed).toMatch(/^v1\./);
    expect(sealed).not.toContain(ORG.ufvk);
    expect((await store.loadOrg(org)).ufvk).toBe(ORG.ufvk);

    const stranger = pgStore(connection.db, { masterKey: new Uint8Array(32).fill(9) });
    await expect(stranger.loadOrg(org)).rejects.toThrow('the secret could not be decrypted');

    const other = await addOrg();
    await connection.client.query('update holdfast.orgs set ufvk_enc = $1 where id = $2', [sealed, other]);
    await expect(store.loadOrg(other)).rejects.toThrow('the secret could not be decrypted');
  });

  it('creates an organisation with what the application knows about it', async () => {
    const { store, clock } = await setup();
    await store.createOrg({ id: 'acme-profile', name: 'Acme Labs', ...ORG, monthlyBurnUsd: 42_500.5, publicDemo: true });
    expect(await store.orgProfile('acme-profile')).toEqual({
      id: 'acme-profile',
      name: 'Acme Labs',
      createdAt: clock.ms,
      monthlyBurnUsd: 42_500.5,
      publicDemo: true,
    });
  });

  it('assumes no burn figure and no public demo unless told', async () => {
    const { store, org, clock } = await setup();
    expect(await store.orgProfile(org)).toEqual({ id: org, name: 'Test Org', createdAt: clock.ms, monthlyBurnUsd: null, publicDemo: false });
  });

  it('changes only the fields it is given', async () => {
    const { store, org } = await setup();
    const policy = { ...DEFAULT_POLICY, hedgeRatioBps: 5_000, maxLeverage: 1.5 };
    await store.updateOrg(org, { policy, lockEnabled: false });
    expect(await store.loadOrg(org)).toEqual({ id: org, ...ORG, policy, lockEnabled: false, scannedTo: null, tip: null, nextSeq: 1, lastDigest: ZERO_ROOT });

    await store.updateOrg(org, { name: 'Renamed', hlUser: '0xdef', monthlyBurnUsd: 9_000, publicDemo: true });
    expect(await store.loadOrg(org)).toMatchObject({ hlUser: '0xdef', policy, lockEnabled: false });
    expect(await store.orgProfile(org)).toMatchObject({ name: 'Renamed', monthlyBurnUsd: 9_000, publicDemo: true });

    await store.updateOrg(org, { monthlyBurnUsd: null });
    await store.updateOrg(org, {});
    expect(await store.orgProfile(org)).toMatchObject({ name: 'Renamed', monthlyBurnUsd: null, publicDemo: true });
  });

  it('rejects changes to an organisation it has never heard of', async () => {
    const { store } = await setup();
    await expect(store.updateOrg('nobody', { lockEnabled: false })).rejects.toThrow('unknown organisation nobody');
    await expect(store.updateOrg('nobody', {})).rejects.toThrow('unknown organisation nobody');
    await expect(store.orgProfile('nobody')).rejects.toThrow('unknown organisation nobody');
  });

  it('lists every organisation, in order', async () => {
    const { store, addOrg } = await setup();
    const added = [await addOrg('zz-last'), await addOrg('00-first')];
    const ids = await store.listOrgIds();
    expect(ids).toEqual([...ids].sort());
    expect(ids).toEqual(expect.arrayContaining(added));
    expect(ids.indexOf('00-first')).toBeLessThan(ids.indexOf('zz-last'));
  });
});

describe('scans', () => {
  it('files a fee under the block of its transaction, or the end of the range', async () => {
    const { store, org } = await setup();
    const received = note(BIRTHDAY + 10, 3_000_000n);
    const paid = payment(BIRTHDAY + 20, 1_500_000n);
    await store.commitScan(
      org,
      scanOf(BIRTHDAY, BIRTHDAY + 50, {
        notes: [received],
        outgoing: [paid],
        fees: [
          { txid: received.txid, zat: 10_000n },
          { txid: paid.txid, zat: 15_000n },
          { txid: 'tx-seen-only-by-its-fee', zat: 20_000n },
        ],
      }),
    );
    expect(await store.fees(org)).toEqual([
      { txid: received.txid, height: BIRTHDAY + 10, zat: 10_000n },
      { txid: paid.txid, height: BIRTHDAY + 20, zat: 15_000n },
      { txid: 'tx-seen-only-by-its-fee', height: BIRTHDAY + 50, zat: 20_000n },
    ]);
  });

  it('takes the height of the payment when a transaction has a note as well', async () => {
    const { store, org } = await setup();
    const change = note(BIRTHDAY + 10, 3_000_000n, { txid: 'tx-both', kind: 'change' });
    const paid = payment(BIRTHDAY + 12, 1_500_000n, { txid: 'tx-both' });
    await store.commitScan(
      org,
      scanOf(BIRTHDAY, BIRTHDAY + 50, {
        notes: [change],
        outgoing: [paid],
        fees: [
          { txid: 'tx-both', zat: 1n },
          { txid: 'tx-both', zat: 10_000n },
        ],
      }),
    );
    expect(await store.fees(org)).toEqual([{ txid: 'tx-both', height: BIRTHDAY + 12, zat: 10_000n }]);
  });

  it('replaces the fees of a range that is scanned again and keeps the others', async () => {
    const { store, org } = await setup();
    const early = payment(BIRTHDAY + 10, 1_000_000n);
    const late = payment(BIRTHDAY + 40, 2_000_000n);
    await store.commitScan(
      org,
      scanOf(BIRTHDAY, BIRTHDAY + 50, {
        outgoing: [early, late],
        fees: [
          { txid: early.txid, zat: 10_000n },
          { txid: late.txid, zat: 15_000n },
        ],
      }),
    );
    await store.commitScan(org, scanOf(BIRTHDAY + 31, BIRTHDAY + 60));
    expect(await store.fees(org)).toEqual([{ txid: early.txid, height: BIRTHDAY + 10, zat: 10_000n }]);
    expect(await store.outgoing(org)).toEqual([early]);
  });

  it('takes a scan far larger than one statement can carry', async () => {
    const { store, org } = await setup();
    const coins = Array.from({ length: 6_500 }, (_, i) => note(BIRTHDAY + i, BigInt(1_000 + i)));
    await store.commitScan(org, scanOf(BIRTHDAY, BIRTHDAY + 7_000, { notes: coins }));
    expect(await store.unspentNullifiers(org)).toHaveLength(6_500);

    const spent = coins.slice(0, 6_000).map((coin) => coin.nullifier ?? '');
    await store.commitScan(org, scanOf(BIRTHDAY + 7_001, BIRTHDAY + 7_010, { spentNullifiers: spent }));
    expect(await store.unspentNullifiers(org)).toHaveLength(500);
    expect(await store.trackedBalance(org)).toBe(coins.slice(6_000).reduce((sum, coin) => sum + coin.zat, 0n));
  }, 60_000);

  it('stores a memo nobody could store as sent, with the gap marked', async () => {
    const { store, org } = await setup();
    const hostile = note(BIRTHDAY + 10, 1_000n, { memo: `invoice${NUL}14 ${HIGH_HALF}` });
    const paid = payment(BIRTHDAY + 11, 2_000n, { memo: NUL });
    await store.commitScan(org, scanOf(BIRTHDAY, BIRTHDAY + 50, { notes: [hostile], outgoing: [paid] }));

    expect(await store.notes(org)).toEqual([{ ...hostile, memo: `invoice${GAP}14 ${GAP}` }]);
    expect(await store.outgoing(org)).toEqual([{ ...paid, memo: GAP }]);
    expect(await store.trackedBalance(org)).toBe(1_000n);
  });

  it('lists notes and payments from the oldest block up', async () => {
    const { store, org } = await setup();
    const coins = [note(BIRTHDAY + 30, 1n), note(BIRTHDAY + 10, 2n), note(BIRTHDAY + 20, 3n)];
    const paid = [payment(BIRTHDAY + 25, 1n), payment(BIRTHDAY + 5, 2n)];
    await store.commitScan(org, scanOf(BIRTHDAY, BIRTHDAY + 50, { notes: coins, outgoing: paid }));
    expect((await store.notes(org)).map((n) => n.height)).toEqual([BIRTHDAY + 10, BIRTHDAY + 20, BIRTHDAY + 30]);
    expect((await store.outgoing(org)).map((o) => o.height)).toEqual([BIRTHDAY + 5, BIRTHDAY + 25]);
  });

  it('refuses a time that is not a whole millisecond rather than rounding it', async () => {
    const { store, org } = await setup();
    await expect(store.commitScan(org, scanOf(BIRTHDAY, BIRTHDAY + 50, { notes: [note(BIRTHDAY + 10, 1n, { time: 1_800_000_000_000.5 })] }))).rejects.toThrow(
      'not a whole number of milliseconds',
    );
    expect(await store.loadOrg(org)).toMatchObject({ scannedTo: null, tip: null });
  });

  it('commits the whole scan or none of it', async () => {
    const { store, org } = await setup();
    const kept = note(BIRTHDAY + 10, 3_000_000n);
    await store.commitScan(org, scanOf(BIRTHDAY, BIRTHDAY + 50, { notes: [kept] }));

    // The second note cannot be stored: its amount does not fit the column.
    const impossible = note(BIRTHDAY + 12, 2n ** 64n);
    await expect(store.commitScan(org, scanOf(BIRTHDAY, BIRTHDAY + 60, { notes: [note(BIRTHDAY + 11, 1n), impossible] }))).rejects.toThrow();

    expect(await store.notes(org)).toEqual([kept]);
    expect(await store.loadOrg(org)).toMatchObject({ scannedTo: BIRTHDAY + 50 });
  });
});

describe('the journal', () => {
  const chain = async (store: { appendJournal(e: JournalEntry): Promise<void> }, org: string, length: number) => {
    const entries: JournalEntry[] = [];
    for (let seq = 1; seq <= length; seq++) {
      const entry = entryOf(org, seq, entries.at(-1)?.digest ?? ZERO_ROOT, seq % 2 === 1 ? { order: orderOf(org, seq) } : {});
      await store.appendJournal(entry);
      entries.push(entry);
    }
    return entries;
  };

  it('repeats beside each entry what queries filter on', async () => {
    const { store, org } = await setup();
    const [first, second] = await chain(store, org, 2);
    const { rows } = await connection.client.query(
      'select seq, at, prev, digest, mode, has_order from holdfast.journal where org_id = $1 order by seq',
      [org],
    );
    expect(rows).toEqual([
      { seq: 1, at: new Date(first?.at ?? 0), prev: ZERO_ROOT, digest: first?.digest, mode: 'HOLD', has_order: true },
      { seq: 2, at: new Date(second?.at ?? 0), prev: first?.digest, digest: second?.digest, mode: 'HOLD', has_order: false },
    ]);
  });

  it('stores a bigint inside the entry as a tagged decimal string', async () => {
    const { store, org } = await setup();
    await chain(store, org, 1);
    const row = await one<{ zat: unknown }>("select entry #> '{snapshot,treasury,zat}' as zat from holdfast.journal where org_id = $1", [org]);
    expect(row.zat).toEqual({ $bigint: '5000000' });
  });

  it('pages through the journal from the newest entry back', async () => {
    const { store, org } = await setup();
    const entries = await chain(store, org, 7);
    const seqs = (page: JournalEntry[]) => page.map((e) => e.seq);

    expect(seqs(await store.listJournal(org))).toEqual([7, 6, 5, 4, 3, 2, 1]);
    const newest = await store.listJournal(org, { limit: 3 });
    expect(newest).toEqual([entries[6], entries[5], entries[4]]);
    expect(seqs(await store.listJournal(org, { limit: 3, beforeSeq: 5 }))).toEqual([4, 3, 2]);
    expect(seqs(await store.listJournal(org, { limit: 3, beforeSeq: 2 }))).toEqual([1]);
    expect(await store.listJournal(org, { beforeSeq: 1 })).toEqual([]);
  });

  it('reads a run of entries oldest first, both ends included', async () => {
    const { store, org } = await setup();
    const entries = await chain(store, org, 5);
    expect(await store.journalRange(org, 2, 4)).toEqual(entries.slice(1, 4));
    expect(await store.journalRange(org, 5, 9)).toEqual(entries.slice(4));
    expect(await store.journalRange(org, 6, 9)).toEqual([]);
  });

  it('lists the orders it placed, newest first, exactly as the venue answered', async () => {
    const { store, org } = await setup();
    const rejected = { ...orderOf(org, 2), side: 'buy' as const, lots: 2, limitPx: 0.30000000000000004, reduceOnly: true };
    rejected.result = { ok: false, filledLots: 0, avgPx: null, oid: null, error: 'Insufficient margin to place order' };

    const first = entryOf(org, 1, ZERO_ROOT, { order: orderOf(org, 1) });
    const second = entryOf(org, 2, first.digest, { order: rejected });
    const third = entryOf(org, 3, second.digest);
    for (const entry of [first, second, third]) await store.appendJournal(entry);

    expect(await store.orders(org)).toEqual([rejected, orderOf(org, 1)]);
    expect(await store.orders(org, 1)).toEqual([rejected]);
  });

  it('journals an order whatever the venue wrote in its answer', async () => {
    const { store, org } = await setup();
    const order = orderOf(org, 1);
    order.result = { ok: false, filledLots: 0, avgPx: null, oid: `oid${NUL}`, error: `rejected ${NUL} ${LOW_HALF}` };
    const entry = entryOf(org, 1, ZERO_ROOT, { order });
    await store.appendJournal(entry);

    expect(await store.journalRange(org, 1, 1)).toEqual([entry]);
    expect(await store.orders(org)).toEqual([{ ...order, result: { ...order.result, oid: `oid${GAP}`, error: `rejected ${GAP} ${GAP}` } }]);
  });
});
