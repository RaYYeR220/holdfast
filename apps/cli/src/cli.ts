import { UsageError } from './args';
import { backtest } from './backtest';
import type { Env } from './env';
import { verify } from './verify';

export const USAGE = `Usage:
  holdfast backtest [--policy <file.json>] [--json]
      Grade a policy on the recorded ZEC scenarios. Exits 1 if a graded scenario fails
      or the policy file is not a valid policy.

  holdfast verify <statement.json> [--ufvk <key> | --ufvk-file <path>] [--offline] [--json]
      Derive a published statement again instead of trusting it: the journal chain,
      the Zcash history (needs the viewing key), the Hyperliquid history, the
      reconciliation and the arithmetic. Exits 1 if a step fails.
        --offline                 make no network request; the two chain steps are skipped
        --zcash-endpoint <url>    lightwalletd endpoint to scan through; may be repeated

  --json prints the result for a program to read.`;

/** Run one command and return its exit code: 0 when it succeeded, 1 otherwise. */
export async function run(argv: readonly string[], env: Env): Promise<number> {
  const [command, ...rest] = argv;
  try {
    switch (command) {
      case 'backtest':
        return await backtest(rest, env);
      case 'verify':
        return await verify(rest, env);
      case 'help':
      case '--help':
      case '-h':
        env.out(USAGE);
        return 0;
      case undefined:
        throw new UsageError('no command given');
      default:
        throw new UsageError(`unknown command "${command}"`);
    }
  } catch (e) {
    if (e instanceof UsageError) {
      env.err(`holdfast: ${e.message}`);
      env.err('');
      env.err(USAGE);
    } else {
      env.err(`holdfast: ${e instanceof Error ? e.message : String(e)}`);
    }
    return 1;
  }
}
