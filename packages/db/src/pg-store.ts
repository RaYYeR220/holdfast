import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { OutgoingPayment, OwnedNote, Policy, Zat } from '@holdfast/core';
import type { JournalEntry, OrderRecord, OrgState, ScanCommit, Store } from '@holdfast/engine';
import { type SQL, and, asc, between, desc, eq, getTableColumns, gt, inArray, isNotNull, isNull, lt, not, or, sql } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import type { Database } from './client';
import { decryptSecret, encryptSecret } from './crypto';
import { journal, orders, orgs, zcashFees, zcashNotes, zcashOutgoing } from './schema';

export const DEFAULT_LEASE_MS = 120_000;
const DEFAULT_PAGE = 50;
/** Rows per statement: the widest insert stays far below the 65,535 values one statement can bind. */
const BATCH = 500;

export interface PgStoreOptions {
  /** The 32-byte key viewing keys are encrypted under at rest. */
  masterKey: Uint8Array;
  /**
   * How long a tick may hold an organisation, ms. It has to outlast the
   * longest tick: once it runs out the tick can no longer write.
   */
  leaseMs?: number;
  /**
   * Tests only. Leases are timed by the database's clock, so that an instance
   * whose own clock is fast or slow can neither take one early nor hold one
   * late; this puts a clock the test controls in the database's place.
   */
  clockForTests?: () => number;
}

/**
 * A tick tried to write after its lease ran out or passed to another tick.
 * Nothing was written.
 */
export class LeaseLostError extends Error {
  readonly orgId: string;

  constructor(orgId: string) {
    super(`the tick lease on ${orgId} was lost; nothing was written`);
    this.name = 'LeaseLostError';
    this.orgId = orgId;
  }
}

export interface NewOrg {
  id: string;
  name: string;
  ufvk: string;
  birthday: number;
  hlUser: string;
  policy: Policy;
  lockEnabled: boolean;
  monthlyBurnUsd?: number | null;
  publicDemo?: boolean;
}

export type OrgPatch = Partial<Pick<NewOrg, 'name' | 'hlUser' | 'policy' | 'lockEnabled' | 'monthlyBurnUsd' | 'publicDemo'>>;

/** What the application shows about an organisation and the engine has no use for. */
export interface OrgProfile {
  id: string;
  name: string;
  createdAt: number;
  monthlyBurnUsd: number | null;
  publicDemo: boolean;
}

export interface FeeRecord {
  txid: string;
  height: number;
  zat: Zat;
}

const unknownOrg = (orgId: string) => new Error(`unknown organisation ${orgId}`);
const ufvkContext = (orgId: string) => `ufvk:${orgId}`;

function* batches<T>(items: readonly T[]): Generator<T[]> {
  for (let i = 0; i < items.length; i += BATCH) yield items.slice(i, i + BATCH);
}

/** What a Map keyed this way holds after every item has been set in turn. */
function lastBy<T>(items: readonly T[], key: (item: T) => string): T[] {
  return [...new Map(items.map((item) => [key(item), item])).values()];
}

/** For an upsert: every column outside the key takes the value of the row that collided. */
function overwriteExcept(table: PgTable, key: PgColumn[]): Record<string, SQL> {
  return Object.fromEntries(
    Object.entries(getTableColumns(table))
      .filter(([, column]) => !key.includes(column))
      .map(([field, column]) => [field, sql.raw(`excluded."${column.name}"`)]),
  );
}

const NOTE = {
  id: zcashNotes.id,
  txid: zcashNotes.txid,
  height: zcashNotes.height,
  time: zcashNotes.time,
  zat: zcashNotes.zat,
  memo: zcashNotes.memo,
  pool: zcashNotes.pool,
  kind: zcashNotes.kind,
  nullifier: zcashNotes.nullifier,
  spent: zcashNotes.spent,
};

const OUTGOING = {
  id: zcashOutgoing.id,
  txid: zcashOutgoing.txid,
  height: zcashOutgoing.height,
  time: zcashOutgoing.time,
  zat: zcashOutgoing.zat,
  memo: zcashOutgoing.memo,
  pool: zcashOutgoing.pool,
};

