import { DEFAULT_POLICY } from '@holdfast/core';
import { type NewServiceKey, type PaidPayoutRun, runNumberOf } from '@holdfast/db';
import { decodeRevertReason, lineMemo, lineOfMemo } from '@holdfast/tempo';
import { redactViewingKeys } from '@holdfast/zcash';
import { type Hex, getAddress, isAddress } from 'viem';
import { privateKeyToAddress } from 'viem/accounts';
import { z } from 'zod';
import { looksLikeSolanaAddress } from '../config';
import type { Deps } from '../deps';
import { messageOf } from '../redact';

/**
 * Registers what an organisation has already done on its chains: who it is,
 * the service keys it uses, the payout runs it has paid and the refusals it
 * has provoked. Nothing is taken on the file's word where a chain can be
 * asked: a run or a refusal is recorded only once its chain shows it. Running
 * it again records nothing twice.
 */

const hexKey = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const moment = z.iso.datetime({ offset: true }).transform((text) => Date.parse(text));
const amount = z
  .string()
  .regex(/^[1-9]\d{0,38}$/)
  .transform((digits) => BigInt(digits));

const seedSchema = z.strictObject({
  org: z.strictObject({
    id: z.string().regex(/^[\w.-]{1,128}$/),
    name: z.string().trim().min(1).max(120),
    owner: z.string().refine((text) => isAddress(text), 'is not an account address'),
    ufvk: z.string().min(1).max(4_000),
    birthday: z.number().int().min(1),
    monthlyBurnUsd: z.number().min(0).nullable().default(null),
    tempoAccount: z
      .string()
      .refine((text) => isAddress(text), 'is not an account address')
      .nullable()
      .default(null),
    solanaOwner: z.string().refine(looksLikeSolanaAddress, 'is not a Solana address').nullable().default(null),
  }),
  keys: z.strictObject({
    hyperliquidAgent: hexKey.optional(),
    tempoAccessKey: hexKey.optional(),
    /** The key file the Solana tools write, a list of 64 bytes; or the hex of those bytes or of the 32-byte seed. */
    solanaDelegate: z.union([z.array(z.number().int().min(0).max(255)).refine((bytes) => bytes.length === 32 || bytes.length === 64, 'must be 32 or 64 bytes'), z.string().regex(/^(?:[0-9a-fA-F]{64}|[0-9a-fA-F]{128})$/)]).optional(),
  }),
  payoutRuns: z
    .array(
      z.strictObject({
        id: z.string().refine((id) => runNumberOf(id) !== null, 'is not a run id of the form HF-YYYY-MM-NNNN'),
        chain: z.enum(['tempo', 'solana']),
        tx: z.string().min(1).max(128),
        createdAt: moment,
        paidAt: moment,
        /** Solana only: a slot before which the run cannot have been paid. */
        notBefore: z
          .string()
          .regex(/^\d+$/)
          .transform((digits) => BigInt(digits))
          .optional(),
        lines: z.array(z.strictObject({ payeeName: z.string().trim().min(1).max(120), to: z.string().min(1).max(64), amount, reference: z.string().max(64).default('') })).min(1),
      }),
    )
    .default([]),
  refusals: z.array(z.strictObject({ chain: z.enum(['tempo', 'solana']), kind: z.string().min(1).max(64), tx: z.string().min(1).max(128), attempted: z.string().min(1).max(500) })).default([]),
});

export type DemoSeed = z.infer<typeof seedSchema>;

/** Read a seed file. What is wrong is reported by where it is, never by quoting it: the file holds keys. */
export function parseSeed(text: string): DemoSeed {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('the seed file is not valid JSON');
  }
  const parsed = seedSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  const problems = parsed.error.issues.map((issue) => `${issue.path.map(String).join('.') || 'the file'}: ${issue.message}`);
  throw new Error(`the seed file is not valid: ${problems.join('; ')}`);
}

export interface SeedItem {
  what: string;
  /** `recorded`: written now. `kept`: was already there. `skipped`: not written, and `detail` says why. */
  result: 'recorded' | 'kept' | 'skipped';
  detail: string;
}

export interface SeedReport {
  orgId: string;
  items: SeedItem[];
  /** False when something the file names could not be confirmed and was left out. */
  complete: boolean;
}

type SeedDeps = Pick<Deps, 'store' | 'zcash' | 'tempo' | 'solana' | 'redact'>;

const sameHex = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

function solanaSecret(key: NonNullable<DemoSeed['keys']['solanaDelegate']>): string {
  return typeof key === 'string' ? key.toLowerCase() : Buffer.from(key).toString('hex');
}

