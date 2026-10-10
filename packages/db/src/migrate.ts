import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { text } from 'drizzle-orm/pg-core';
import type { Database } from './client';
import { epochMs } from './columns';
import { MIGRATIONS } from './migrations';
import { holdfast } from './schema';

export interface Migration {
  /** File name without the extension; migrations run in the order they are listed. */
  name: string;
  sql: string;
}

const BREAKPOINT = '--> statement-breakpoint';

/** Kept out of the generated schema: the runner has to create it before the first migration. */
const applied = holdfast.table('migrations', {
  name: text('name').primaryKey(),
  hash: text('hash').notNull(),
  appliedAt: epochMs('applied_at').notNull().default(sql`now()`),
});

const BOOTSTRAP = [
  'CREATE SCHEMA IF NOT EXISTS "holdfast"',
  `CREATE TABLE IF NOT EXISTS "holdfast"."migrations" (
    "name" text PRIMARY KEY NOT NULL,
    "hash" text NOT NULL,
    "applied_at" timestamp with time zone DEFAULT now() NOT NULL
  )`,
  'ALTER TABLE "holdfast"."migrations" ENABLE ROW LEVEL SECURITY',
];

/** The statements of one migration file, one per round trip to the server. */
export function migrationStatements(migration: Migration): string[] {
  return migration.sql
    .split(BREAKPOINT)
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

export function migrationHash(migration: Migration): string {
  return createHash('sha256').update(migration.sql.replaceAll('\r\n', '\n')).digest('hex');
}

/**
 * Apply whatever has not been applied yet, in order and in one transaction,
 * and record it in `holdfast.migrations`. Returns the names it applied; an
 * empty list means the database was already up to date.
 */
export async function migrate(db: Database, migrations: readonly Migration[] = MIGRATIONS): Promise<string[]> {
  return db.transaction(async (tx) => {
    // Held until this transaction ends, so two deploys cannot apply the same
    // file at once. It is a transaction lock, not a session one: a pooler may
    // hand the connection to someone else the moment we commit.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('holdfast.migrations'))`);
    for (const statement of BOOTSTRAP) await tx.execute(sql.raw(statement));

    const recorded = new Map((await tx.select().from(applied)).map((row) => [row.name, row.hash]));
    const ran: string[] = [];
    for (const migration of migrations) {
      const hash = migrationHash(migration);
      const previous = recorded.get(migration.name);
      if (previous !== undefined) {
        if (previous !== hash) throw new Error(`migration ${migration.name} has changed since it was applied`);
        continue;
      }
      for (const statement of migrationStatements(migration)) await tx.execute(sql.raw(statement));
      await tx.insert(applied).values({ name: migration.name, hash });
      ran.push(migration.name);
    }
    return ran;
  });
}
