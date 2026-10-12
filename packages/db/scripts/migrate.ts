/**
 * Applies the migrations that have not been applied yet, and exits.
 *
 *   DATABASE_URL=postgres://… pnpm --filter @holdfast/db exec tsx scripts/migrate.ts
 *
 * Safe to run again: a database that is up to date is left as it is. Exits 0
 * when the database is up to date afterwards and 1 otherwise.
 */
import { connect } from '../src/client';
import { migrate } from '../src/migrate';

const url = process.env.DATABASE_URL?.trim();
if (url === undefined || url === '') {
  console.error('DATABASE_URL is not set');
  process.exit(1);
}

const connection = connect(url, { max: 1 });
try {
  const applied = await migrate(connection.db);
  console.log(applied.length === 0 ? 'the database is up to date' : `applied ${applied.length} migration(s): ${applied.join(', ')}`);
} catch (error) {
  // The message of a failed connection may quote the address it was given; the URL carries the password.
  const message = error instanceof Error ? error.message : String(error);
  console.error(`migration failed: ${message.split(url).join('[DATABASE_URL]')}`);
  process.exitCode = 1;
} finally {
  await connection.close();
}
