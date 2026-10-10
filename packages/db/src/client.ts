import type { PGlite } from '@electric-sql/pglite';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import { type PostgresJsDatabase, drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

/** A Drizzle database on either driver; the store and the migrations need nothing more specific. */
export type Database = PgDatabase<PgQueryResultHKT>;

export interface PostgresConnection {
  sql: postgres.Sql;
  db: PostgresJsDatabase;
  close(): Promise<void>;
}

export interface PgliteConnection {
  client: PGlite;
  db: PgliteDatabase;
  close(): Promise<void>;
}

/**
 * Connect to Postgres through a transaction-mode pooler. Each transaction may
 * land on a different server connection, so nothing is left behind on one: no
 * named prepared statements here, and no session state anywhere in this package.
 */
export function connect(databaseUrl: string, options: { max?: number } = {}): PostgresConnection {
  const sql = postgres(databaseUrl, {
    prepare: false,
    // Every serverless instance opens its own pool; the pooler in front has a fixed number of slots.
    max: options.max ?? 3,
    idle_timeout: 20,
    connect_timeout: 10,
    max_lifetime: 300,
    // Notices are informational ("already exists, skipping"); errors still throw.
    onnotice: () => {},
  });
  return { sql, db: drizzle(sql), close: () => sql.end({ timeout: 5 }) };
}

/**
 * Postgres in this process: in memory, or in `dataDir` when one is given.
 * PGlite is loaded on demand so that a deployment which never calls this does
 * not have to ship it.
 */
export async function connectPglite(dataDir?: string): Promise<PgliteConnection> {
  const [{ PGlite }, pglite] = await Promise.all([import('@electric-sql/pglite'), import('drizzle-orm/pglite')]);
  const client = new PGlite(dataDir);
  return { client, db: pglite.drizzle(client), close: () => client.close() };
}
