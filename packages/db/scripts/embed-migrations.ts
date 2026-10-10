/**
 * Copies migrations/*.sql into src/migrations.ts, so the SQL travels with the
 * code and can be applied from a bundle that has no files to read.
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';

const migrationsDir = new URL('../migrations/', import.meta.url);
const target = new URL('../src/migrations.ts', import.meta.url);

const templateLiteral = (text: string) =>
  `\`${text.replaceAll('\\', '\\\\').replaceAll('`', '\\`').replaceAll('${', '\\${')}\``;

const files = readdirSync(migrationsDir)
  .filter((file) => file.endsWith('.sql'))
  .sort();

const entries = files.map((file) => {
  const sql = readFileSync(new URL(file, migrationsDir), 'utf8').replaceAll('\r\n', '\n');
  return `  {\n    name: ${JSON.stringify(file.slice(0, -'.sql'.length))},\n    sql: ${templateLiteral(sql)},\n  },\n`;
});

writeFileSync(
  target,
  [
    '// Written by scripts/embed-migrations.ts from migrations/*.sql.\n',
    '// Change the SQL files, then run `pnpm --filter @holdfast/db embed-migrations`.\n',
    "import type { Migration } from './migrate';\n\n",
    'export const MIGRATIONS: readonly Migration[] = [\n',
    ...entries,
    '];\n',
  ].join(''),
);

console.log(`embedded ${files.length} migration(s): ${files.join(', ')}`);
