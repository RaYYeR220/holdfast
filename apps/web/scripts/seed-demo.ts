/**
 * Registers the state of an organisation that already exists on its chains,
 * and marks it as the public demo.
 *
 *   HOLDFAST_DEMO_SEED=/path/outside/the/repository/seed.json pnpm --filter @holdfast/web seed-demo
 *
 * It needs the application's own settings in the environment (see
 * .env.example): the database, the master key, the network, the Tempo
 * sponsor key and whatever RPC endpoints the deployment uses. With them in a
 * file: `pnpm exec tsx --env-file=.env.local scripts/seed-demo.ts`. The
 * database has to be migrated up to the latest migration first.
 *
 * The seed file holds keys. It is never part of the repository, and nothing
 * of it is printed but addresses and transaction ids. Its shape:
 *
 *   {
 *     "org": {
 *       "id": "holdfast-demo",            the id it has, or is to get, in the database
 *       "name": "Holdfast Demo",
 *       "owner": "0x…",                    its Hyperliquid account; this address owns it in the application
 *       "ufvk": "uview1…",                 the treasury's unified full viewing key
 *       "birthday": 3512000,               first block that can hold treasury funds
 *       "monthlyBurnUsd": 42000,           optional
 *       "tempoAccount": "0x…",             optional: the account Tempo payouts are made from
 *       "solanaOwner": "…"                 optional: the wallet Solana payouts are made from
 *     },
 *     "keys": {                            each optional; a key that is given becomes the organisation's active one
 *       "hyperliquidAgent": "0x…",         32-byte private key of the approved agent
 *       "tempoAccessKey": "0x…",           32-byte P-256 private key of the authorized access key
 *       "solanaDelegate": [12, 34, …],     the key file the Solana tools write (64 bytes), or its hex, or the hex of the 32-byte seed
 *       "hedgeAttester": "0x…"             32-byte private key of the attester the owner named on the HedgeAttestor contract
 *     },
 *     "payoutRuns": [                      runs already paid on chain
 *       {
 *         "id": "HF-2026-10-0001",
 *         "chain": "tempo",                or "solana"
 *         "tx": "0x…",                     the transaction (signature on Solana) that paid it
 *         "createdAt": "2026-10-09T14:00:00Z",
 *         "paidAt": "2026-10-09T14:03:00Z",
 *         "notBefore": "412000000",        Solana only, optional: a slot before which the run cannot have been paid
 *         "lines": [{ "payeeName": "…", "to": "0x…", "amount": "1000000", "reference": "INV-1041" }]
 *       }
 *     ],
 *     "refusals": [                        transactions the chain refused
 *       { "chain": "tempo", "kind": "over_limit", "tx": "0x…", "attempted": "transferWithMemo of the largest amount there is" },
 *       { "chain": "solana", "kind": "over_allowance", "tx": "…", "attempted": "a transfer of one base unit more than the allowance" }
 *     ],
 *     "attestations": [                    snapshots the HedgeAttestor contract already holds for the owner's account
 *       {
 *         "series": 0,                     the series the snapshot is in, and its number there; both count from zero
 *         "number": 0,
 *         "tx": "0x…",                     the transaction that recorded it
 *         "journalCount": 12,              how many journal entries it commits to
 *         "root": "0x…",                   and their Merkle root
 *         "treasuryZat": "5000000",        the balance its treasury commitment hides, in zatoshi
 *         "salt": "0x…"                    and the 32-byte salt that hides it
 *       }
 *     ]
 *   }
 *
 * Amounts are token base units. On Tempo a line's memo is `<run id>/<line>`;
 * on Solana it is the line's reference.
 *
 * A run is recorded only if its chain holds it under its id, in the named
 * transaction, with these payees and amounts; a refusal only if its chain
 * recorded the transaction as failed; an attestation only if the contract
 * holds that snapshot with this journal root and count, the balance and salt
 * open its treasury commitment, and the named transaction recorded it.
 * Attestations need HEDGE_ATTESTOR_ADDRESS set and the network to be mainnet.
 * Whatever cannot be confirmed is left out and reported, and the exit code is
 * 1. Running the script again records nothing a second time.
 */
import { readFile } from 'node:fs/promises';
import { createRuntime } from '../src/server/runtime';
import { describeReport, parseSeed, seedDemo } from '../src/server/seed/demo';

// Nothing is read or connected to until it is used; a missing setting is reported when it is.
const deps = createRuntime(process.env);

async function main(): Promise<number> {
  const path = process.env.HOLDFAST_DEMO_SEED;
  if (path === undefined || path.trim() === '') {
    console.error('HOLDFAST_DEMO_SEED is not set: it names the seed file, which is kept outside the repository.');
    return 2;
  }
  const seed = parseSeed(await readFile(path, 'utf8'));
  const report = await seedDemo(deps, seed);
  for (const line of describeReport(report)) console.log(line);
  return report.complete ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    // Whatever went wrong, its message goes through the same filter as everything else that is shown.
    console.error(`seed-demo failed: ${deps.redact(error instanceof Error ? error.message : String(error))}`);
    process.exit(1);
  },
);
