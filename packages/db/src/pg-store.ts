import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes, randomUUID } from 'node:crypto';
import type { Hex, OutgoingPayment, OwnedNote, Policy, Zat } from '@holdfast/core';
import type { JournalEntry, OrderRecord, OrgState, ScanCommit, Store } from '@holdfast/engine';
import { type SQL, and, asc, between, desc, eq, getTableColumns, gt, inArray, isNotNull, isNull, like, lt, lte, ne, not, notInArray, or, sql } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import type { Database } from './client';
import { decryptSecret, encryptSecret } from './crypto';
import {
  type AttestationOutcome,
  type AttestationRow,
  type AuditLinkRow,
  type KeyKind,
  MAX_RUNS_PER_MONTH,
  type NewAttestation,
  type NewAuditLink,
  type NewPayoutLine,
  type NewPayoutRun,
  type NewRefusal,
  type NewServiceKey,
  type NewSwap,
  type OrgRecord,
  type PaidPayoutRun,
  type PayoutLineRow,
  type PayoutRunRow,
  type PayoutSettlement,
  type PayoutStatus,
  type RefusalRow,
  type ServiceKey,
  type SwapRow,
  type SwapSighting,
  type TreasuryOpening,
  runIdOf,
  runIdPrefix,
  runNumberOf,
} from './records';
import { attestations, auditLinks, authNonces, journal, keys, orders, orgs, payoutLines, payoutRuns, refusals, swaps, zcashFees, zcashNotes, zcashOutgoing } from './schema';

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
  tempoAccount?: string | null;
  solanaOwner?: string | null;
}

export type OrgPatch = Partial<
  Pick<NewOrg, 'name' | 'hlUser' | 'policy' | 'lockEnabled' | 'monthlyBurnUsd' | 'publicDemo' | 'tempoAccount' | 'solanaOwner'>
>;

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
const keyContext = (orgId: string, kind: KeyKind, address: string) => `key:${orgId}:${kind}:${address}`;
// A salt opens one commitment, so the commitment is where it lives.
const saltContext = (orgId: string, commitment: Hex) => `salt:${orgId}:${commitment}`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The states in which the swap service is done with a swap. */
const SETTLED_SWAP_STATES = ['SUCCESS', 'REFUNDED', 'FAILED'];
const RECEIPT_TOKEN_BYTES = 32;

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

// The viewing key and the tick lease are left out: nothing that reads an
// organisation this way has a use for either.
const ORG = {
  id: orgs.id,
  name: orgs.name,
  createdAt: orgs.createdAt,
  hlUser: orgs.hlUser,
  birthday: orgs.birthday,
  scannedTo: orgs.scannedTo,
  policy: orgs.policy,
  lockEnabled: orgs.lockEnabled,
  nextSeq: orgs.nextSeq,
  lastDigest: orgs.lastDigest,
  monthlyBurnUsd: orgs.monthlyBurnUsd,
  publicDemo: orgs.publicDemo,
  tempoAccount: orgs.tempoAccount,
  solanaOwner: orgs.solanaOwner,
};

// Without the stored quote, which is evidence and not something to list.
const SWAP = {
  id: swaps.id,
  orgId: swaps.orgId,
  purpose: swaps.purpose,
  originAsset: swaps.originAsset,
  destinationAsset: swaps.destinationAsset,
  amountIn: swaps.amountIn,
  minAmountOut: swaps.minAmountOut,
  amountOut: swaps.amountOut,
  depositAddress: swaps.depositAddress,
  recipient: swaps.recipient,
  state: swaps.state,
  originTxs: swaps.originTxs,
  destinationTxs: swaps.destinationTxs,
  createdAt: swaps.createdAt,
  updatedAt: swaps.updatedAt,
};