/**
 * The store on Postgres. Every method is a single statement or a single
 * transaction and leaves nothing on the connection, so it works through a
 * pooler that hands each transaction a different one.
 */
export class PgStore implements Store {
  private readonly db: Database;
  private readonly masterKey: Uint8Array;
  private readonly leaseMs: number;
  private readonly clockForTests: (() => number) | undefined;
  /**
   * The lease tokens of the `withOrgLock` calls this code is running inside,
   * by organisation. It follows the call, not the store: two ticks of one
   * organisation overlapping on the same store each see only their own.
   */
  private readonly leases = new AsyncLocalStorage<ReadonlyMap<string, string>>();

  constructor(db: Database, options: PgStoreOptions) {
    const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
    if (!Number.isInteger(leaseMs) || leaseMs <= 0) throw new RangeError('the lease must be a positive number of milliseconds');
    this.db = db;
    this.masterKey = options.masterKey;
    this.leaseMs = leaseMs;
    this.clockForTests = options.clockForTests;
  }

  /** The moment leases are judged against: the database's, whatever time this process thinks it is. */
  private clock(): SQL {
    if (this.clockForTests === undefined) return sql`clock_timestamp()`;
    return sql`${new Date(this.clockForTests()).toISOString()}::timestamptz`;
  }

  async createOrg(init: NewOrg): Promise<void> {
    const created = await this.db
      .insert(orgs)
      .values({
        id: init.id,
        name: init.name,
        createdAt: this.clockForTests?.(),
        ufvkEnc: encryptSecret(init.ufvk, this.masterKey, ufvkContext(init.id)),
        birthday: init.birthday,
        hlUser: init.hlUser,
        policy: init.policy,
        lockEnabled: init.lockEnabled,
        monthlyBurnUsd: init.monthlyBurnUsd ?? null,
        publicDemo: init.publicDemo ?? false,
      })
      .onConflictDoNothing({ target: orgs.id })
      .returning({ id: orgs.id });
    if (created.length === 0) throw new Error(`organisation ${init.id} already exists`);
  }

  async updateOrg(orgId: string, patch: OrgPatch): Promise<void> {
    const { name, hlUser, policy, lockEnabled, monthlyBurnUsd, publicDemo } = patch;
    const changes = { name, hlUser, policy, lockEnabled, monthlyBurnUsd, publicDemo };
    if (Object.values(changes).every((value) => value === undefined)) return this.requireOrg(orgId);
    const updated = await this.db.update(orgs).set(changes).where(eq(orgs.id, orgId)).returning({ id: orgs.id });
    if (updated.length === 0) throw unknownOrg(orgId);
  }

  async listOrgIds(): Promise<string[]> {
    const rows = await this.db.select({ id: orgs.id }).from(orgs).orderBy(asc(orgs.id));
    return rows.map((row) => row.id);
  }

  async orgProfile(orgId: string): Promise<OrgProfile> {
    const [row] = await this.db
      .select({
        id: orgs.id,
        name: orgs.name,
        createdAt: orgs.createdAt,
        monthlyBurnUsd: orgs.monthlyBurnUsd,
        publicDemo: orgs.publicDemo,
      })
      .from(orgs)
      .where(eq(orgs.id, orgId));
    if (row === undefined) throw unknownOrg(orgId);
    return row;
  }

  /**
   * The lock is a lease written on the organisation's row: taking it is one
   * conditional update, so it needs no session, and a tick that dies holding
   * it loses it when the lease runs out.
   *
   * Taking it also writes a fresh token on the row. What `fn` then writes
   * through `commitScan` and `appendJournal` lands only while that token is
   * still there and the lease has not run out, so a tick that outlives its
   * lease cannot write over the one that took its place.
   */
  async withOrgLock<T>(orgId: string, fn: () => Promise<T>): Promise<{ ran: true; value: T } | { ran: false }> {
    const token = await this.takeLease(orgId);
    if (token === null) return { ran: false };
    const held = new Map(this.leases.getStore()).set(orgId, token);
    let value: T;
    try {
      value = await this.leases.run(held, fn);
    } catch (error) {
      // The caller needs to see why the tick failed; a lease that cannot be
      // handed back here simply runs out.
      await this.dropLease(orgId, token).catch(() => undefined);
      throw error;
    }
    await this.dropLease(orgId, token);
    return { ran: true, value };
  }

