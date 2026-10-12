import { commitTreasury } from '@holdfast/attest';
import { BLOCK_CLOCK_ALLOWANCE_MS, matchSwapFunding } from '@holdfast/books';
import { DEFAULT_POLICY } from '@holdfast/core';
import { type NewAttestation, type NewServiceKey, type OrgRecord, type PaidPayoutRun, type SettledSwap, runNumberOf } from '@holdfast/db';
import { ASSETS, type SwapStatus } from '@holdfast/intents';
import { decodeRevertReason, lineMemo, lineOfMemo } from '@holdfast/tempo';
import { redactViewingKeys } from '@holdfast/zcash';
import { type Hex, getAddress, isAddress } from 'viem';
import { privateKeyToAddress } from 'viem/accounts';
import { z } from 'zod';
import { attesterKeyOf } from '../attestations/service';
import { looksLikeSolanaAddress } from '../config';
import type { Deps } from '../deps';
import { ApiError } from '../errors';
import { fundingDestination } from '../funding/service';
import { messageOf } from '../redact';

/**
 * Registers what an organisation has already done on its chains: who it is,
 * the service keys it uses, the payout runs it has paid, the refusals it has
 * provoked, the snapshots of its hedge it has had attested and the swaps that
 * funded its own accounts. Nothing is taken on the file's word where a chain
 * or the swap service can be asked: a run, a refusal, an attestation or a
 * swap is recorded only once that shows it. Running it again records nothing
 * twice.
 */

const hexKey = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
/** Thirty-two bytes as hex: a transaction hash, a journal root, a salt. */
const bytes32 = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/)
  .transform((text) => text.toLowerCase() as Hex);
const moment = z.iso.datetime({ offset: true }).transform((text) => Date.parse(text));
const amount = z
  .string()
  .regex(/^[1-9]\d{0,38}$/)
  .transform((digits) => BigInt(digits));
/** A series, a snapshot number or a count of journal entries. */
const counter = z
  .number()
  .int()
  .min(0)
  .max(Number.MAX_SAFE_INTEGER)
  .transform((n) => BigInt(n));
/** A balance in zatoshi; unlike an amount to pay it may be zero. */
const zatoshi = z
  .string()
  .regex(/^(0|[1-9]\d{0,18})$/)
  .transform((digits) => BigInt(digits));
/** A Zcash transaction id: thirty-two bytes as hex, as explorers write it. */
const zcashTx = z
  .string()
  .regex(/^[0-9a-fA-F]{64}$/)
  .transform((text) => text.toLowerCase());

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
    /** The key the organisation's account has named on the HedgeAttestor contract. */
    hedgeAttester: hexKey.optional(),
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
  /** Snapshots the HedgeAttestor contract already holds for the organisation, with what opens each treasury commitment. */
  attestations: z.array(z.strictObject({ series: counter, number: counter, tx: bytes32, journalCount: counter, root: bytes32, treasuryZat: zatoshi, salt: bytes32 })).default([]),
  /** Swaps of ZEC into dollars on one of the organisation's own accounts that completed before the database knew of them. */
  swaps: z
    .array(
      z.strictObject({
        purpose: z.enum(['margin', 'payout_float']),
        depositAddress: z.string().min(1).max(128),
        amountInZat: amount,
        /** The treasury's payment to the deposit address. */
        originTx: zcashTx,
        /** What the file expects was delivered, in base units of the destination asset, and in which transaction. Each is held against the swap service's answer when given. */
        amountOut: amount.optional(),
        destinationTx: z.string().min(1).max(128).optional(),
      }),
    )
    .default([]),
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

type SeedDeps = Pick<Deps, 'store' | 'zcash' | 'tempo' | 'solana' | 'attestor' | 'oneClick' | 'redact'>;

const sameHex = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

function solanaSecret(key: NonNullable<DemoSeed['keys']['solanaDelegate']>): string {
  return typeof key === 'string' ? key.toLowerCase() : Buffer.from(key).toString('hex');
}

