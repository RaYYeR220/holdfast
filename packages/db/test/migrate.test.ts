import { readFileSync, readdirSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MIGRATIONS, type Migration, type PgliteConnection, connectPglite, migrate, migrationHash, migrationStatements } from '../src';
import { STARTUP_TIMEOUT_MS, pgUnderTest } from './support/stores';

const TABLES = [
  'audit_links',
  'journal',
  'keys',
  'migrations',
  'orders',
  'orgs',
  'payout_lines',
  'payout_runs',
  'refusals',
  'swaps',
  'zcash_fees',
  'zcash_notes',
  'zcash_outgoing',
];

const INITIAL = MIGRATIONS[0] as Migration;
const LEASE_TOKEN = MIGRATIONS[1] as Migration;
const ALL = MIGRATIONS.map((migration) => migration.name);

const SCRATCH: Migration = {
  name: '9001_scratch',
  sql: 'CREATE TABLE "holdfast"."scratch" ("id" integer PRIMARY KEY);\n--> statement-breakpoint\nALTER TABLE "holdfast"."scratch" ENABLE ROW LEVEL SECURITY;',
};

const BROKEN: Migration = {
  name: '9002_broken',
  sql: 'CREATE TABLE "holdfast"."half" ("id" integer PRIMARY KEY);\n--> statement-breakpoint\nSELECT 1 / 0;',
};

describe('the embedded migrations', () => {
  it('carry the same SQL as the files in migrations/', () => {
    const dir = new URL('../migrations/', import.meta.url);
    const files = readdirSync(dir)
      .filter((file) => file.endsWith('.sql'))
      .sort();
    expect(MIGRATIONS.map((m) => `${m.name}.sql`)).toEqual(files);
    for (const migration of MIGRATIONS) {
      const onDisk = readFileSync(new URL(`${migration.name}.sql`, dir), 'utf8').replaceAll('\r\n', '\n');
      expect(migration.sql).toBe(onDisk);
    }
  });

  it('split into whole statements', () => {
    const statements = migrationStatements(INITIAL);
    expect(statements).toHaveLength(45);
    expect(migrationStatements(LEASE_TOKEN)).toHaveLength(1);
    for (const statement of statements) {
      expect(statement).not.toContain('statement-breakpoint');
      expect(statement.endsWith(';')).toBe(true);
    }
    expect(migrationStatements({ name: 'x', sql: 'SELECT 1;--> statement-breakpoint\n\n--> statement-breakpoint\nSELECT 2;\n' })).toEqual([
      'SELECT 1;',
      'SELECT 2;',
    ]);
  });

  it('have not changed since they were applied to the hosted database', () => {
    expect(ALL).toEqual(['0000_initial', '0001_lease_token']);
    expect(migrationHash(INITIAL)).toBe('4fc90d09a5d4b7d668d16f8c810b17d29ba96a2700e379fdfd1e3363e2dbcea0');
  });

  it('hash the same whatever the line endings', () => {
    const windows = { ...INITIAL, sql: INITIAL.sql.replaceAll('\n', '\r\n') };
    expect(migrationHash(windows)).toBe(migrationHash(INITIAL));
    expect(migrationHash({ ...INITIAL, sql: `${INITIAL.sql} ` })).not.toBe(migrationHash(INITIAL));
  });
});

describe('migrate', () => {
  let connection: PgliteConnection;
  let firstRun: string[];

  beforeAll(async () => {
    connection = await connectPglite();
    firstRun = await migrate(connection.db);
  }, STARTUP_TIMEOUT_MS);

  afterAll(() => connection.close());

  const column = async <T>(query: string): Promise<T[]> => {
    const { rows } = await connection.client.query<{ value: T }>(query);
    return rows.map((row) => row.value);
  };

  it('applies everything to an empty database and records it', async () => {
    expect(firstRun).toEqual(MIGRATIONS.map((m) => m.name));
    const { rows } = await connection.client.query<{ name: string; hash: string }>('select name, hash from holdfast.migrations order by name');
    expect(rows).toEqual(MIGRATIONS.map((m) => ({ name: m.name, hash: migrationHash(m) })));
  });

  it('applies nothing the second time, or the third', async () => {
    expect(await migrate(connection.db)).toEqual([]);
    expect(await migrate(connection.db)).toEqual([]);
    expect(await column<string>('select name as value from holdfast.migrations')).toHaveLength(MIGRATIONS.length);
  });

  it('puts every table in its own schema and leaves the public one empty', async () => {
    expect(await column<string>("select table_name as value from information_schema.tables where table_schema = 'holdfast' order by 1")).toEqual(
      TABLES,
    );
    expect(await column<string>("select table_name as value from information_schema.tables where table_schema = 'public'")).toEqual([]);
  });

  it('turns row level security on for every table and defines no policy', async () => {
    const { rows } = await connection.client.query<{ relname: string; relrowsecurity: boolean }>(
      `select c.relname, c.relrowsecurity
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'holdfast' and c.relkind in ('r', 'p')
        order by c.relname`,
    );
    expect(rows).toEqual(TABLES.map((relname) => ({ relname, relrowsecurity: true })));
    expect(await column<string>("select policyname as value from pg_policies where schemaname = 'holdfast'")).toEqual([]);
  });

  it('shows nothing to another role, even one that was granted the tables', async () => {
    const { store, addOrg } = pgUnderTest(connection.db);
    const org = await addOrg();
    const { client } = connection;
    await client.exec('create role api_reader nologin');

    const as = async <T>(role: string, work: () => Promise<T>): Promise<T> => {
      await client.exec(`set role ${role}`);
      try {
        return await work();
      } finally {
        await client.exec('reset role');
      }
    };

    await expect(as('api_reader', () => client.query('select id from holdfast.orgs'))).rejects.toThrow(/permission denied/);

    await client.exec(`
      grant usage on schema holdfast to api_reader;
      grant select, insert, update, delete on all tables in schema holdfast to api_reader;
    `);
    for (const table of TABLES) {
      const seen = await as('api_reader', () => client.query(`select * from holdfast.${table}`));
      expect(seen.rows, table).toEqual([]);
    }
    await expect(
      as('api_reader', () => client.query("insert into holdfast.refusals (org_id, chain, kind, attempted, outcome, evidence) values ($1, 'tempo', 'k', 'a', 'o', '{}')", [org])),
    ).rejects.toThrow(/row-level security/);
    const erased = await as('api_reader', () => client.query('delete from holdfast.orgs'));
    expect(erased.affectedRows).toBe(0);

    expect(await store.loadOrg(org)).toMatchObject({ id: org });
  });

  it('can have its SQL run again, statement by statement, without losing anything', async () => {
    const { store, addOrg } = pgUnderTest(connection.db);
    const org = await addOrg();
    for (const migration of MIGRATIONS) {
      for (const statement of migrationStatements(migration)) await connection.client.query(statement);
    }
    expect(await store.loadOrg(org)).toMatchObject({ id: org });
    expect(await migrate(connection.db)).toEqual([]);
  });

  it('refuses a migration that was changed after it was applied', async () => {
    const edited = { ...INITIAL, sql: `${INITIAL.sql}\n-- one more thing` };
    await expect(migrate(connection.db, [edited])).rejects.toThrow('migration 0000_initial has changed since it was applied');
  });
});

