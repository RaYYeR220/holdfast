/**
 * End-to-end proof of the payout rail against a live cluster.
 *
 *   npx tsx scripts/devnet-proof.ts [rpc-url]
 *
 * Defaults to the public devnet endpoint. Keys are kept in
 * scripts/out/keys.json and the evidence is written next to them.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { FundingError } from './funding';
import { runProof } from './proof';
import { explorerUrl, renderProof } from './render';

const DEVNET_RPC_URL = 'https://api.devnet.solana.com';
const outDir = fileURLToPath(new URL('./out/', import.meta.url));
const rpcUrl = process.argv[2] ?? DEVNET_RPC_URL;
const startedAt = new Date();

try {
  const report = await runProof({ rpcUrl, keysFile: `${outDir}keys.json`, log: line => console.log(`${line}\n`) });
  const proofFile = `${outDir}PROOF-${report.cluster}.md`;
  mkdirSync(outDir, { recursive: true });
  writeFileSync(proofFile, renderProof(report, startedAt));

  console.log('Signatures:');
  for (const step of report.steps) {
    if (step.signature) console.log(`  ${step.title}\n    ${explorerUrl(report.cluster, rpcUrl, step.signature)}`);
  }
  console.log(`\nWritten to ${proofFile}`);
} catch (error) {
  if (!(error instanceof FundingError)) throw error;
  console.error(error.message);
  for (const refusal of error.refusals) console.error(`  ${refusal}`);
  process.exitCode = 2;
}
