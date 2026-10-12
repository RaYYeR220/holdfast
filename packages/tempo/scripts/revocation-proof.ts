// Proof on the Tempo Moderato testnet that a passkey root holding nothing can take an access key back, with the sponsor paying.
//   npx tsx scripts/revocation-proof.ts
// Writes the transaction table to scripts/out/PROOF-revocation-moderato.md and the throwaway keys to scripts/out/revocation-keys.json.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderRevocationProof, runRevocationProof } from './revocation-flow';

const out = join(dirname(fileURLToPath(import.meta.url)), 'out');
mkdirSync(out, { recursive: true });

const report = await runRevocationProof({
  log: (line) => console.log(line),
  onKeys: (keys) => writeFileSync(join(out, 'revocation-keys.json'), `${JSON.stringify(keys, null, 2)}\n`),
});

const proof = renderRevocationProof(report);
writeFileSync(join(out, 'PROOF-revocation-moderato.md'), proof);
console.log(`\n${proof}`);
console.log(`written to ${join(out, 'PROOF-revocation-moderato.md')}`);
