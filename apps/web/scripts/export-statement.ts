/**
 * Writes the statement export of one organisation to a file: the same file
 * its owner downloads from GET /api/orgs/<id>/books/export, in the form
 * `holdfast verify` reads.
 *
 *   pnpm exec tsx --env-file=.env.local scripts/export-statement.ts <org id> <file>
 *
 * It needs the application's own settings in the environment (see
 * .env.example). The export holds no key: the treasury is named by its
 * address, and the export refuses to be built if a stored secret appears
 * anywhere in it.
 */
import { writeFile } from 'node:fs/promises';
import { publishedStatement } from '../src/server/books/service';
import { createRuntime } from '../src/server/runtime';

// Nothing is read or connected to until it is used; a missing setting is reported when it is.
const deps = createRuntime(process.env);

async function main(): Promise<number> {
  const [orgId, file] = process.argv.slice(2);
  if (orgId === undefined || file === undefined) {
    console.error('usage: export-statement.ts <org id> <file>');
    return 2;
  }
  const org = await deps.store.findOrg(orgId);
  if (org === null) {
    console.error(`no organisation with the id ${orgId}`);
    return 1;
  }
  const statement = await publishedStatement(deps, org);
  await writeFile(file, statement);
  console.log(`wrote ${file}: ${statement.length} bytes`);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    // Whatever went wrong, its message goes through the same filter as everything else that is shown.
    console.error(`export-statement failed: ${deps.redact(error instanceof Error ? error.message : String(error))}`);
    process.exit(1);
  },
);