  private async takeLease(orgId: string): Promise<string | null> {
    const token = randomUUID();
    const now = this.clock();
    const taken = await this.db
      .update(orgs)
      .set({
        tickLeaseUntil: sql`${now} + ${this.leaseMs}::double precision * interval '1 millisecond'`,
        tickLeaseToken: token,
      })
      .where(and(eq(orgs.id, orgId), or(isNull(orgs.tickLeaseUntil), lt(orgs.tickLeaseUntil, now))))
      .returning({ id: orgs.id });
    if (taken.length > 0) return token;
    await this.requireOrg(orgId);
    return null;
  }

  /** Only the lease this caller took: one that expired may already belong to the next tick. */
  private async dropLease(orgId: string, token: string): Promise<void> {
    await this.db
      .update(orgs)
      .set({ tickLeaseUntil: null, tickLeaseToken: null })
      .where(and(eq(orgs.id, orgId), eq(orgs.tickLeaseToken, token)));
  }

  /**
   * What must still be true of the organisation's row for a write made inside
   * `withOrgLock` to land. Nothing when the caller holds no lease: a write
   * made outside a tick is not a tick's write.
   */
  private fence(orgId: string): SQL | undefined {
    const token = this.leases.getStore()?.get(orgId);
    if (token === undefined) return undefined;
    return and(eq(orgs.tickLeaseToken, token), gt(orgs.tickLeaseUntil, this.clock()));
  }

  private async requireOrg(orgId: string): Promise<void> {
    const found = await this.db.select({ id: orgs.id }).from(orgs).where(eq(orgs.id, orgId));
    if (found.length === 0) throw unknownOrg(orgId);
  }

  async loadOrg(orgId: string): Promise<OrgState> {
    const [row] = await this.db.select().from(orgs).where(eq(orgs.id, orgId));
    if (row === undefined) throw unknownOrg(orgId);
    return {
      id: row.id,
      ufvk: decryptSecret(row.ufvkEnc, this.masterKey, ufvkContext(row.id)),
      birthday: row.birthday,
      scannedTo: row.scannedTo,
      tip: row.tipHeight === null || row.tipSince === null ? null : { height: row.tipHeight, since: row.tipSince },
      hlUser: row.hlUser,
      policy: row.policy,
      lockEnabled: row.lockEnabled,
      nextSeq: row.nextSeq,
      lastDigest: row.lastDigest,
    };
  }