async function serviceKeys(deps: SeedDeps, seed: DemoSeed): Promise<NewServiceKey[]> {
  const keys: NewServiceKey[] = [];
  const { hyperliquidAgent, tempoAccessKey, solanaDelegate } = seed.keys;
  if (hyperliquidAgent !== undefined) keys.push({ kind: 'hl_agent', address: privateKeyToAddress(hyperliquidAgent as Hex).toLowerCase(), secret: hyperliquidAgent });
  if (tempoAccessKey !== undefined) keys.push({ kind: 'tempo_access', address: deps.tempo.rail(tempoAccessKey as Hex).accessKeyAddress, secret: tempoAccessKey });
  if (solanaDelegate !== undefined) {
    const secret = solanaSecret(solanaDelegate);
    keys.push({ kind: 'solana_delegate', address: await deps.solana.rail(secret).delegate(), secret });
  }
  return keys;
}

type SeedRun = DemoSeed['payoutRuns'][number];

/** Look a run up on its chain and, if the chain shows exactly the run the file describes, give it back ready to record. */
async function confirmedRun(deps: SeedDeps, seed: DemoSeed, run: SeedRun): Promise<PaidPayoutRun | string> {
  if (run.chain === 'tempo') {
    const account = seed.org.tempoAccount;
    const key = seed.keys.tempoAccessKey;
    if (account === null || key === undefined) return 'the file names no Tempo account or access key to look the run up with';
    const found = await deps.tempo.rail(key as Hex).findRun(account, run.id);
    if (found === null) return 'the chain holds no run under this id';
    if (found.otherTxs.length > 0) return `the run is on chain in more than one transaction (${[found.tx, ...found.otherTxs].join(', ')})`;
    if (!sameHex(found.tx, run.tx)) return `the chain holds the run in ${found.tx}, not in the transaction the file names`;
    if (found.lines.length !== run.lines.length) return `the chain holds ${found.lines.length} lines, the file ${run.lines.length}`;
    const lines: PaidPayoutRun['lines'][number][] = [];
    for (const [index, line] of run.lines.entries()) {
      const paid = found.lines.find((candidate) => lineOfMemo(candidate.memo, run.id) === index + 1);
      if (paid === undefined || !sameHex(paid.to, line.to) || paid.amount !== line.amount) return `line ${index + 1} is not what the chain shows`;
      lines.push({ payeeName: line.payeeName, toAddress: getAddress(paid.to), amount: line.amount, memo: lineMemo(run.id, index + 1), reference: line.reference, tx: found.tx, logIndex: paid.logIndex });
    }
    return { id: run.id, chain: 'tempo', token: deps.tempo.token, tokenSymbol: deps.tempo.tokenSymbol, tokenDecimals: deps.tempo.decimals, account: getAddress(account), notBefore: null, tx: found.tx, createdAt: run.createdAt, executedAt: run.paidAt, lines };
  }

  const account = seed.org.solanaOwner;
  const key = seed.keys.solanaDelegate;
  if (account === null || key === undefined) return 'the file names no Solana wallet or service key to look the run up with';
  const found = await deps.solana.rail(solanaSecret(key)).findRun(account, run.id, run.notBefore === undefined ? {} : { notBefore: run.notBefore });
  if (found === null) return 'the chain holds no run under this id';
  if (found.signature !== run.tx) return `the chain holds the run in ${found.signature}, not in the transaction the file names`;
  if (found.transfers.length !== run.lines.length) return `the chain holds ${found.transfers.length} lines, the file ${run.lines.length}`;
  const lines: PaidPayoutRun['lines'][number][] = [];
  for (const [index, line] of run.lines.entries()) {
    const paid = found.transfers[index];
    if (paid === undefined || paid.to !== line.to || paid.amount !== line.amount || (paid.memo !== null && paid.memo !== line.reference)) return `line ${index + 1} is not what the chain shows`;
    lines.push({ payeeName: line.payeeName, toAddress: line.to, amount: line.amount, memo: paid.memo ?? '', reference: line.reference, tx: found.signature, logIndex: null });
  }
  return { id: run.id, chain: 'solana', token: deps.solana.mint, tokenSymbol: deps.solana.tokenSymbol, tokenDecimals: deps.solana.decimals, account, notBefore: run.notBefore ?? null, tx: found.signature, createdAt: run.createdAt, executedAt: run.paidAt, lines };
}

type SeedRefusal = DemoSeed['refusals'][number];

/** Ask the chain how a transaction ended. A refusal is one the chain itself recorded as failed. */
async function confirmedRefusal(deps: SeedDeps, seed: DemoSeed, refusal: SeedRefusal): Promise<{ outcome: string; evidence: unknown } | string> {
  if (refusal.chain === 'tempo') {
    const key = seed.keys.tempoAccessKey;
    if (key === undefined) return 'the file names no Tempo access key to read the chain with';
    const chain = deps.tempo.chain(key as Hex);
    const receipt = await chain.receipt(refusal.tx as Hex);
    if (receipt === null) return 'the chain has no such transaction';
    if (receipt.status !== 'reverted') return 'the transaction succeeded on chain, so it is not a refusal';
    const returnData = await chain.revertData(refusal.tx as Hex).catch(() => null);
    const reason = decodeRevertReason(returnData)?.name ?? null;
    return { outcome: reason ?? 'reverted; the node did not return the reason', evidence: { reverted: true, reason, returnData, gasUsed: receipt.gasUsed, blockNumber: receipt.blockNumber } };
  }
  const recorded = await deps.solana.recorded(refusal.tx);
  if (recorded === null) return 'the chain has no such transaction';
  if (!recorded.failed) return 'the transaction succeeded on chain, so it is not a refusal';
  return { outcome: recorded.error ?? 'failed on chain', evidence: { failedOnChain: true, error: recorded.error } };
}

