import { randomUUID } from 'node:crypto';
import { DEFAULT_POLICY } from '@holdfast/core';
import { MemoryStore } from '@holdfast/engine';
import { type Database, PgStore, type PgStoreOptions, type PgliteConnection, connectPglite, migrate } from '../../src';
import type { StoreUnderTest } from '../store-contract';
import { BIRTHDAY } from './fakes';

export const MASTER_KEY = new Uint8Array(32).fill(7);

/** The widest sequence number the journal's integer column holds. */
const LAST_SEQ = 2_147_483_647;

export const ORG = {
  ufvk: 'uview1test',
  birthday: BIRTHDAY,
  hlUser: '0xabc',
  policy: DEFAULT_POLICY,
  lockEnabled: true,
};

/** Starting Postgres takes a moment, far longer than any test should. */
export const STARTUP_TIMEOUT_MS = 120_000;

export async function migratedPglite(): Promise<PgliteConnection> {
  const connection = await connectPglite();
  await migrate(connection.db);
  return connection;
}

export const pgStore = (db: Database, options: Partial<PgStoreOptions> = {}) =>
  new PgStore(db, { masterKey: MASTER_KEY, ...options });

export function memoryUnderTest(): StoreUnderTest {
  const store = new MemoryStore();
  return {
    store,
    async addOrg(id = randomUUID()) {
      store.addOrg({ id, ...ORG });
      return id;
    },
    notes: async (orgId) => store.notes(orgId),
    outgoing: async (orgId) => store.outgoing(orgId),
    untrackedBalance: async (orgId) => store.untrackedBalance(orgId),
    journal: async (orgId) => store.journal(orgId),
  };
}

/** Tests share one database and keep apart by giving every organisation its own id. */
export function pgUnderTest(db: Database, options: Partial<PgStoreOptions> = {}): StoreUnderTest & { store: PgStore } {
  const store = pgStore(db, options);
  return {
    store,
    async addOrg(id = randomUUID()) {
      await store.createOrg({ id, name: 'Test Org', ...ORG });
      return id;
    },
    notes: (orgId) => store.notes(orgId),
    outgoing: (orgId) => store.outgoing(orgId),
    untrackedBalance: (orgId) => store.untrackedBalance(orgId),
    journal: (orgId) => store.journalRange(orgId, 1, LAST_SEQ),
  };
}
