import { afterAll, beforeAll, describe } from 'vitest';
import type { PgliteConnection } from '../src';
import { storeContract } from './store-contract';
import { STARTUP_TIMEOUT_MS, memoryUnderTest, migratedPglite, pgUnderTest } from './support/stores';

describe('MemoryStore', () => {
  storeContract(async () => memoryUnderTest());
});

describe('PgStore on PGlite', () => {
  let connection: PgliteConnection;

  beforeAll(async () => {
    connection = await migratedPglite();
  }, STARTUP_TIMEOUT_MS);

  afterAll(() => connection.close());

  storeContract(async () => pgUnderTest(connection.db));
});
