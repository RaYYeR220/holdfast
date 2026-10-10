import type { Hex, OutgoingPayment, OwnedNote, Policy } from '@holdfast/core';
import type { JournalEntry } from '@holdfast/engine';
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  doublePrecision,
  foreignKey,
  index,
  integer,
  pgSchema,
  primaryKey,
  text,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { baseUnits, epochMs, freeText, json, zat } from './columns';

/** Everything lives here, so the schema the public API serves stays empty. */
export const holdfast = pgSchema('holdfast');

// The same value as ZERO_ROOT in the core package; drizzle-kit loads this file
// on its own, so nothing here is imported from the workspace at run time.
const ZERO_ROOT: Hex = `0x${'00'.repeat(32)}`;

export const KEY_KINDS = ['hl_agent', 'tempo_access', 'tempo_sponsor', 'solana_delegate'] as const;
export const SWAP_PURPOSES = ['margin', 'payout_float', 'unlock'] as const;
export const PAYOUT_CHAINS = ['tempo', 'solana'] as const;
export const PAYOUT_STATUSES = ['draft', 'approved', 'sending', 'paid', 'failed', 'refused'] as const;

const oneOf = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(', '));

export const orgs = holdfast
  .table(
    'orgs',
    {
      id: text('id').primaryKey(),
      name: freeText('name').notNull(),
      createdAt: epochMs('created_at').notNull().default(sql`now()`),
      ufvkEnc: text('ufvk_enc').notNull(),
      birthday: integer('birthday').notNull(),
      scannedTo: integer('scanned_to'),
      tipHeight: integer('tip_height'),
      tipSince: epochMs('tip_since'),
      hlUser: text('hl_user').notNull(),
      policy: json('policy').$type<Policy>().notNull(),
      lockEnabled: boolean('lock_enabled').notNull().default(false),
      nextSeq: integer('next_seq').notNull().default(1),
      lastDigest: text('last_digest').$type<Hex>().notNull().default(ZERO_ROOT),
      tickLeaseUntil: epochMs('tick_lease_until'),
      /** Minted afresh each time the lease is taken; a write made under an older one is refused. */
      tickLeaseToken: uuid('tick_lease_token'),
      monthlyBurnUsd: doublePrecision('monthly_burn_usd'),
      publicDemo: boolean('public_demo').notNull().default(false),
    },
    (t) => [check('orgs_tip_is_whole', sql`(${t.tipHeight} is null) = (${t.tipSince} is null)`)],
  )
  .enableRLS();

export const keys = holdfast
  .table(
    'keys',
    {
      orgId: text('org_id')
        .notNull()
        .references(() => orgs.id),
      kind: text('kind', { enum: KEY_KINDS }).notNull(),
      /** The public half: an address, or whatever id the chain gives the key. */
      address: text('address').notNull(),
      secretEnc: text('secret_enc').notNull(),
      status: text('status').notNull(),
      createdAt: epochMs('created_at').notNull().default(sql`now()`),
      revokedAt: epochMs('revoked_at'),
    },
    (t) => [
      primaryKey({ columns: [t.orgId, t.kind, t.address] }),
      check('keys_kind_is_known', sql`${t.kind} in (${oneOf(KEY_KINDS)})`),
    ],
  )
  .enableRLS();

export const zcashNotes = holdfast
  .table(
    'zcash_notes',
    {
      orgId: text('org_id')
        .notNull()
        .references(() => orgs.id),
      id: text('id').notNull(),
      txid: text('txid').notNull(),
      height: integer('height').notNull(),
      time: epochMs('time').notNull(),
      zat: zat('zat').notNull(),
      memo: freeText('memo').notNull(),
      pool: text('pool').$type<OwnedNote['pool']>().notNull(),
      kind: text('kind').$type<OwnedNote['kind']>().notNull(),
      nullifier: text('nullifier'),
      spent: boolean('spent').notNull().default(false),
    },
    (t) => [
      primaryKey({ columns: [t.orgId, t.id] }),
      index('zcash_notes_height_idx').on(t.orgId, t.height),
      index('zcash_notes_unspent_idx').on(t.orgId, t.nullifier).where(sql`not ${t.spent}`),
    ],
  )
  .enableRLS();