describe('migrate, as the schema grows', () => {
  let connection: PgliteConnection;

  beforeAll(async () => {
    connection = await connectPglite();
  }, STARTUP_TIMEOUT_MS);

  afterAll(() => connection.close());

  const exists = async (table: string): Promise<boolean> => {
    const { rows } = await connection.client.query<{ found: boolean }>('select to_regclass($1) is not null as found', [table]);
    return rows[0]?.found === true;
  };

  const recorded = async (): Promise<string[]> => {
    const { rows } = await connection.client.query<{ name: string }>('select name from holdfast.migrations order by name');
    return rows.map((row) => row.name);
  };

  it('adopts a database whose first migration was applied by hand, and brings it up to date', async () => {
    for (const statement of migrationStatements(INITIAL)) await connection.client.query(statement);
    expect(await exists('holdfast.migrations')).toBe(false);

    expect(await migrate(connection.db)).toEqual(ALL);
    expect(await recorded()).toEqual(ALL);
  });

  it('leaves nothing of a run in which one migration fails', async () => {
    await expect(migrate(connection.db, [...MIGRATIONS, SCRATCH, BROKEN])).rejects.toMatchObject({ cause: { message: 'division by zero' } });
    expect(await exists('holdfast.scratch')).toBe(false);
    expect(await exists('holdfast.half')).toBe(false);
    expect(await recorded()).toEqual(ALL);
  });

  it('applies only what is new, in order', async () => {
    expect(await migrate(connection.db, [...MIGRATIONS, SCRATCH])).toEqual(['9001_scratch']);
    expect(await exists('holdfast.scratch')).toBe(true);
    expect(await recorded()).toEqual([...ALL, '9001_scratch']);
    expect(await migrate(connection.db, [...MIGRATIONS, SCRATCH])).toEqual([]);
  });
});

describe('migrate, on a database that stopped at the first migration', () => {
  let connection: PgliteConnection;

  beforeAll(async () => {
    connection = await connectPglite();
    await migrate(connection.db, [INITIAL]);
  }, STARTUP_TIMEOUT_MS);

  afterAll(() => connection.close());

  it('adds the lease token and leaves the organisations and their leases as they were', async () => {
    const { client, db } = connection;
    await client.query(
      `insert into holdfast.orgs (id, name, ufvk_enc, birthday, hl_user, policy, tick_lease_until)
       values ('before', 'Before', 'v1.x.y.z', 1, '0xabc', '{}', '2100-01-01T00:00:00Z')`,
    );

    expect(await migrate(db)).toEqual(['0001_lease_token']);
    expect(await migrate(db)).toEqual([]);
    const { rows } = await client.query('select id, tick_lease_until, tick_lease_token from holdfast.orgs');
    expect(rows).toEqual([{ id: 'before', tick_lease_until: new Date('2100-01-01T00:00:00Z'), tick_lease_token: null }]);

    // A lease taken by the code that ran before the token existed is still honoured until it runs out.
    const store = pgUnderTest(db).store;
    expect(await store.withOrgLock('before', async () => 1)).toEqual({ ran: false });
    await client.query("update holdfast.orgs set tick_lease_until = '2000-01-01T00:00:00Z' where id = 'before'");
    expect(await store.withOrgLock('before', async () => 1)).toEqual({ ran: true, value: 1 });
  });
});
