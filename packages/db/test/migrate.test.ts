import { readFileSync, readdirSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MIGRATIONS, type Migration, type PgliteConnection, connectPglite, migrate, migrationHash, migrationStatements } from '../src';
import { STARTUP_TIMEOUT_MS, pgUnderTest } from './support/stores';

const TABLES = [
  'audit_links',
  'auth_nonces',
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
const APPLICATION = MIGRATIONS[2] as Migration;
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
    expect(migrationStatements(APPLICATION)).toHaveLength(21);
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
    expect(ALL.slice(0, 2)).toEqual(['0000_initial', '0001_lease_token']);
    expect(migrationHash(INITIAL)).toBe('4fc90d09a5d4b7d668d16f8c810b17d29ba96a2700e379fdfd1e3363e2dbcea0');
    expect(migrationHash(LEASE_TOKEN)).toBe('9abb5fb502ef411d1a2334d9d94cf50330b33437416d1f516de4441a6d9a73d2');
  });

  it('are listed in the order they were written', () => {
    expect(ALL).toEqual(['0000_initial', '0001_lease_token', '0002_application']);
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

  it('can have the SQL of its latest migration run again, statement by statement, without losing anything', async () => {
    const { store, addOrg } = pgUnderTest(connection.db);
    const org = await addOrg();
    const lines = () => [{ payeeName: 'Ada', toAddress: '0x01', amount: 100n, memo: 'INV-1', reference: 'INV-1' }];
    const run = await store.createPayoutRun(org, { chain: 'tempo', token: '0xt0', tokenSymbol: 'USDC.e', tokenDecimals: 6, account: '0xacc', notBefore: null, at: Date.parse('2026-10-07T00:00:00Z'), lines });

    for (const statement of migrationStatements(APPLICATION)) await connection.client.query(statement);

    expect(await store.loadOrg(org)).toMatchObject({ id: org });
    expect(await store.findPayoutRun(org, run.id)).toEqual(run);
    expect(await migrate(connection.db)).toEqual([]);
  });

  it('refuses a migration that was changed after it was applied', async () => {
    const edited = { ...INITIAL, sql: `${INITIAL.sql}\n-- one more thing` };
    await expect(migrate(connection.db, [edited])).rejects.toThrow('migration 0000_initial has changed since it was applied');
  });
});

describe('each migration, on a database that has just reached it', () => {
  let connection: PgliteConnection;

  beforeAll(async () => {
    connection = await connectPglite();
  }, STARTUP_TIMEOUT_MS);

  afterAll(() => connection.close());

  // A later migration may change what an earlier one set up, a key for
  // instance, so each is run again where it would be: on the schema it made.
  it('can have its SQL run again, statement by statement, without losing anything', async () => {
    const { client, db } = connection;
    for (const [index, migration] of MIGRATIONS.entries()) {
      expect(await migrate(db, MIGRATIONS.slice(0, index + 1))).toEqual([migration.name]);
      if (index === 0) {
        await client.query("insert into holdfast.orgs (id, name, ufvk_enc, birthday, hl_user, policy) values ('kept', 'Kept', 'v1.x.y.z', 1, '0xabc', '{}')");
      }
      for (const statement of migrationStatements(migration)) await client.query(statement);
      const { rows } = await client.query('select id from holdfast.orgs');
      expect(rows, migration.name).toEqual([{ id: 'kept' }]);
    }
    expect(await migrate(db)).toEqual([]);
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

    expect(await migrate(db, [INITIAL, LEASE_TOKEN])).toEqual(['0001_lease_token']);
    expect(await migrate(db, [INITIAL, LEASE_TOKEN])).toEqual([]);
    const { rows } = await client.query('select id, tick_lease_until, tick_lease_token from holdfast.orgs');
    expect(rows).toEqual([{ id: 'before', tick_lease_until: new Date('2100-01-01T00:00:00Z'), tick_lease_token: null }]);

    // A lease taken by the code that ran before the token existed is still honoured until it runs out.
    const store = pgUnderTest(db).store;
    expect(await store.withOrgLock('before', async () => 1)).toEqual({ ran: false });
    await client.query("update holdfast.orgs set tick_lease_until = '2000-01-01T00:00:00Z' where id = 'before'");
    expect(await store.withOrgLock('before', async () => 1)).toEqual({ ran: true, value: 1 });
  });
});

