// End-to-end proof of the payout rail on the Tempo Moderato testnet.
//   npx tsx scripts/moderato-proof.ts
// Writes the transaction table to scripts/out/PROOF-moderato.md and the throwaway keys to scripts/out/keys.json.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderProof, runModeratoProof } from './proof-flow';

const out = join(dirname(fileURLToPath(import.meta.url)), 'out');
mkdirSync(out, { recursive: true });

const report = await runModeratoProof({
  log: (line) => console.log(line),
  onKeys: (keys) => writeFileSync(join(out, 'keys.json'), `${JSON.stringify(keys, null, 2)}\n`),
});

const proof = renderProof(report);
writeFileSync(join(out, 'PROOF-moderato.md'), proof);
console.log(`\n${proof}`);
console.log(`written to ${join(out, 'PROOF-moderato.md')}`);