export const zcashOutgoing = holdfast
  .table(
    'zcash_outgoing',
    {
      orgId: text('org_id')
        .notNull()
        .references(() => orgs.id),
      id: text('id').notNull(),
      txid: text('txid').notNull(),
      height: integer('height').notNull(),
      time: epochMs('time').notNull(),
      zat: zat('zat').notNull(),
      memo: freeText('memo').notNull(),
      pool: text('pool').$type<OutgoingPayment['pool']>().notNull(),
    },
    (t) => [primaryKey({ columns: [t.orgId, t.id] }), index('zcash_outgoing_height_idx').on(t.orgId, t.height)],
  )
  .enableRLS();

export const zcashFees = holdfast
  .table(
    'zcash_fees',
    {
      orgId: text('org_id')
        .notNull()
        .references(() => orgs.id),
      txid: text('txid').notNull(),
      height: integer('height').notNull(),
      zat: zat('zat').notNull(),
    },
    (t) => [primaryKey({ columns: [t.orgId, t.txid] }), index('zcash_fees_height_idx').on(t.orgId, t.height)],
  )
  .enableRLS();

export const journal = holdfast
  .table(
    'journal',
    {
      orgId: text('org_id')
        .notNull()
        .references(() => orgs.id),
      seq: integer('seq').notNull(),
      at: epochMs('at').notNull(),
      prev: text('prev').$type<Hex>().notNull(),
      digest: text('digest').$type<Hex>().notNull(),
      /** The whole entry; the columns beside it only repeat what queries filter on. */
      entry: json('entry').$type<JournalEntry>().notNull(),
      mode: text('mode').$type<JournalEntry['decision']['mode']>().notNull(),
      hasOrder: boolean('has_order').notNull(),
    },
    (t) => [primaryKey({ columns: [t.orgId, t.seq] }), unique('journal_digest_key').on(t.orgId, t.digest)],
  )
  .enableRLS();

export const orders = holdfast
  .table(
    'orders',
    {
      orgId: text('org_id').notNull(),
      /** The journal entry that placed the order. */
      seq: integer('seq').notNull(),
      cloid: text('cloid').$type<Hex>().notNull(),
      side: text('side', { enum: ['buy', 'sell'] }).notNull(),
      // Lots and prices are whatever the controller and the venue reported:
      // a column that rejected one of them would cost the journal its entry.
      lots: doublePrecision('lots').notNull(),
      limitPx: doublePrecision('limit_px').notNull(),
      reduceOnly: boolean('reduce_only').notNull(),
      ok: boolean('ok').notNull(),
      filledLots: doublePrecision('filled_lots').notNull(),
      avgPx: doublePrecision('avg_px'),
      oid: freeText('oid'),
      error: freeText('error'),
    },
    (t) => [
      primaryKey({ columns: [t.orgId, t.cloid] }),
      foreignKey({ columns: [t.orgId, t.seq], foreignColumns: [journal.orgId, journal.seq] }),
      index('orders_seq_idx').on(t.orgId, t.seq),
    ],
  )
  .enableRLS();

