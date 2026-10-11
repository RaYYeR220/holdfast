import { parsePublishedStatement, type PublishedStatement } from '@holdfast/books';
import { parseArgs, UsageError } from './args';
import type { Env } from './env';
import { checkArithmetic } from './verify/arithmetic';
import { checkHyperliquid } from './verify/hyperliquid';
import { checkJournal } from './verify/journal';
import { checkReconciliation } from './verify/reconciliation';
import { describeError, fail, printable, renderJson, renderText, type StepId, type StepResult, verdictOf } from './verify/report';
import { checkZcash } from './verify/zcash';

/** The key from the command line or, better for shell history, from a file. */
async function viewingKey(inline: string | undefined, file: string | undefined, env: Env): Promise<string | null> {
  if (inline !== undefined && file !== undefined) throw new UsageError('give the viewing key with --ufvk or with --ufvk-file, not both');
  const key = file === undefined ? inline : await env.readFile(file);
  if (key === undefined) return null;
  if (key.trim() === '') throw new UsageError('the viewing key is empty');
  return key.trim();
}

function blockHeight(value: string | undefined): number | null {
  if (value === undefined) return null;
  if (!/^[1-9]\d{0,9}$/.test(value)) throw new UsageError(`--birthday takes a block height, got "${value}"`);
  return Number(value);
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

/** Everything here is the reader's own: nothing in a statement can set or change any of it. */
export interface VerifyOptions {
  ufvk: string | null;
  offline: boolean;
  zcashEndpoints: readonly string[];
  /** Block to scan the treasury from, when the reader knows it; otherwise the one the statement gives. */
  birthday: number | null;
  /** The Hyperliquid account the reader expects the statement to be about. */
  hyperliquidAccount: string | null;
}

/** Derive a published statement again, step by step. Nothing in it is taken on trust that a step can check. */
export async function verifyStatement(published: PublishedStatement, options: VerifyOptions, env: Pick<Env, 'sources' | 'now'>): Promise<StepResult[]> {
  const { ufvk, offline } = options;
  return [
    await step('journal', ufvk, () => checkJournal(published)),
    await step('zcash', ufvk, () => checkZcash(published, { ufvk, offline, endpoints: options.zcashEndpoints, birthday: options.birthday }, env.sources)),
    await step('hyperliquid', ufvk, () => checkHyperliquid(published, { offline, account: options.hyperliquidAccount }, env.sources)),
    await step('reconciliation', ufvk, () => checkReconciliation(published)),
    await step('arithmetic', ufvk, () => checkArithmetic(published, env.now())),
  ];
}

/**
 * `holdfast verify <statement.json> [--ufvk <key> | --ufvk-file <path>] [--offline] [--json]
 *                  [--birthday <height>] [--hyperliquid-account <address>] [--zcash-endpoint <url>]`
 *
 * Exits 0 only when every step ran and passed. A failed step, a step that
 * was not run and a file that is not a statement all exit 1: a statement
 * that was not checked in full has not been verified.
 */
export async function verify(argv: readonly string[], env: Env): Promise<number> {
  const args = parseArgs(argv, {
    flags: ['--offline', '--json'],
    options: ['--ufvk', '--ufvk-file', '--zcash-endpoint', '--birthday', '--hyperliquid-account'],
  });
  const [file, ...extra] = args.positionals;
  if (file === undefined) throw new UsageError('verify needs a statement file');
  if (extra.length > 0) throw new UsageError(`verify takes one statement file, got ${extra.length + 1}`);
  const birthday = blockHeight(args.one('--birthday'));

  let ufvk: string | null;
  let published: PublishedStatement;
  try {
    ufvk = await viewingKey(args.one('--ufvk'), args.one('--ufvk-file'), env);
    published = parsePublishedStatement(await env.readFile(file));
  } catch (e) {
    if (e instanceof UsageError) throw e;
    env.err(printable(`Cannot verify ${file}: ${describeError(e)}`));
    return 1;
  }

  const options: VerifyOptions = {
    ufvk,
    offline: args.has('--offline'),
    zcashEndpoints: args.all('--zcash-endpoint'),
    birthday,
    hyperliquidAccount: args.one('--hyperliquid-account') ?? null,
  };
  const steps = await verifyStatement(published, options, env);
  if (args.has('--json')) env.out(renderJson(file, published, steps, env.now()));
  else for (const line of renderText(file, published, steps, env.now())) env.out(line);
  return verdictOf(steps) === 'verified' ? 0 : 1;
}