  async commitScan(orgId: string, scan: ScanCommit): Promise<void> {
    const notes = lastBy(scan.notes, (note) => note.id).map((note) => ({
      orgId,
      id: note.id,
      txid: note.txid,
      height: note.height,
      time: note.time,
      zat: note.zat,
      memo: note.memo,
      pool: note.pool,
      kind: note.kind,
      nullifier: note.nullifier,
      spent: note.spent,
    }));
    const outgoing = lastBy(scan.outgoing, (out) => out.id).map((out) => ({
      orgId,
      id: out.id,
      txid: out.txid,
      height: out.height,
      time: out.time,
      zat: out.zat,
      memo: out.memo,
      pool: out.pool,
    }));
    // A fee is filed under the block of its transaction; one whose transaction
    // left nothing else in this scan goes to the end of the range.
    const heightOf = new Map([...scan.notes, ...scan.outgoing].map((x) => [x.txid, x.height]));
    const fees = lastBy(scan.fees, (fee) => fee.txid).map((fee) => ({
      orgId,
      txid: fee.txid,
      height: heightOf.get(fee.txid) ?? scan.to,
      zat: fee.zat,
    }));

    const fence = this.fence(orgId);
    await this.db.transaction(async (tx) => {
      // First, so that the rest happens only if this did. It locks the row
      // until the transaction ends: the lease cannot change hands half way
      // through, and two scans of one organisation queue here.
      const updated = await tx
        .update(orgs)
        .set({ scannedTo: scan.to, tipHeight: scan.tip.height, tipSince: scan.tip.since })
        .where(and(eq(orgs.id, orgId), fence))
        .returning({ id: orgs.id });
      if (updated.length === 0) {
        const found = await tx.select({ id: orgs.id }).from(orgs).where(eq(orgs.id, orgId));
        throw found.length === 0 ? unknownOrg(orgId) : new LeaseLostError(orgId);
      }

      await tx.delete(zcashNotes).where(and(eq(zcashNotes.orgId, orgId), between(zcashNotes.height, scan.from, scan.to)));
      await tx.delete(zcashOutgoing).where(and(eq(zcashOutgoing.orgId, orgId), between(zcashOutgoing.height, scan.from, scan.to)));
      await tx.delete(zcashFees).where(and(eq(zcashFees.orgId, orgId), between(zcashFees.height, scan.from, scan.to)));

      // Upserts: after a reorganisation deeper than the range, the old copy
      // of a transaction is still stored below it under the same id.
      for (const rows of batches(notes)) {
        await tx
          .insert(zcashNotes)
          .values(rows)
          .onConflictDoUpdate({
            target: [zcashNotes.orgId, zcashNotes.id],
            set: overwriteExcept(zcashNotes, [zcashNotes.orgId, zcashNotes.id]),
          });
      }
      for (const rows of batches(outgoing)) {
        await tx
          .insert(zcashOutgoing)
          .values(rows)
          .onConflictDoUpdate({
            target: [zcashOutgoing.orgId, zcashOutgoing.id],
            set: overwriteExcept(zcashOutgoing, [zcashOutgoing.orgId, zcashOutgoing.id]),
          });
      }
      for (const rows of batches(fees)) {
        await tx
          .insert(zcashFees)
          .values(rows)
          .onConflictDoUpdate({
            target: [zcashFees.orgId, zcashFees.txid],
            set: overwriteExcept(zcashFees, [zcashFees.orgId, zcashFees.txid]),
          });
      }

      for (const nullifiers of batches(scan.spentNullifiers)) {
        await tx
          .update(zcashNotes)
          .set({ spent: true })
          .where(and(eq(zcashNotes.orgId, orgId), not(zcashNotes.spent), inArray(zcashNotes.nullifier, nullifiers)));
      }
    });
  }

  async unspentNullifiers(orgId: string): Promise<string[]> {
    const rows = await this.db
      .select({ nullifier: zcashNotes.nullifier })
      .from(orgs)
      .leftJoin(zcashNotes, and(eq(zcashNotes.orgId, orgs.id), not(zcashNotes.spent), isNotNull(zcashNotes.nullifier)))
      .where(eq(orgs.id, orgId));
    // The join yields one empty row for an organisation without such notes, and none for no organisation.
    if (rows.length === 0) throw unknownOrg(orgId);
    return rows.flatMap((row) => (row.nullifier === null ? [] : [row.nullifier]));
  }

  async trackedBalance(orgId: string): Promise<Zat> {
    return this.sumNotes(orgId, and(not(zcashNotes.spent), isNotNull(zcashNotes.nullifier)));
  }

  /** Notes received in pools whose spends cannot be followed with a viewing key. */
  async untrackedBalance(orgId: string): Promise<Zat> {
    return this.sumNotes(orgId, isNull(zcashNotes.nullifier));
  }

  private async sumNotes(orgId: string, which: SQL | undefined): Promise<Zat> {
    const [row] = await this.db
      // As text: a sum is a numeric, and no driver may be left to turn it into a double.
      .select({ total: sql<string>`coalesce(sum(${zcashNotes.zat}), 0)::text` })
      .from(orgs)
      .leftJoin(zcashNotes, and(eq(zcashNotes.orgId, orgs.id), which))
      .where(eq(orgs.id, orgId))
      .groupBy(orgs.id);
    if (row === undefined) throw unknownOrg(orgId);
    return BigInt(row.total);
  }