async function serviceKeys(deps: SeedDeps, seed: DemoSeed): Promise<NewServiceKey[]> {
  const keys: NewServiceKey[] = [];
  const { hyperliquidAgent, tempoAccessKey, solanaDelegate, hedgeAttester } = seed.keys;
  if (hyperliquidAgent !== undefined) keys.push({ kind: 'hl_agent', address: privateKeyToAddress(hyperliquidAgent as Hex).toLowerCase(), secret: hyperliquidAgent });
  if (tempoAccessKey !== undefined) keys.push({ kind: 'tempo_access', address: deps.tempo.rail(tempoAccessKey as Hex).accessKeyAddress, secret: tempoAccessKey });
  if (solanaDelegate !== undefined) {
    const secret = solanaSecret(solanaDelegate);
    keys.push({ kind: 'solana_delegate', address: await deps.solana.rail(secret).delegate(), secret });
  }
  if (hedgeAttester !== undefined) keys.push(attesterKeyOf(hedgeAttester as Hex));
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

type SeedAttestation = DemoSeed['attestations'][number];

/**
 * Ask the contract for the snapshot the file describes, and the chain for the
 * transaction said to have recorded it. It comes back ready to record only if
 * the snapshot holds this journal root and count, the balance and salt open
 * its treasury commitment, and that transaction recorded exactly it.
 */
async function confirmedAttestation(deps: SeedDeps, seed: DemoSeed, attestation: SeedAttestation): Promise<NewAttestation | string> {
  const { attestor } = deps;
  if (attestor === null) return 'this deployment records no attestations: it names no HedgeAttestor contract, or its network is not mainnet';
  const user = getAddress(seed.org.owner);
  const { series, number } = attestation;

  const current = await attestor.series(user, 'current');
  if (series > current.series) return `the chain holds no series ${series} for this account`;
  const held = series === current.series ? current : await attestor.series(user, series);
  if (number >= held.snapshotCount) return `series ${series} holds ${held.snapshotCount} snapshot(s) on chain, so none with this number`;
  const snapshot = await attestor.snapshot(user, series, number);

  if (snapshot.journalCount !== attestation.journalCount) return `the chain holds a snapshot of ${snapshot.journalCount} journal entries, the file one of ${attestation.journalCount}`;
  if (!sameHex(snapshot.journalRoot, attestation.root)) return 'the journal root is not the one the chain holds';
  const commitment = commitTreasury(attestation.treasuryZat, attestation.salt);
  if (!sameHex(snapshot.treasuryCommitment, commitment)) return 'the balance and the salt do not open the treasury commitment the chain holds';

  const receipt = await attestor.receipt(attestation.tx);
  if (receipt === null) return 'the chain has no such transaction';
  const recorded = receipt.ok ? receipt.recorded : null;
  if (recorded === null) return 'the transaction recorded no snapshot';
  if (!sameHex(recorded.user, user) || recorded.snapshot.series !== series || recorded.snapshot.number !== number) return 'the transaction recorded another snapshot than the one the file names';

  return {
    series,
    number,
    tx: attestation.tx,
    journalCount: snapshot.journalCount,
    journalRoot: snapshot.journalRoot,
    treasury: { zat: attestation.treasuryZat, salt: attestation.salt, commitment },
    // The chain's own time for it: the timestamp of the block that recorded the snapshot.
    sentAt: Number(snapshot.timestamp) * 1000,
    status: 'confirmed',
    detail: null,
  };
}

type SeedSwap = DemoSeed['swaps'][number];

const SWAP_SERVICE = 'the swap service';
const instant = (ms: number) => new Date(ms).toISOString();

/**
 * Whether the treasury's own scanned history holds the payment the file
 * names as a swap's deposit: a transparent payment of exactly the swap's
 * input, in that transaction, made while the swap lasted. A block's time may
 * be off by as much as the books allow for when they tie a payment to a
 * swap. Returns what is wrong, or null when the payment is there.
 */
async function depositProblem(deps: SeedDeps, org: OrgRecord, swap: SeedSwap, lasted: { from: number; to: number }): Promise<string | null> {
  const outgoing = await deps.store.outgoing(org.id);
  const inTx = outgoing.filter((payment) => sameHex(payment.txid, swap.originTx));
  if (inTx.length === 0) {
    const reached = org.scannedTo === null ? 'the treasury has not been scanned yet' : `the treasury is scanned to block ${org.scannedTo}`;
    return `${SWAP_SERVICE} names no origin transaction for it, and the treasury's scanned history holds no payment in ${swap.originTx}: ${reached}, and a tick has to scan past that transaction first`;
  }
  const deposit = inTx.find((payment) => payment.pool === 'transparent' && payment.zat === swap.amountInZat);
  if (deposit === undefined) return `the treasury's scanned history holds no transparent payment of ${swap.amountInZat} zat in ${swap.originTx}`;
  if (deposit.time < lasted.from - BLOCK_CLOCK_ALLOWANCE_MS || deposit.time > lasted.to + BLOCK_CLOCK_ALLOWANCE_MS) {
    return `the payment in ${swap.originTx} was made at ${instant(deposit.time)}, not while the swap lasted, from ${instant(lasted.from)} to ${instant(lasted.to)}`;
  }
  // A payment pays for one swap at most. The books have given this one away if a swap on record already takes it.
  const paidInZec = (await deps.store.listSwaps(org.id)).filter((known) => known.originAsset === ASSETS.ZEC);
  if ([...matchSwapFunding(paidInZec, outgoing).values()].includes(deposit.id)) return `the payment in ${swap.originTx} already funds another swap on record`;
  return null;
}

/**
 * Ask the swap service where the swap at a deposit address stands and, if it
 * completed as the file describes it, give it back ready to record, with how
 * its origin transaction was confirmed. It has to have succeeded, taken in
 * exactly the amount the file names, in ZEC, and delivered the asset of its
 * purpose to the organisation's own account for that purpose. Its origin
 * transaction has to be the one the swap service names; where the service
 * names none at all, the treasury's own history has to hold the payment.
 * What is recorded is the swap service's answer, not the file's: what was
 * delivered and in which transaction, the assets, and when the swap was
 * quoted and settled.
 */
async function confirmedSwap(deps: SeedDeps, org: OrgRecord, swap: SeedSwap): Promise<{ settled: SettledSwap; origin: string } | string> {
  let wanted: ReturnType<typeof fundingDestination>;
  try {
    wanted = fundingDestination(deps, org, swap.purpose);
  } catch (error) {
    // The organisation has no account for the purpose, or this deployment does not fund it.
    if (error instanceof ApiError) return error.message;
    throw error;
  }
  // Hyperliquid writes accounts and transactions in hex, where case says nothing; a Solana address or signature is its exact text.
  const sameThere = (a: string, b: string) => (swap.purpose === 'margin' ? sameHex(a, b) : a === b);

  let status: SwapStatus;
  try {
    status = await deps.oneClick.status(swap.depositAddress);
  } catch (error) {
    return `it could not be confirmed with ${SWAP_SERVICE}: ${messageOf(error)}`;
  }
  if (status.state !== 'SUCCESS') return `${SWAP_SERVICE} reports it as ${status.state}, not as completed`;
  const { quoted } = status;
  if (quoted === null) return `${SWAP_SERVICE} does not repeat the quote the swap was made on, so what it was for cannot be checked`;
  if (quoted.depositAddress !== swap.depositAddress) return `${SWAP_SERVICE} answered about another deposit address`;
  if (quoted.originAsset !== ASSETS.ZEC) return `it was paid in ${quoted.originAsset}, not in ZEC`;
  if (quoted.destinationAsset !== wanted.asset) return `it delivered ${quoted.destinationAsset}, and ${swap.purpose} is funded in ${wanted.asset}`;
  if (!sameThere(quoted.recipient, wanted.recipient)) return `its recipient is ${quoted.recipient}, not the organisation's own account ${wanted.recipient}`;
  if (status.amountIn === null) return `${SWAP_SERVICE} does not say how much it took in`;
  if (status.amountIn !== swap.amountInZat || quoted.amountIn !== swap.amountInZat) return `it took in ${status.amountIn} zat, the file names ${swap.amountInZat}`;
  if (status.amountOut === null || status.destinationTxs.length === 0) return `${SWAP_SERVICE} does not say what it delivered, or in which transaction`;
  if (status.updatedAt === null) return `${SWAP_SERVICE} does not say when it settled`;
  if (status.updatedAt < quoted.quotedAt) return `${SWAP_SERVICE} has it settled at ${instant(status.updatedAt)}, before it was quoted at ${instant(quoted.quotedAt)}`;
  if (swap.amountOut !== undefined && swap.amountOut !== status.amountOut) return `it delivered ${status.amountOut}, the file expects ${swap.amountOut}`;
  const { destinationTx } = swap;
  if (destinationTx !== undefined && !status.destinationTxs.some((tx) => sameThere(tx, destinationTx))) {
    return `it delivered in ${status.destinationTxs.join(', ')}, not in the transaction the file names`;
  }

  let origin: string;
  if (status.originTxs.length > 0) {
    // The swap service says which payment it took: that one, or the file is about another swap.
    if (!status.originTxs.some((tx) => sameHex(tx, swap.originTx))) return `${SWAP_SERVICE} names ${status.originTxs.join(', ')} as its origin transaction, not the one the file names`;
    origin = `${SWAP_SERVICE} names its origin transaction`;
  } else {
    const problem = await depositProblem(deps, org, swap, { from: quoted.quotedAt, to: status.updatedAt });
    if (problem !== null) return problem;
    origin = `${SWAP_SERVICE} names no origin transaction, and the treasury's own history holds the payment`;
  }

  const settled: SettledSwap = {
    purpose: swap.purpose,
    originAsset: quoted.originAsset,
    destinationAsset: quoted.destinationAsset,
    amountIn: status.amountIn,
    minAmountOut: quoted.minAmountOut,
    amountOut: status.amountOut,
    depositAddress: swap.depositAddress,
    // As the application writes it for a swap it quotes itself.
    recipient: wanted.recipient,
    quote: quoted,
    state: status.state,
    // Whatever the file says of it, the row holds what the swap service names.
    originTxs: status.originTxs,
    destinationTxs: status.destinationTxs,
    createdAt: quoted.quotedAt,
    updatedAt: status.updatedAt,
  };
  return { settled, origin };
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

  for (const attestation of seed.attestations) {
    const what = `attestation ${attestation.number} of series ${attestation.series}`;
    try {
      if ((await deps.store.snapshotAttestations(org.id, attestation.series, [attestation.number])).length > 0) {
        items.push({ what, result: 'kept', detail: 'already on record' });
        continue;
      }
      const confirmed = await confirmedAttestation(deps, seed, attestation);
      if (typeof confirmed === 'string') {
        items.push({ what, result: 'skipped', detail: confirmed });
        continue;
      }
      const row = await deps.store.recordAttestation(org.id, confirmed);
      items.push({ what, result: row === null ? 'kept' : 'recorded', detail: row === null ? 'already on record' : `${confirmed.journalCount} journal entries attested in ${attestation.tx}` });
    } catch (error) {
      items.push({ what, result: 'skipped', detail: `it could not be confirmed on chain: ${safe(messageOf(error))}` });
    }
  }

  if (seed.swaps.length > 0) {
    // The organisation as it now stands: its accounts are where a swap has to have delivered, and its scan says how far its history reaches.
    const registered = await deps.store.findOrg(org.id);
    for (const swap of seed.swaps) {
      const what = `swap at ${swap.depositAddress}`;
      try {
        if (registered === null) throw new Error(`organisation ${org.id} is not in the database`);
        if ((await deps.store.listSwaps(org.id)).some((known) => known.depositAddress === swap.depositAddress)) {
          items.push({ what, result: 'kept', detail: 'already on record' });
          continue;
        }
        const confirmed = await confirmedSwap(deps, registered, swap);
        if (typeof confirmed === 'string') {
          items.push({ what, result: 'skipped', detail: safe(confirmed) });
          continue;
        }
        const { settled, origin } = confirmed;
        const recorded = await deps.store.importSettledSwap(org.id, settled);
        const delivered = `${settled.amountIn} zat in, ${settled.amountOut} out in ${settled.destinationTxs.join(', ')}`;
        items.push({ what, result: recorded ? 'recorded' : 'kept', detail: recorded ? `${delivered}; ${origin}` : 'already on record' });
      } catch (error) {
        items.push({ what, result: 'skipped', detail: `it could not be recorded: ${safe(messageOf(error))}` });
      }
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
