import { parsePublishedStatement, type PublishedStatement } from '@holdfast/books';
import { parseArgs, UsageError } from './args';
import type { Env } from './env';
import { checkArithmetic } from './verify/arithmetic';
import { checkHyperliquid } from './verify/hyperliquid';
import { checkJournal } from './verify/journal';
import { checkReconciliation } from './verify/reconciliation';
import { describeError, fail, renderJson, renderText, type StepId, type StepResult } from './verify/report';
import { checkZcash } from './verify/zcash';

/** The key from the command line or, better for shell history, from a file. */
async function viewingKey(inline: string | undefined, file: string | undefined, env: Env): Promise<string | null> {
  if (inline !== undefined && file !== undefined) throw new UsageError('give the viewing key with --ufvk or with --ufvk-file, not both');
  const key = file === undefined ? inline : await env.readFile(file);
  if (key === undefined) return null;
  if (key.trim() === '') throw new UsageError('the viewing key is empty');
  return key.trim();
}

/**
 * A step that cannot make sense of the published data has not passed: the
 * failure to evaluate is the finding. Reaching the network is each step's own
 * business, and what it cannot reach it reports as skipped.
 */
async function step(id: StepId, secret: string | null, check: () => StepResult | Promise<StepResult>): Promise<StepResult> {
  try {
    return await check();
  } catch (e) {
    const message = describeError(e);
    return fail(id, `could not be evaluated: ${secret === null ? message : message.split(secret).join('[viewing key]')}`);
  }
}

export interface VerifyOptions {
  ufvk: string | null;
  offline: boolean;
  zcashEndpoints: readonly string[];
}

/** Derive a published statement again, step by step. Nothing in it is taken on trust that a step can check. */
export async function verifyStatement(published: PublishedStatement, options: VerifyOptions, env: Pick<Env, 'sources'>): Promise<StepResult[]> {
  const { ufvk, offline } = options;
  return [
    await step('journal', ufvk, () => checkJournal(published)),
    await step('zcash', ufvk, () => checkZcash(published, { ufvk, offline, endpoints: options.zcashEndpoints }, env.sources)),
    await step('hyperliquid', ufvk, () => checkHyperliquid(published, offline, env.sources)),
    await step('reconciliation', ufvk, () => checkReconciliation(published)),
    await step('arithmetic', ufvk, () => checkArithmetic(published)),
  ];
}

/**
 * `holdfast verify <statement.json> [--ufvk <key> | --ufvk-file <path>] [--offline] [--zcash-endpoint <url>] [--json]`
 *
 * Exits 1 when a step fails or the file cannot be read as a statement. A
 * skipped step is neither: it is reported as not having been checked.
 */
export async function verify(argv: readonly string[], env: Env): Promise<number> {
  const args = parseArgs(argv, { flags: ['--offline', '--json'], options: ['--ufvk', '--ufvk-file', '--zcash-endpoint'] });
  const [file, ...extra] = args.positionals;
  if (file === undefined) throw new UsageError('verify needs a statement file');
  if (extra.length > 0) throw new UsageError(`verify takes one statement file, got ${extra.length + 1}`);

  let ufvk: string | null;
  let published: PublishedStatement;
  try {
    ufvk = await viewingKey(args.one('--ufvk'), args.one('--ufvk-file'), env);
    published = parsePublishedStatement(await env.readFile(file));
  } catch (e) {
    if (e instanceof UsageError) throw e;
    env.err(`Cannot verify ${file}: ${describeError(e)}`);
    return 1;
  }

  const steps = await verifyStatement(published, { ufvk, offline: args.has('--offline'), zcashEndpoints: args.all('--zcash-endpoint') }, env);
  if (args.has('--json')) env.out(renderJson(file, published, steps));
  else for (const line of renderText(file, published, steps)) env.out(line);
  return steps.some((s) => s.status === 'FAIL') ? 1 : 0;
}