export async function seedDemo(deps: SeedDeps, seed: DemoSeed): Promise<SeedReport> {
  const { org } = seed;
  const ufvk = org.ufvk.trim();
  const safe = (text: string) => deps.redact(redactViewingKeys(text, ufvk));
  const checked = deps.zcash.check(ufvk);
  if (!checked.ok) throw new Error(`the viewing key was not accepted: ${safe(checked.error)}`);

  const items: SeedItem[] = [];
  const keys = await serviceKeys(deps, seed);
  const profile = {
    name: org.name,
    monthlyBurnUsd: org.monthlyBurnUsd,
    tempoAccount: org.tempoAccount === null ? null : getAddress(org.tempoAccount),
    solanaOwner: org.solanaOwner,
    publicDemo: true,
  };

  const existing = await deps.store.findOrg(org.id);
  if (existing === null) {
    await deps.store.createOrg({ id: org.id, ufvk, birthday: org.birthday, hlUser: org.owner.toLowerCase(), policy: DEFAULT_POLICY, lockEnabled: false, ...profile }, keys);
    items.push({ what: `organisation ${org.id}`, result: 'recorded', detail: `registered as a public demo, owned by ${org.owner.toLowerCase()}` });
    for (const key of keys) items.push({ what: `${key.kind} key`, result: 'recorded', detail: key.address });
  } else {
    // An organisation is never handed to another owner or another treasury by a file.
    if (!sameHex(existing.hlUser, org.owner)) throw new Error(`organisation ${org.id} is owned by another address than the file names; nothing was changed`);
    if ((await deps.store.loadOrg(org.id)).ufvk !== ufvk) throw new Error(`organisation ${org.id} is registered with another viewing key than the file holds; nothing was changed`);
    await deps.store.updateOrg(org.id, profile);
    items.push({ what: `organisation ${org.id}`, result: 'kept', detail: 'already registered; its profile was brought in line with the file and it is a public demo' });
    for (const key of keys) {
      const installed = await deps.store.installKey(org.id, key);
      items.push({ what: `${key.kind} key`, result: installed ? 'recorded' : 'kept', detail: key.address });
    }
  }

  for (const run of seed.payoutRuns) {
    const what = `payout run ${run.id}`;
    try {
      if ((await deps.store.findPayoutRun(org.id, run.id)) !== null) {
        items.push({ what, result: 'kept', detail: 'already on record' });
        continue;
      }
      const confirmed = await confirmedRun(deps, seed, run);
      if (typeof confirmed === 'string') {
        items.push({ what, result: 'skipped', detail: confirmed });
        continue;
      }
      const recorded = await deps.store.importPaidRun(org.id, confirmed);
      items.push({ what, result: recorded ? 'recorded' : 'kept', detail: `${confirmed.lines.length} line(s) paid in ${confirmed.tx}` });
    } catch (error) {
      items.push({ what, result: 'skipped', detail: `it could not be confirmed on chain: ${safe(messageOf(error))}` });
    }
  }

  for (const refusal of seed.refusals) {
    const what = `${refusal.chain} refusal ${refusal.tx}`;
    try {
      const confirmed = await confirmedRefusal(deps, seed, refusal);
      if (typeof confirmed === 'string') {
        items.push({ what, result: 'skipped', detail: confirmed });
        continue;
      }
      const row = await deps.store.recordRefusal(org.id, { chain: refusal.chain, kind: refusal.kind, attempted: refusal.attempted, outcome: confirmed.outcome, tx: refusal.tx, evidence: confirmed.evidence });
      items.push({ what, result: row === null ? 'kept' : 'recorded', detail: row === null ? 'already on record' : confirmed.outcome });
    } catch (error) {
      items.push({ what, result: 'skipped', detail: `it could not be confirmed on chain: ${safe(messageOf(error))}` });
    }
  }

  return { orgId: org.id, items, complete: items.every((item) => item.result !== 'skipped') };
}

/** The report as lines for a terminal. */
export function describeReport(report: SeedReport): string[] {
  const mark = { recorded: '+', kept: '=', skipped: '!' } as const;
  return [
    ...report.items.map((item) => `${mark[item.result]} ${item.what}: ${item.result === 'skipped' ? 'NOT recorded, ' : ''}${item.detail}`),
    report.complete ? 'Everything the file names is on record.' : 'Some of what the file names was left out; see the lines marked "!".',
  ];
}