const RUN = {
  id: payoutRuns.id,
  orgId: payoutRuns.orgId,
  chain: payoutRuns.chain,
  token: payoutRuns.token,
  tokenSymbol: payoutRuns.tokenSymbol,
  tokenDecimals: payoutRuns.tokenDecimals,
  account: payoutRuns.account,
  notBefore: payoutRuns.notBefore,
  status: payoutRuns.status,
  total: payoutRuns.total,
  tx: payoutRuns.tx,
  error: payoutRuns.error,
  createdAt: payoutRuns.createdAt,
  executedAt: payoutRuns.executedAt,
};

const LINE = {
  runId: payoutLines.runId,
  lineNo: payoutLines.lineNo,
  payeeName: payoutLines.payeeName,
  toAddress: payoutLines.toAddress,
  amount: payoutLines.amount,
  memo: payoutLines.memo,
  reference: payoutLines.reference,
  tx: payoutLines.tx,
  logIndex: payoutLines.logIndex,
  reconciled: payoutLines.reconciled,
  receiptToken: payoutLines.receiptToken,
};

const REFUSAL = {
  id: refusals.id,
  chain: refusals.chain,
  kind: refusals.kind,
  attempted: refusals.attempted,
  outcome: refusals.outcome,
  tx: refusals.tx,
  evidence: refusals.evidence,
  createdAt: refusals.createdAt,
};

const AUDIT_LINK = {
  tokenHash: auditLinks.tokenHash,
  orgId: auditLinks.orgId,
  label: auditLinks.label,
  scope: auditLinks.scope,
  expiresAt: auditLinks.expiresAt,
  revokedAt: auditLinks.revokedAt,
  createdAt: auditLinks.createdAt,
};