describe('migrate, on a database that holds payout runs from before they were numbered per organisation', () => {
  let connection: PgliteConnection;

  beforeAll(async () => {
    connection = await connectPglite();
    await migrate(connection.db, [INITIAL, LEASE_TOKEN]);
  }, STARTUP_TIMEOUT_MS);

  afterAll(() => connection.close());

  it('gives every line the organisation of its run, and lets two organisations use the same run id', async () => {
    const { client, db } = connection;
    await client.exec(`
      insert into holdfast.orgs (id, name, ufvk_enc, birthday, hl_user, policy) values
        ('before', 'Before', 'v1.x.y.z', 1, '0xabc', '{}'),
        ('other', 'Other', 'v1.x.y.z', 1, '0xdef', '{}');
      insert into holdfast.payout_runs (id, org_id, chain, token, status, total, tx, created_at) values
        ('HF-2026-10-0001', 'before', 'tempo', '0xt0', 'paid', 300, '0xaa', '2026-10-05T00:00:00Z'),
        ('HF-2026-10-0002', 'other', 'solana', 'mint', 'draft', 50, null, '2026-10-06T00:00:00Z');
      insert into holdfast.payout_lines (run_id, line_no, payee_name, to_address, amount, memo, tx, log_index) values
        ('HF-2026-10-0001', 1, 'Ada', '0x01', 100, 'HF-2026-10-0001/1', '0xaa', 4),
        ('HF-2026-10-0001', 2, 'Grace', '0x02', 200, 'HF-2026-10-0001/2', '0xaa', 6),
        ('HF-2026-10-0002', 1, 'Linus', 'So1', 50, 'INV-7', null, null);
    `);

    expect(await migrate(db)).toEqual(['0002_application']);
    expect(await migrate(db)).toEqual([]);

    const { rows } = await client.query('select org_id, run_id, line_no, reference, receipt_token from holdfast.payout_lines order by run_id, line_no');
    expect(rows).toEqual([
      { org_id: 'before', run_id: 'HF-2026-10-0001', line_no: 1, reference: '', receipt_token: null },
      { org_id: 'before', run_id: 'HF-2026-10-0001', line_no: 2, reference: '', receipt_token: null },
      { org_id: 'other', run_id: 'HF-2026-10-0002', line_no: 1, reference: '', receipt_token: null },
    ]);

    const store = pgUnderTest(db).store;
    expect(await store.findPayoutRun('before', 'HF-2026-10-0001')).toMatchObject({
      status: 'paid',
      total: 300n,
      tokenSymbol: null,
      tokenDecimals: null,
      account: null,
      notBefore: null,
      lines: [
        { lineNo: 1, payeeName: 'Ada', amount: 100n, tx: '0xaa', logIndex: 4 },
        { lineNo: 2, payeeName: 'Grace', amount: 200n, tx: '0xaa', logIndex: 6 },
      ],
    });
    expect(await store.findPayoutRun('other', 'HF-2026-10-0001')).toBeNull();

    // The id that was taken across the whole database is now free to every other organisation.
    const lines = () => [{ payeeName: 'Linus', toAddress: 'So1', amount: 75n, memo: 'INV-8', reference: 'INV-8' }];
    const own = await store.createPayoutRun('other', { chain: 'solana', token: 'mint', tokenSymbol: 'USDC', tokenDecimals: 6, account: 'wallet', notBefore: 9n, at: Date.parse('2026-10-07T00:00:00Z'), lines });
    expect(own.id).toBe('HF-2026-10-0003');
    const first = await store.createPayoutRun('before', { chain: 'tempo', token: '0xt0', tokenSymbol: 'USDC.e', tokenDecimals: 6, account: '0xacc', notBefore: null, at: Date.parse('2026-10-07T00:00:00Z'), lines });
    expect(first.id).toBe('HF-2026-10-0002');
    expect(await store.findPayoutRun('other', 'HF-2026-10-0002')).toMatchObject({ status: 'draft', total: 50n });
  });

  it('keeps a line from pointing at a run of another organisation', async () => {
    await expect(
      connection.client.query(
        `insert into holdfast.payout_lines (org_id, run_id, line_no, payee_name, to_address, amount, memo) values ('other', 'HF-2026-10-0001', 9, 'x', 'y', 1, 'm')`,
      ),
    ).rejects.toThrow(/foreign key/);
  });
});