export const swaps = holdfast
  .table(
    'swaps',
    {
      id: uuid('id').primaryKey().defaultRandom(),
      orgId: text('org_id')
        .notNull()
        .references(() => orgs.id),
      purpose: text('purpose', { enum: SWAP_PURPOSES }).notNull(),
      originAsset: text('origin_asset').notNull(),
      destinationAsset: text('destination_asset').notNull(),
      amountIn: baseUnits('amount_in').notNull(),
      minAmountOut: baseUnits('min_amount_out').notNull(),
      depositAddress: text('deposit_address').notNull().unique(),
      recipient: text('recipient').notNull(),
      quote: json('quote').notNull(),
      state: text('state').notNull(),
      originTxs: json('origin_txs').$type<string[]>().notNull().default([]),
      destinationTxs: json('destination_txs').$type<string[]>().notNull().default([]),
      amountOut: baseUnits('amount_out'),
      createdAt: epochMs('created_at').notNull().default(sql`now()`),
      updatedAt: epochMs('updated_at').notNull().default(sql`now()`),
    },
    (t) => [
      index('swaps_org_idx').on(t.orgId, t.createdAt),
      check('swaps_purpose_is_known', sql`${t.purpose} in (${oneOf(SWAP_PURPOSES)})`),
    ],
  )
  .enableRLS();

export const payoutRuns = holdfast
  .table(
    'payout_runs',
    {
      /** Human-readable and carried on chain, e.g. HF-2026-10-0001. */
      id: text('id').primaryKey(),
      orgId: text('org_id')
        .notNull()
        .references(() => orgs.id),
      chain: text('chain', { enum: PAYOUT_CHAINS }).notNull(),
      token: text('token').notNull(),
      status: text('status', { enum: PAYOUT_STATUSES }).notNull(),
      total: baseUnits('total').notNull(),
      tx: text('tx'),
      error: freeText('error'),
      signedTx: text('signed_tx'),
      createdAt: epochMs('created_at').notNull().default(sql`now()`),
      executedAt: epochMs('executed_at'),
    },
    (t) => [
      index('payout_runs_org_idx').on(t.orgId, t.createdAt),
      check('payout_runs_chain_is_known', sql`${t.chain} in (${oneOf(PAYOUT_CHAINS)})`),
      check('payout_runs_status_is_known', sql`${t.status} in (${oneOf(PAYOUT_STATUSES)})`),
    ],
  )
  .enableRLS();

export const payoutLines = holdfast
  .table(
    'payout_lines',
    {
      runId: text('run_id')
        .notNull()
        .references(() => payoutRuns.id),
      lineNo: integer('line_no').notNull(),
      payeeName: freeText('payee_name').notNull(),
      toAddress: text('to_address').notNull(),
      amount: baseUnits('amount').notNull(),
      memo: freeText('memo').notNull(),
      tx: text('tx'),
      logIndex: integer('log_index'),
      reconciled: boolean('reconciled').notNull().default(false),
    },
    (t) => [primaryKey({ columns: [t.runId, t.lineNo] })],
  )
  .enableRLS();

/** What the system was asked to do and could not: the evidence that its limits hold. */
export const refusals = holdfast
  .table(
    'refusals',
    {
      id: uuid('id').primaryKey().defaultRandom(),
      orgId: text('org_id')
        .notNull()
        .references(() => orgs.id),
      chain: text('chain').notNull(),
      kind: text('kind').notNull(),
      attempted: freeText('attempted').notNull(),
      outcome: freeText('outcome').notNull(),
      tx: text('tx'),
      evidence: json('evidence').notNull(),
      createdAt: epochMs('created_at').notNull().default(sql`now()`),
    },
    (t) => [index('refusals_org_idx').on(t.orgId, t.createdAt)],
  )
  .enableRLS();

export const auditLinks = holdfast
  .table(
    'audit_links',
    {
      /** Only the hash of the bearer token is kept. */
      tokenHash: text('token_hash').primaryKey(),
      orgId: text('org_id')
        .notNull()
        .references(() => orgs.id),
      label: freeText('label').notNull(),
      scope: json('scope').notNull(),
      expiresAt: epochMs('expires_at'),
      revokedAt: epochMs('revoked_at'),
      createdAt: epochMs('created_at').notNull().default(sql`now()`),
    },
    (t) => [index('audit_links_org_idx').on(t.orgId)],
  )
  .enableRLS();