  async appendJournal(entry: JournalEntry): Promise<void> {
    const fence = this.fence(entry.orgId);
    await this.db.transaction(async (tx) => {
      // Compare-and-set: the sequence only moves if this entry is the next
      // one and the writer still holds its lease. A second writer waits on
      // the row and then finds it moved.
      const advanced = await tx
        .update(orgs)
        .set({ nextSeq: entry.seq + 1, lastDigest: entry.digest })
        .where(and(eq(orgs.id, entry.orgId), eq(orgs.nextSeq, entry.seq), eq(orgs.lastDigest, entry.prev), fence))
        .returning({ id: orgs.id });
      if (advanced.length === 0) {
        const [org] = await tx
          .select({ nextSeq: orgs.nextSeq, leaseHeld: fence === undefined ? sql<boolean>`true` : sql<boolean | null>`${fence}` })
          .from(orgs)
          .where(eq(orgs.id, entry.orgId));
        if (org === undefined) throw unknownOrg(entry.orgId);
        if (org.leaseHeld !== true) throw new LeaseLostError(entry.orgId);
        if (entry.seq !== org.nextSeq) throw new Error(`journal entry ${entry.seq} is out of sequence, expected ${org.nextSeq}`);
        throw new Error(`journal entry ${entry.seq} does not follow the last entry`);
      }

      await tx.insert(journal).values({
        orgId: entry.orgId,
        seq: entry.seq,
        at: entry.at,
        prev: entry.prev,
        digest: entry.digest,
        entry,
        mode: entry.decision.mode,
        hasOrder: entry.order !== null,
      });
      if (entry.order !== null) {
        const { order } = entry;
        await tx.insert(orders).values({
          orgId: entry.orgId,
          seq: entry.seq,
          cloid: order.cloid,
          side: order.side,
          lots: order.lots,
          limitPx: order.limitPx,
          reduceOnly: order.reduceOnly,
          ok: order.result.ok,
          filledLots: order.result.filledLots,
          avgPx: order.result.avgPx,
          oid: order.result.oid,
          error: order.result.error,
        });
      }
    });
  }

  /** Newest first; `beforeSeq` continues a listing from where the last page ended. */
  async listJournal(orgId: string, page: { limit?: number; beforeSeq?: number } = {}): Promise<JournalEntry[]> {
    const rows = await this.db
      .select({ entry: journal.entry })
      .from(journal)
      .where(and(eq(journal.orgId, orgId), page.beforeSeq === undefined ? undefined : lt(journal.seq, page.beforeSeq)))
      .orderBy(desc(journal.seq))
      .limit(page.limit ?? DEFAULT_PAGE);
    return rows.map((row) => row.entry);
  }

  /** Oldest first, both ends included: the order in which a chain is verified. */
  async journalRange(orgId: string, fromSeq: number, toSeq: number): Promise<JournalEntry[]> {
    const rows = await this.db
      .select({ entry: journal.entry })
      .from(journal)
      .where(and(eq(journal.orgId, orgId), between(journal.seq, fromSeq, toSeq)))
      .orderBy(asc(journal.seq));
    return rows.map((row) => row.entry);
  }

  async notes(orgId: string): Promise<OwnedNote[]> {
    return this.db
      .select(NOTE)
      .from(zcashNotes)
      .where(eq(zcashNotes.orgId, orgId))
      .orderBy(asc(zcashNotes.height), asc(zcashNotes.id));
  }

  async outgoing(orgId: string): Promise<OutgoingPayment[]> {
    return this.db
      .select(OUTGOING)
      .from(zcashOutgoing)
      .where(eq(zcashOutgoing.orgId, orgId))
      .orderBy(asc(zcashOutgoing.height), asc(zcashOutgoing.id));
  }

  async fees(orgId: string): Promise<FeeRecord[]> {
    return this.db
      .select({ txid: zcashFees.txid, height: zcashFees.height, zat: zcashFees.zat })
      .from(zcashFees)
      .where(eq(zcashFees.orgId, orgId))
      .orderBy(asc(zcashFees.height), asc(zcashFees.txid));
  }

  /** Newest first. */
  async orders(orgId: string, limit = DEFAULT_PAGE): Promise<OrderRecord[]> {
    const rows = await this.db
      .select()
      .from(orders)
      .where(eq(orders.orgId, orgId))
      .orderBy(desc(orders.seq), asc(orders.cloid))
      .limit(limit);
    return rows.map((row) => ({
      seq: row.seq,
      cloid: row.cloid,
      side: row.side,
      lots: row.lots,
      limitPx: row.limitPx,
      reduceOnly: row.reduceOnly,
      result: { ok: row.ok, filledLots: row.filledLots, avgPx: row.avgPx, oid: row.oid, error: row.error },
    }));
  }
}