// Without the balance and the salt: they are what the commitment hides, and are read only to open it.
const ATTESTATION = {
  id: attestations.id,
  orgId: attestations.orgId,
  series: attestations.series,
  number: attestations.number,
  tx: attestations.tx,
  journalCount: attestations.journalCount,
  journalRoot: attestations.journalRoot,
  commitment: attestations.commitment,
  sentAt: attestations.sentAt,
  status: attestations.status,
  detail: attestations.detail,
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

  /**
   * Register an organisation together with the service keys it starts with.
   * Either all of it is written or none, so that no organisation is left
   * without the keys the service acts for it with.
   */
  async createOrg(init: NewOrg, serviceKeys: readonly NewServiceKey[] = []): Promise<void> {
    await this.db.transaction(async (tx) => {
      const created = await tx
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
          tempoAccount: init.tempoAccount ?? null,
          solanaOwner: init.solanaOwner ?? null,
        })
        .onConflictDoNothing({ target: orgs.id })
        .returning({ id: orgs.id });
      if (created.length === 0) throw new Error(`organisation ${init.id} already exists`);
      for (const key of serviceKeys) await this.writeKey(tx, init.id, key);
    });
  }

  async updateOrg(orgId: string, patch: OrgPatch): Promise<void> {
    const { name, hlUser, policy, lockEnabled, monthlyBurnUsd, publicDemo, tempoAccount, solanaOwner } = patch;
    const changes = { name, hlUser, policy, lockEnabled, monthlyBurnUsd, publicDemo, tempoAccount, solanaOwner };
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

  /** An organisation without its viewing key, or null when there is none under this id. */
  async findOrg(orgId: string): Promise<OrgRecord | null> {
    const [row] = await this.db.select(ORG).from(orgs).where(eq(orgs.id, orgId));
    return row ?? null;
  }

  /**
   * Organisations, oldest first. `owner` is the Hyperliquid account that
   * controls them; it is hex, so it is compared without regard to case.
   */
  async listOrgs(filter: { owner?: string; publicDemo?: boolean } = {}): Promise<OrgRecord[]> {
    return this.db
      .select(ORG)
      .from(orgs)
      .where(
        and(
          filter.owner === undefined ? undefined : eq(sql`lower(${orgs.hlUser})`, filter.owner.toLowerCase()),
          filter.publicDemo === undefined ? undefined : eq(orgs.publicDemo, filter.publicDemo),
        ),
      )
      .orderBy(asc(orgs.createdAt), asc(orgs.id));
  }

  /** The time a row is stamped with: the test's when there is one, the database's own otherwise. */
  private stamp(): number | undefined {
    return this.clockForTests?.();
  }

  /** Take the organisation's row for the rest of the transaction, so that what follows happens one at a time for it. */
  private async lockOrg(tx: Database, orgId: string): Promise<void> {
    const [org] = await tx.select({ id: orgs.id }).from(orgs).where(eq(orgs.id, orgId)).for('update');
    if (org === undefined) throw unknownOrg(orgId);
  }

  private async writeKey(tx: Database, orgId: string, key: NewServiceKey): Promise<boolean> {
    const sameKind = and(eq(keys.orgId, orgId), eq(keys.kind, key.kind));
    const [known] = await tx
      .select({ status: keys.status })
      .from(keys)
      .where(and(sameKind, eq(keys.address, key.address)));
    if (known !== undefined) {
      if (known.status !== 'active') throw new Error(`the ${key.kind} key ${key.address} of ${orgId} was revoked and cannot be installed again`);
      return false;
    }
    await tx
      .update(keys)
      .set({ status: 'revoked', revokedAt: this.clock() })
      .where(and(sameKind, eq(keys.status, 'active')));
    await tx.insert(keys).values({
      orgId,
      kind: key.kind,
      address: key.address,
      secretEnc: encryptSecret(key.secret, this.masterKey, keyContext(orgId, key.kind, key.address)),
      status: 'active',
      createdAt: this.stamp(),
    });
    return true;
  }

  /**
   * Make `key` the organisation's active key of its kind. A key that is
   * already installed is left alone; another active key of the same kind is
   * marked revoked. Returns whether anything was written.
   */
  async installKey(orgId: string, key: NewServiceKey): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      await this.lockOrg(tx, orgId);
      return this.writeKey(tx, orgId, key);
    });
  }

  /** Every key the organisation has or had, newest first. Secrets are not among what is read. */
  async listKeys(orgId: string): Promise<ServiceKey[]> {
    const rows = await this.db
      .select({ kind: keys.kind, address: keys.address, status: keys.status, createdAt: keys.createdAt, revokedAt: keys.revokedAt })
      .from(keys)
      .where(eq(keys.orgId, orgId))
      .orderBy(desc(keys.createdAt), asc(keys.kind), asc(keys.address));
    return rows.map((row) => ({ ...row, status: row.status === 'active' ? 'active' : 'revoked' }));
  }

  /** The active key of a kind with its secret decrypted, or null when the organisation has none. */
  async activeKey(orgId: string, kind: KeyKind): Promise<{ address: string; secret: string } | null> {
    const [row] = await this.db
      .select({ address: keys.address, secretEnc: keys.secretEnc })
      .from(keys)
      .where(and(eq(keys.orgId, orgId), eq(keys.kind, kind), eq(keys.status, 'active')));
    if (row === undefined) return null;
    return { address: row.address, secret: decryptSecret(row.secretEnc, this.masterKey, keyContext(orgId, kind, row.address)) };
  }

  /**
   * Keep a sign-in challenge for `ttlMs` by the database's clock, and say when
   * it runs out. Challenges that already ran out are removed on the way.
   */
  async issueNonce(nonce: string, ttlMs: number): Promise<number> {
    if (!Number.isInteger(ttlMs) || ttlMs <= 0) throw new RangeError('a challenge must last a positive number of milliseconds');
    await this.db.delete(authNonces).where(lte(authNonces.expiresAt, this.clock()));
    const [issued] = await this.db
      .insert(authNonces)
      .values({
        nonce,
        expiresAt: sql`${this.clock()} + ${ttlMs}::double precision * interval '1 millisecond'`,
        createdAt: this.stamp(),
      })
      .returning({ expiresAt: authNonces.expiresAt });
    if (issued === undefined) throw new Error('the challenge was not stored');
    return issued.expiresAt;
  }

  /** Use a challenge up. True only for one that was issued, has not run out and was not used before. */
  async consumeNonce(nonce: string): Promise<boolean> {
    const used = await this.db
      .delete(authNonces)
      .where(and(eq(authNonces.nonce, nonce), gt(authNonces.expiresAt, this.clock())))
      .returning({ nonce: authNonces.nonce });
    return used.length > 0;
  }

  /**
   * Record a swap that was quoted. Its deposit address identifies it:
   * recording the same one again changes nothing and returns the row it has.
   */
  async recordSwap(orgId: string, swap: NewSwap): Promise<SwapRow> {
    const [created] = await this.db
      .insert(swaps)
      .values({
        orgId,
        purpose: swap.purpose,
        originAsset: swap.originAsset,
        destinationAsset: swap.destinationAsset,
        amountIn: swap.amountIn,
        minAmountOut: swap.minAmountOut,
        depositAddress: swap.depositAddress,
        recipient: swap.recipient,
        quote: swap.quote,
        state: swap.state,
        createdAt: this.stamp(),
        updatedAt: this.stamp(),
      })
      .onConflictDoNothing({ target: swaps.depositAddress })
      .returning(SWAP);
    if (created !== undefined) return created;
    const [existing] = await this.db.select(SWAP).from(swaps).where(eq(swaps.depositAddress, swap.depositAddress));
    if (existing === undefined || existing.orgId !== orgId) {
      throw new Error(`deposit address ${swap.depositAddress} already belongs to another swap`);
    }
    return existing;
  }

  async findSwap(orgId: string, swapId: string): Promise<SwapRow | null> {
    // The id column is a uuid; anything else could not be one of its values.
    if (!UUID.test(swapId)) return null;
    const [row] = await this.db
      .select(SWAP)
      .from(swaps)
      .where(and(eq(swaps.orgId, orgId), eq(swaps.id, swapId)));
    return row ?? null;
  }

  /** Newest first. */
  async listSwaps(orgId: string): Promise<SwapRow[]> {
    return this.db.select(SWAP).from(swaps).where(eq(swaps.orgId, orgId)).orderBy(desc(swaps.createdAt), asc(swaps.id));
  }

  /**
   * Write down what the swap service last said about a swap. One that has
   * settled cannot change any more and is left as it is. Returns the row as
   * it now stands, or null when the organisation has no such swap.
   */
  async updateSwap(orgId: string, swapId: string, seen: SwapSighting): Promise<SwapRow | null> {
    if (!UUID.test(swapId)) return null;
    const [updated] = await this.db
      .update(swaps)
      .set({
        state: seen.state,
        originTxs: seen.originTxs,
        destinationTxs: seen.destinationTxs,
        amountOut: seen.amountOut,
        updatedAt: this.clock(),
      })
      .where(and(eq(swaps.orgId, orgId), eq(swaps.id, swapId), notInArray(swaps.state, SETTLED_SWAP_STATES)))
      .returning(SWAP);
    return updated ?? this.findSwap(orgId, swapId);
  }

  /** Swaps of every organisation that can still change state; the one looked at longest ago comes first. */
  async unsettledSwaps(limit = DEFAULT_PAGE): Promise<SwapRow[]> {
    return this.db
      .select(SWAP)
      .from(swaps)
      .where(notInArray(swaps.state, SETTLED_SWAP_STATES))
      .orderBy(asc(swaps.updatedAt), asc(swaps.id))
      .limit(limit);
  }

  private async insertRun(
    tx: Database,
    orgId: string,
    run: Pick<PayoutRunRow, 'id' | 'chain' | 'token' | 'tokenSymbol' | 'tokenDecimals' | 'account' | 'notBefore' | 'status' | 'tx' | 'createdAt' | 'executedAt'>,
    lines: readonly (NewPayoutLine & { tx?: string | null; logIndex?: number | null; reconciled?: boolean })[],
  ): Promise<void> {
    if (lines.length === 0) throw new RangeError(`run ${run.id} has no lines`);
    for (const [index, line] of lines.entries()) {
      if (line.amount <= 0n) throw new RangeError(`line ${index + 1} of run ${run.id} must pay a positive amount`);
    }
    await tx.insert(payoutRuns).values({
      id: run.id,
      orgId,
      chain: run.chain,
      token: run.token,
      tokenSymbol: run.tokenSymbol,
      tokenDecimals: run.tokenDecimals,
      account: run.account,
      notBefore: run.notBefore,
      status: run.status,
      total: lines.reduce((sum, line) => sum + line.amount, 0n),
      tx: run.tx,
      createdAt: run.createdAt,
      executedAt: run.executedAt,
    });
    await tx.insert(payoutLines).values(
      lines.map((line, index) => ({
        orgId,
        runId: run.id,
        lineNo: index + 1,
        payeeName: line.payeeName,
        toAddress: line.toAddress,
        amount: line.amount,
        memo: line.memo,
        reference: line.reference,
        tx: line.tx ?? null,
        logIndex: line.logIndex ?? null,
        reconciled: line.reconciled ?? false,
        receiptToken: randomBytes(RECEIPT_TOKEN_BYTES).toString('base64url'),
      })),
    );
  }

  /**
   * Create a draft run under the next id of its month: HF-2026-10-0001,
   * HF-2026-10-0002 and so on, counted for each organisation on its own.
   */
  async createPayoutRun(orgId: string, run: NewPayoutRun): Promise<PayoutRunRow> {
    const prefix = runIdPrefix(run.at);
    const id = await this.db.transaction(async (tx) => {
      await this.lockOrg(tx, orgId);
      const [last] = await tx
        .select({ id: payoutRuns.id })
        .from(payoutRuns)
        .where(and(eq(payoutRuns.orgId, orgId), like(payoutRuns.id, `${prefix}%`)))
        .orderBy(desc(payoutRuns.id))
        .limit(1);
      const taken = last === undefined ? 0 : runNumberOf(last.id);
      if (taken === null) throw new Error(`run ${last?.id} of ${orgId} is not numbered, so the next number cannot be told`);
      if (taken >= MAX_RUNS_PER_MONTH) throw new RangeError(`${orgId} has used every run id of ${prefix.slice(3, -1)}`);
      const next = runIdOf(run.at, taken + 1);
      await this.insertRun(
        tx,
        orgId,
        {
          id: next,
          chain: run.chain,
          token: run.token,
          tokenSymbol: run.tokenSymbol,
          tokenDecimals: run.tokenDecimals,
          account: run.account,
          notBefore: run.notBefore,
          status: 'draft',
          tx: null,
          createdAt: run.at,
          executedAt: null,
        },
        run.lines(next),
      );
      return next;
    });
    const created = await this.findPayoutRun(orgId, id);
    if (created === null) throw new Error(`run ${id} of ${orgId} was not stored`);
    return created;
  }

  /**
   * Record a run that was paid before the database knew of it. Returns false,
   * and writes nothing, when the organisation already has a run under this id.
   */
  async importPaidRun(orgId: string, run: PaidPayoutRun): Promise<boolean> {
    if (runNumberOf(run.id) === null) throw new RangeError(`"${run.id}" is not a run id of the form HF-YYYY-MM-NNNN`);
    return this.db.transaction(async (tx) => {
      await this.lockOrg(tx, orgId);
      const known = await tx
        .select({ id: payoutRuns.id })
        .from(payoutRuns)
        .where(and(eq(payoutRuns.orgId, orgId), eq(payoutRuns.id, run.id)));
      if (known.length > 0) return false;
      await this.insertRun(
        tx,
        orgId,
        {
          id: run.id,
          chain: run.chain,
          token: run.token,
          tokenSymbol: run.tokenSymbol,
          tokenDecimals: run.tokenDecimals,
          account: run.account,
          notBefore: run.notBefore,
          status: 'paid',
          tx: run.tx,
          createdAt: run.createdAt,
          executedAt: run.executedAt,
        },
        run.lines.map((line) => ({ ...line, reconciled: true })),
      );
      return true;
    });
  }

  private async linesOf(orgId: string, runId?: string): Promise<Map<string, PayoutLineRow[]>> {
    const rows = await this.db
      .select(LINE)
      .from(payoutLines)
      .where(and(eq(payoutLines.orgId, orgId), runId === undefined ? undefined : eq(payoutLines.runId, runId)))
      .orderBy(asc(payoutLines.runId), asc(payoutLines.lineNo));
    const byRun = new Map<string, PayoutLineRow[]>();
    for (const { runId: owner, ...line } of rows) byRun.set(owner, [...(byRun.get(owner) ?? []), line]);
    return byRun;
  }

  async findPayoutRun(orgId: string, runId: string): Promise<PayoutRunRow | null> {
    const [run] = await this.db
      .select(RUN)
      .from(payoutRuns)
      .where(and(eq(payoutRuns.orgId, orgId), eq(payoutRuns.id, runId)));
    if (run === undefined) return null;
    return { ...run, lines: (await this.linesOf(orgId, runId)).get(runId) ?? [] };
  }

  /** Newest first. */
  async listPayoutRuns(orgId: string): Promise<PayoutRunRow[]> {
    const runs = await this.db.select(RUN).from(payoutRuns).where(eq(payoutRuns.orgId, orgId)).orderBy(desc(payoutRuns.createdAt), desc(payoutRuns.id));
    const lines = await this.linesOf(orgId);
    return runs.map((run) => ({ ...run, lines: lines.get(run.id) ?? [] }));
  }

  /**
   * Mark a run as being sent and say what it was before. A run that is paid
   * stays paid. Null when the organisation has no such run.
   */
  async beginPayoutRun(orgId: string, runId: string): Promise<PayoutStatus | null> {
    return this.db.transaction(async (tx) => {
      const which = and(eq(payoutRuns.orgId, orgId), eq(payoutRuns.id, runId));
      const [run] = await tx.select({ status: payoutRuns.status }).from(payoutRuns).where(which).for('update');
      if (run === undefined) return null;
      if (run.status !== 'paid') await tx.update(payoutRuns).set({ status: 'sending' }).where(which);
      return run.status;
    });
  }

  /**
   * Write down how an attempt to pay a run ended. A run recorded as paid is
   * not changed to anything else: an attempt that ended otherwise is not the
   * one that paid it. Returns the run as it now stands.
   */
  async settlePayoutRun(orgId: string, runId: string, outcome: PayoutSettlement): Promise<PayoutRunRow | null> {
    await this.db.transaction(async (tx) => {
      const settled = await tx
        .update(payoutRuns)
        .set({ status: outcome.status, tx: outcome.tx, error: outcome.error, executedAt: outcome.executedAt })
        .where(and(eq(payoutRuns.orgId, orgId), eq(payoutRuns.id, runId), outcome.status === 'paid' ? undefined : ne(payoutRuns.status, 'paid')))
        .returning({ id: payoutRuns.id });
      if (settled.length === 0) return;
      for (const line of outcome.lines ?? []) {
        await tx
          .update(payoutLines)
          .set({ tx: line.tx, logIndex: line.logIndex, reconciled: line.reconciled })
          .where(and(eq(payoutLines.orgId, orgId), eq(payoutLines.runId, runId), eq(payoutLines.lineNo, line.lineNo)));
      }
    });
    return this.findPayoutRun(orgId, runId);
  }

  /** The line a receipt token stands for, with its run; null for a token that was never given out. */
  async findReceipt(token: string): Promise<{ run: Omit<PayoutRunRow, 'lines'>; line: PayoutLineRow } | null> {
    const [found] = await this.db
      .select({ run: RUN, line: LINE })
      .from(payoutLines)
      .innerJoin(payoutRuns, and(eq(payoutRuns.orgId, payoutLines.orgId), eq(payoutRuns.id, payoutLines.runId)))
      .where(eq(payoutLines.receiptToken, token));
    if (found === undefined) return null;
    const { runId: _run, ...line } = found.line;
    return { run: found.run, line };
  }

  /**
   * Keep the evidence of a refusal. One transaction is one refusal: recording
   * it a second time writes nothing and returns null.
   */
  async recordRefusal(orgId: string, refusal: NewRefusal): Promise<RefusalRow | null> {
    const [row] = await this.db
      .insert(refusals)
      .values({
        orgId,
        chain: refusal.chain,
        kind: refusal.kind,
        attempted: refusal.attempted,
        outcome: refusal.outcome,
        tx: refusal.tx,
        evidence: refusal.evidence,
        createdAt: this.stamp(),
      })
      .onConflictDoNothing({ target: [refusals.orgId, refusals.tx] })
      .returning(REFUSAL);
    return row ?? null;
  }

  /** Newest first. */
  async listRefusals(orgId: string, limit = DEFAULT_PAGE): Promise<RefusalRow[]> {
    return this.db.select(REFUSAL).from(refusals).where(eq(refusals.orgId, orgId)).orderBy(desc(refusals.createdAt), asc(refusals.id)).limit(limit);
  }

  async createAuditLink(orgId: string, link: NewAuditLink): Promise<AuditLinkRow> {
    const [row] = await this.db
      .insert(auditLinks)
      .values({ orgId, tokenHash: link.tokenHash, label: link.label, scope: link.scope, expiresAt: link.expiresAt, createdAt: this.stamp() })
      .returning(AUDIT_LINK);
    if (row === undefined) throw new Error('the auditor link was not stored');
    return row;
  }

  /** Newest first; revoked and expired links are listed too. */
  async listAuditLinks(orgId: string): Promise<AuditLinkRow[]> {
    return this.db.select(AUDIT_LINK).from(auditLinks).where(eq(auditLinks.orgId, orgId)).orderBy(desc(auditLinks.createdAt), asc(auditLinks.tokenHash));
  }

  /**
   * Take a link away, from this moment by the database's clock. Returns the
   * link as it now stands, or null when the organisation has no such link.
   * Revoking one that is already revoked leaves its first revocation in place.
   */
  async revokeAuditLink(orgId: string, tokenHash: string): Promise<AuditLinkRow | null> {
    const which = and(eq(auditLinks.orgId, orgId), eq(auditLinks.tokenHash, tokenHash));
    const [revoked] = await this.db
      .update(auditLinks)
      .set({ revokedAt: this.clock() })
      .where(and(which, isNull(auditLinks.revokedAt)))
      .returning(AUDIT_LINK);
    if (revoked !== undefined) return revoked;
    const [existing] = await this.db.select(AUDIT_LINK).from(auditLinks).where(which);
    return existing ?? null;
  }

  /** The link a token hash stands for, unless it was revoked or has run out by the database's clock. */
  async liveAuditLink(tokenHash: string): Promise<AuditLinkRow | null> {
    const [row] = await this.db
      .select(AUDIT_LINK)
      .from(auditLinks)
      .where(and(eq(auditLinks.tokenHash, tokenHash), isNull(auditLinks.revokedAt), or(isNull(auditLinks.expiresAt), gt(auditLinks.expiresAt, this.clock()))));
    return row ?? null;
  }

  /**
   * Keep an attempt to record a snapshot. The salt of its commitment is
   * encrypted like every other secret. One transaction is one attestation,
   * and so is one snapshot: recording either a second time writes nothing and
   * returns null. So does recording a pending attestation while another of
   * the organisation is pending: there is one at a time.
   */
  async recordAttestation(orgId: string, attestation: NewAttestation): Promise<AttestationRow | null> {
    const { treasury } = attestation;
    if ((attestation.number !== null) !== (attestation.status === 'confirmed')) {
      throw new RangeError('a snapshot has a number once the chain holds it, and not before');
    }
    if (attestation.tx !== null && treasury === null) throw new RangeError('an attestation that was sent carries a treasury commitment');
    const [row] = await this.db
      .insert(attestations)
      .values({
        orgId,
        series: attestation.series,
        number: attestation.number,
        tx: attestation.tx,
        journalCount: attestation.journalCount,
        journalRoot: attestation.journalRoot,
        treasuryZat: treasury?.zat ?? null,
        saltEnc: treasury === null ? null : encryptSecret(treasury.salt, this.masterKey, saltContext(orgId, treasury.commitment)),
        commitment: treasury?.commitment ?? null,
        sentAt: attestation.sentAt,
        status: attestation.status,
        detail: attestation.detail,
      })
      .onConflictDoNothing()
      .returning(ATTESTATION);
    return row ?? null;
  }

  /**
   * Write down how a pending attestation ended. One that already ended is
   * left as it is. Returns the row as it now stands, or null when the
   * organisation has no such attestation.
   */
  async settleAttestation(orgId: string, attestationId: string, outcome: AttestationOutcome): Promise<AttestationRow | null> {
    if (!UUID.test(attestationId)) return null;
    const which = and(eq(attestations.orgId, orgId), eq(attestations.id, attestationId));
    const changes =
      outcome.status === 'confirmed'
        ? { status: outcome.status, series: outcome.series, number: outcome.number, detail: null }
        : { status: outcome.status, detail: outcome.detail };
    const [settled] = await this.db
      .update(attestations)
      .set(changes)
      .where(and(which, eq(attestations.status, 'pending')))
      .returning(ATTESTATION);
    if (settled !== undefined) return settled;
    const [existing] = await this.db.select(ATTESTATION).from(attestations).where(which);
    return existing ?? null;
  }

  /** Newest first. */
  async listAttestations(orgId: string, limit = DEFAULT_PAGE): Promise<AttestationRow[]> {
    return this.db.select(ATTESTATION).from(attestations).where(eq(attestations.orgId, orgId)).orderBy(desc(attestations.sentAt), asc(attestations.id)).limit(limit);
  }

  /** The attestation of an organisation whose end is not known yet, or null when it has none. There is never more than one. */
  async pendingAttestation(orgId: string): Promise<AttestationRow | null> {
    const [row] = await this.db
      .select(ATTESTATION)
      .from(attestations)
      .where(and(eq(attestations.orgId, orgId), eq(attestations.status, 'pending')));
    return row ?? null;
  }

  /** The latest attempt the contract refused in one series, or null when it refused none there. */
  async refusedAttestation(orgId: string, series: bigint): Promise<AttestationRow | null> {
    const [row] = await this.db
      .select(ATTESTATION)
      .from(attestations)
      .where(and(eq(attestations.orgId, orgId), eq(attestations.series, series), eq(attestations.status, 'refused')))
      .orderBy(desc(attestations.sentAt), asc(attestations.id))
      .limit(1);
    return row ?? null;
  }

  /**
   * The attestations behind the snapshots of one series with these numbers,
   * highest number first. A snapshot the service did not record is simply not
   * among them.
   */
  async snapshotAttestations(orgId: string, series: bigint, numbers: readonly bigint[]): Promise<AttestationRow[]> {
    if (numbers.length === 0) return [];
    return this.db
      .select(ATTESTATION)
      .from(attestations)
      .where(and(eq(attestations.orgId, orgId), eq(attestations.series, series), inArray(attestations.number, [...numbers])))
      .orderBy(desc(attestations.number));
  }

  /**
   * What the treasury commitment of a snapshot was made from: the balance and
   * the salt, decrypted. Null for a snapshot the service did not record.
   */
  async openAttestation(orgId: string, series: bigint, number: bigint): Promise<TreasuryOpening | null> {
    const [row] = await this.db
      .select({ zat: attestations.treasuryZat, saltEnc: attestations.saltEnc, commitment: attestations.commitment })
      .from(attestations)
      .where(and(eq(attestations.orgId, orgId), eq(attestations.series, series), eq(attestations.number, number)));
    if (row === undefined || row.zat === null || row.saltEnc === null || row.commitment === null) return null;
    return { zat: row.zat, salt: decryptSecret(row.saltEnc, this.masterKey, saltContext(orgId, row.commitment)) as Hex, commitment: row.commitment };
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
