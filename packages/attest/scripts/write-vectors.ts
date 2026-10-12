import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { VECTORS_PATH, buildVectors } from './vectors';

// Rewrites the vectors shared with the contract tests.

mkdirSync(dirname(VECTORS_PATH), { recursive: true });
writeFileSync(VECTORS_PATH, `${JSON.stringify(buildVectors(), null, 2)}\n`);
console.log(`wrote ${VECTORS_PATH}`);
