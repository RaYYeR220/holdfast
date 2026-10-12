import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ARTIFACT_PATH, readArtifactAbi } from './artifact';

// Rewrites src/abi.ts from the forge build. Run `forge build` in contracts/ first.

const TARGET = fileURLToPath(new URL('../src/abi.ts', import.meta.url));

function literal(value: unknown, indent: string): string {
  if (typeof value === 'string') {
    if (/['\\\n]/.test(value)) throw new Error(`cannot write ${JSON.stringify(value)} as a plain literal`);
    return `'${value}'`;
  }
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  const inner = `${indent}  `;
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    return `[\n${value.map((item) => `${inner}${literal(item, inner)},\n`).join('')}${indent}]`;
  }
  if (typeof value === 'object' && value !== null) {
    const fields = Object.entries(value);
    // A parameter without components fits on one line.
    if (fields.every(([, field]) => typeof field !== 'object')) {
      return `{ ${fields.map(([key, field]) => `${key}: ${literal(field, inner)}`).join(', ')} }`;
    }
    return `{\n${fields.map(([key, field]) => `${inner}${key}: ${literal(field, inner)},\n`).join('')}${indent}}`;
  }
  throw new Error(`unexpected value in the ABI: ${String(value)}`);
}

const abi = readArtifactAbi();
if (abi === null) throw new Error(`${ARTIFACT_PATH} is missing: run forge build in contracts/ first`);

writeFileSync(
  TARGET,
  [
    '/**',
    ' * ABI of contracts/src/HedgeAttestor.sol. Written from the forge build by',
    ' * `pnpm --filter @holdfast/attest abi`; change the contract, not this file.',
    ' */',
    `export const hedgeAttestorAbi = ${literal(abi, '')} as const;`,
    '',
  ].join('\n'),
);
console.log(`wrote ${TARGET}: ${abi.length} entries`);
