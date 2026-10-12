import { randomBytes } from 'node:crypto';
import { type HedgeSnapshot, type JournalAttestation, attestationFor, commitTreasury, hedgeAttestorAbi, journalLeaves, merkleProof } from '@holdfast/attest';
import { ZERO_ROOT, merkleRoot } from '@holdfast/core';
import type { AttestationRow, NewServiceKey, OrgRecord, TreasuryOpening } from '@holdfast/db';
import type { JournalEntry } from '@holdfast/engine';
import { formatZec } from '@holdfast/zcash';
import { type Address, type Hex, encodeFunctionData, getAddress } from 'viem';
import { generatePrivateKey, privateKeyToAddress } from 'viem/accounts';
import type { ZecPerp } from '../config';
import type { AttestationCall, AttestorPort, ContractRefusal, Deps } from '../deps';
import { notFound, refused, unavailable } from '../errors';
import { JOURNAL, treasuryReading } from '../live';
import { type Reading, available, mapReading, reading } from '../reading';
import { messageOf } from '../redact';

/**
 * Hedge attestations: snapshots of an organisation's hedge and journal that
 * the HedgeAttestor contract records on HyperEVM. The contract reads the
 * position and the prices itself; what the service supplies is the root and
 * length of the journal and a commitment to the treasury balance.
 *
 * Whether a snapshot is due, and what the latest one says, is always taken
 * from the chain. The database only remembers what the service sent: which
 * transaction recorded which snapshot, what opens its commitment, and
 * whether the contract has refused to continue a series.
 */

export const HYPEREVM = 'hyperevm';
/** How long the step waits for a transaction it has just sent to appear on chain, ms. HyperEVM makes a block about every second. */
export const RECEIPT_WAIT_MS = 20_000;
/** A transaction the chain has not shown this long after it was sent is given up for lost, ms. */
export const PENDING_GIVE_UP_MS = 15 * 60_000;
/** How long one step may take before it must not send any more, ms, unless the caller allows less. */
export const ATTEST_BUDGET_MS = 45_000;
/** How many of the latest snapshots a list shows. */
export const SNAPSHOTS_SHOWN = 10;
/** How long a page waits for the chain before it says so, ms. */
const LIST_PATIENCE_MS = 8_000;
/** The same for the line about the latest snapshot on pages that are mainly about something else, ms. */
const SUMMARY_PATIENCE_MS = 4_000;

const NOT_RECORDED = 'this deployment records no attestations';
/** The contract's two ways of saying that a journal does not continue the series it is offered to. */
const ENDS_SERIES: ReadonlySet<string> = new Set(['JournalShrank', 'JournalRewritten']);

const sameHex = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * Why something failed, as it may be shown or logged. A query that failed is
 * known by the database's own reason alone: the error around it quotes the
 * statement with its parameters, and a treasury balance is among those.
 */
function reasonOf(deps: Pick<Deps, 'redact'>, error: unknown): string {
  if (error instanceof Error && error.name === 'DrizzleQueryError') {
    return `the database could not be used: ${error.cause instanceof Error ? deps.redact(error.cause.message) : 'a query failed'}`;
  }
  return deps.redact(messageOf(error));
}

/** The service key that records snapshots for an organisation, from its private key. */
export function attesterKeyOf(privateKey: Hex): NewServiceKey {
  return { kind: 'hl_attester', address: privateKeyToAddress(privateKey).toLowerCase(), secret: privateKey };
}

/** A fresh attester key. Until the organisation's account names it on the contract it can record nothing. */
export const newAttesterKey = (): NewServiceKey => attesterKeyOf(generatePrivateKey());

/** The account an organisation's snapshots are recorded under: its Hyperliquid account, which on HyperEVM is the same address. */
function accountOf(org: Pick<OrgRecord, 'hlUser'>): Address {
  return getAddress(org.hlUser);
}

/**
 * The first `count` entries of an organisation's journal, oldest first.
 * Anything short of all of them is refused: a root over part of a journal is
 * not the root of the journal.
 */
async function journalPrefix(deps: Pick<Deps, 'store'>, orgId: string, count: number): Promise<JournalEntry[]> {
  const entries = count === 0 ? [] : await deps.store.journalRange(orgId, 1, count);
  // Sequence numbers are unique and the range starts at 1, so this many entries are exactly the first `count`.
  if (entries.length !== count) throw new Error(`the journal could not be read completely: ${entries.length} of its first ${count} entries were found`);
  return entries;
}

export type OrgAttestation =
  /** The chain holds a new snapshot: from a transaction sent now, or from one sent earlier that the chain has now shown. */
  | { orgId: string; status: 'attested'; series: bigint; number: bigint; tx: string; journalCount: bigint }
  /** Sent, and its end is not known yet. A later tick looks for it by its hash, and nothing else is sent until then. */
  | { orgId: string; status: 'pending'; tx: string; reason: string }
  /** The contract will not continue the series with this journal. Nothing is sent until the owner starts a new series. */
  | { orgId: string; status: 'refused'; series: bigint; reason: string }
  /** Nothing was due, or the organisation is not set up to attest. */
  | { orgId: string; status: 'skipped'; reason: string }
  /** Something the attestation rests on could not be read, or is too old. Nothing was sent. */
  | { orgId: string; status: 'unavailable'; reason: string }
  /** A transaction that was sent recorded nothing: the chain included it without a snapshot, or never showed it. */
  | { orgId: string; status: 'failed'; tx: string; reason: string };

export interface AttestOptions {
  /** How long the step may take before it must not send, ms. */
  budgetMs?: number;
  /** How long to wait for the receipt of a transaction sent in this step, ms. */
  receiptWaitMs?: number;
}

type StepDeps = Pick<Deps, 'store' | 'attestor' | 'now' | 'redact' | 'report'>;

interface Step {
  deps: StepDeps;
  attestor: AttestorPort;
  org: OrgRecord;
  user: Address;
  attester: { address: Address; privateKey: Hex };
  deadline: number;
  receiptWaitMs: number;
}

const skipped = (orgId: string, reason: string): OrgAttestation => ({ orgId, status: 'skipped', reason });
const unread = (orgId: string, reason: string): OrgAttestation => ({ orgId, status: 'unavailable', reason });

/** Record that the contract refused to continue a series, which stops attesting in it. */
async function stop(step: Step, series: bigint, journal: JournalAttestation, refusal: ContractRefusal): Promise<OrgAttestation> {
  const { deps, org } = step;
  await deps.store.recordAttestation(org.id, {
    series,
    number: null,
    tx: null,
    journalCount: journal.journalCount,
    journalRoot: journal.journalRoot,
    treasury: null,
    sentAt: deps.now(),
    status: 'refused',
    detail: refusal.text,
  });
  deps.report(`attestations of ${org.id} stopped in series ${series}: the contract answered ${refusal.text}`);
  return { orgId: org.id, status: 'refused', series, reason: refusal.text };
}

/**
 * Find out how a transaction that was sent ended, and write it down. While
 * the chain does not show it the attestation stays pending, until it has been
 * missing for so long that it is given up for lost.
 */
async function settle(step: Step, row: AttestationRow, tx: Hex, waitMs: number): Promise<OrgAttestation> {
  const { deps, attestor, org } = step;
  const orgId = org.id;

  let receipt: Awaited<ReturnType<AttestorPort['receipt']>>;
  try {
    receipt = await attestor.receipt(tx, waitMs);
  } catch (error) {
    return { orgId, status: 'pending', tx, reason: `its receipt could not be read: ${deps.redact(messageOf(error))}` };
  }

  if (receipt === null) {
    const age = deps.now() - row.sentAt;
    if (age < PENDING_GIVE_UP_MS) return { orgId, status: 'pending', tx, reason: 'the chain does not show the transaction yet' };
    const detail = `no receipt ${Math.round(age / 60_000)} minutes after it was sent`;
    await deps.store.settleAttestation(orgId, row.id, { status: 'lost', detail });
    deps.report(`attestation ${tx} of ${orgId} was given up for lost: ${detail}`);
    return { orgId, status: 'failed', tx, reason: detail };
  }

  const { recorded } = receipt;
  if (receipt.ok && recorded !== null && sameHex(recorded.user, step.user)) {
    const { series, number } = recorded.snapshot;
    await deps.store.settleAttestation(orgId, row.id, { status: 'confirmed', series, number });
    return { orgId, status: 'attested', series, number, tx, journalCount: recorded.snapshot.journalCount };
  }

  // The chain included the transaction and recorded nothing. Whether the journal was the reason is the
  // contract's to say, so it is asked what it makes of the same attestation now.
  const call: AttestationCall = { user: step.user, journalRoot: row.journalRoot, journalCount: row.journalCount, treasuryCommitment: row.commitment ?? ZERO_ROOT };
  let refusal: ContractRefusal | null = null;
  let unasked: string | null = null;
  try {
    refusal = await attestor.refusalOf(step.attester.address, call);
  } catch (error) {
    unasked = deps.redact(messageOf(error));
  }
  if (refusal !== null && ENDS_SERIES.has(refusal.error)) {
    await deps.store.settleAttestation(orgId, row.id, { status: 'refused', detail: refusal.text });
    deps.report(`attestations of ${orgId} stopped in series ${row.series}: ${tx} reverted, and the contract answers ${refusal.text}`);
    return { orgId, status: 'refused', series: row.series, reason: refusal.text };
  }
  const why = refusal !== null ? `the contract now answers ${refusal.text}` : unasked !== null ? `the contract could not be asked why: ${unasked}` : 'the contract would record the same attestation now';
  const detail = `the chain included the transaction and it recorded no snapshot; ${why}`;
  await deps.store.settleAttestation(orgId, row.id, { status: 'reverted', detail });
  deps.report(`attestation ${tx} of ${orgId} recorded nothing: ${detail}`);
  return { orgId, status: 'failed', tx, reason: detail };
}

/** Everything up to the decision to send. It returns what to send, or the reason nothing is sent. */
async function prepare(step: Step): Promise<OrgAttestation | { series: bigint; journal: JournalAttestation; opening: TreasuryOpening; call: AttestationCall }> {
  const { deps, attestor, org, user, attester } = step;
  const orgId = org.id;

  const registered = await attestor.attesterOf(user);
  if (registered === null || !sameHex(registered, attester.address)) {
    return skipped(orgId, `the chain does not show ${attester.address} as the attester of the organisation's account`);
  }

  // A transaction that passed the node's own run and still recorded nothing is not followed by another at
  // once: whatever undid it may undo the next, at the price of its gas. One interval has to pass first.
  const [last] = await deps.store.listAttestations(orgId, 1);
  if (last?.status === 'reverted' && deps.now() - last.sentAt < attestor.everyMs) {
    return skipped(orgId, `the last transaction recorded nothing; nothing is sent within ${attestor.everyMs / 60_000} minutes of it`);
  }

  const series = await attestor.series(user, 'current');
  const stopped = await deps.store.refusedAttestation(orgId, series.series);
  if (stopped !== null) {
    return skipped(orgId, `attesting stopped in series ${series.series} when the contract answered ${stopped.detail ?? 'with a refusal'}; it resumes once the owner starts a new series`);
  }

  const length = org.nextSeq - 1;
  if (length === 0) return skipped(orgId, 'the journal is empty');
  const latest = series.snapshotCount === 0n ? null : await attestor.snapshot(user, series.series, 'latest');
  if (latest !== null && BigInt(length) > latest.journalCount) {
    // Due by the chain's own clock: the timestamp of the block that recorded the latest snapshot. This is
    // where most steps end, so it is asked before the journal is read.
    const sinceMs = deps.now() - Number(latest.timestamp) * 1000;
    if (sinceMs < attestor.everyMs) {
      return skipped(orgId, `not due: snapshot ${latest.number} was recorded ${Math.max(0, Math.floor(sinceMs / 60_000))} minutes ago, and the next follows after ${attestor.everyMs / 60_000}`);
    }
  }

  const entries = await journalPrefix(deps, orgId, length);
  const journal = attestationFor(entries);
  if (entries.at(-1)?.digest !== org.lastDigest) throw new Error('the journal does not end at the entry the organisation names as its last');
  if (latest !== null && journal.journalCount <= latest.journalCount) {
    if (journal.journalCount === latest.journalCount && sameHex(journal.journalRoot, latest.journalRoot)) {
      return skipped(orgId, `the journal has not grown since snapshot ${latest.number} of series ${latest.series}`);
    }
    // The journal is shorter than the one the series committed to, or as long and not the same one. The
    // contract is asked for its own answer; the commitment plays no part in it, so none is made.
    const refusal = await attestor.refusalOf(attester.address, { user, ...journal, treasuryCommitment: ZERO_ROOT });
    if (refusal !== null && ENDS_SERIES.has(refusal.error)) return stop(step, series.series, journal, refusal);
    return unread(orgId, refusal === null ? 'the chain did not refuse what its latest snapshot rules out; it may have changed while it was read' : `the contract answered ${refusal.text}`);
  }

  const treasury = treasuryReading(deps, org.policy, entries.at(-1));
  if (treasury.status !== 'ok') return unread(orgId, `the treasury balance of the latest tick is unavailable: ${treasury.reason}`);
  const salt: Hex = `0x${randomBytes(32).toString('hex')}`;
  const opening: TreasuryOpening = { zat: treasury.value.zat, salt, commitment: commitTreasury(treasury.value.zat, salt) };
  const call: AttestationCall = { user, ...journal, treasuryCommitment: opening.commitment };

  // The node runs the attestation before it is sent: one the contract would refuse costs nothing and is never sent.
  const refusal = await attestor.refusalOf(attester.address, call);
  if (refusal !== null) {
    if (ENDS_SERIES.has(refusal.error)) return stop(step, series.series, journal, refusal);
    return unread(orgId, `the contract would not record the snapshot: ${refusal.text}`);
  }
  return { series: series.series, journal, opening, call };
}

async function attest(step: Step): Promise<OrgAttestation> {
  const { deps, attestor, org } = step;
  const orgId = org.id;

  // A transaction sent earlier whose end is not known comes first, and nothing new is sent in the same step.
  const pending = await deps.store.pendingAttestation(orgId);
  if (pending !== null) {
    if (pending.tx === null) throw new Error(`pending attestation ${pending.id} has no transaction`);
    return settle(step, pending, pending.tx as Hex, 0);
  }

  const prepared = await prepare(step);
  if ('status' in prepared) return prepared;
  if (deps.now() >= step.deadline) return unread(orgId, 'the time allowed for the attestation ran out before it could be sent');

  // Written down before it leaves: the hash, to find it by, and the salt, without which its commitment could
  // never be opened. From here on the attestation is pending, whatever happens to this process. The database
  // holds one pending attestation for an organisation and no more, so a step that got here beside another
  // writes nothing, and then sends nothing.
  const { hash: tx, raw } = await attestor.sign(step.attester.privateKey, prepared.call);
  const row = await deps.store.recordAttestation(orgId, {
    series: prepared.series,
    number: null,
    tx,
    journalCount: prepared.journal.journalCount,
    journalRoot: prepared.journal.journalRoot,
    treasury: prepared.opening,
    sentAt: deps.now(),
    status: 'pending',
    detail: null,
  });
  if (row === null) return skipped(orgId, 'another attestation of the organisation is pending; nothing was sent');

  try {
    await attestor.broadcast(raw);
  } catch (error) {
    // The node may have taken it all the same. It stays pending and is looked for by its hash.
    const reason = `the node did not confirm taking it: ${deps.redact(messageOf(error))}`;
    deps.report(`attestation ${tx} of ${orgId}: ${reason}`);
    return { orgId, status: 'pending', tx, reason };
  }
  return settle(step, row, tx, Math.max(0, Math.min(step.receiptWaitMs, step.deadline - deps.now())));
}

/**
 * One attestation step for one organisation, to be run once its tick is over.
 *
 * A snapshot is sent only when all of this holds: the organisation has an
 * attester key; nothing sent earlier is still pending; the chain shows that
 * key as the attester of the organisation's account; the contract has not
 * refused to continue the current series; the whole journal can be read from
 * its first entry and is longer than the one the latest snapshot of the
 * series commits to; that snapshot is at least the configured interval old by
 * the chain's own timestamp, or the series holds none; the latest tick read
 * the treasury and the reading is still fresh; and the node, asked to run the
 * attestation, does not refuse it.
 *
 * The transaction is recorded as pending before it is sent, and settled when
 * the chain shows how it ended: in this step if that is soon, otherwise in a
 * later one. Whatever goes wrong stays here and is part of the answer.
 */
export async function attestOrganisation(deps: StepDeps, orgId: string, options: AttestOptions = {}): Promise<OrgAttestation> {
  const { attestor } = deps;
  if (attestor === null) return skipped(orgId, NOT_RECORDED);
  const deadline = deps.now() + (options.budgetMs ?? ATTEST_BUDGET_MS);
  try {
    const key = await deps.store.activeKey(orgId, 'hl_attester');
    if (key === null) return skipped(orgId, 'the organisation has no attester key');
    // Under the organisation's lock: one step at a time, and no tick appends to the journal while its root is taken.
    const held = await deps.store.withOrgLock(orgId, async () => {
      const org = await deps.store.findOrg(orgId);
      if (org === null) throw new Error(`unknown organisation ${orgId}`);
      const attester = { address: getAddress(key.address), privateKey: key.secret as Hex };
      return attest({ deps, attestor, org, user: accountOf(org), attester, deadline, receiptWaitMs: options.receiptWaitMs ?? RECEIPT_WAIT_MS });
    });
    return held.ran ? held.value : skipped(orgId, 'a tick holds the organisation');
  } catch (error) {
    const reason = reasonOf(deps, error);
    deps.report(`attestation of ${orgId}: ${reason}`);
    return unread(orgId, reason);
  }
}

/** One snapshot as it is shown: the contract's own record, with HyperCore's units turned into ZEC and dollars. */
export interface SnapshotView {
  series: bigint;
  number: bigint;
  /** The position as HyperCore reports it and the contract stores it: negative is short. */
  szi: bigint;
  /** The same position in ZEC, counted as a short: positive when the account is short. */
  shortZec: number;
  /** Dollars per ZEC. */
  oraclePx: number;
  markPx: number;
  /** The HyperCore block the position and the prices were read at. */
  l1Block: bigint;
  /** The time of the HyperEVM block that recorded the snapshot, ms. */
  at: number;
  journalCount: bigint;
  journalRoot: Hex;
  treasuryCommitment: Hex;
  /** The transaction that recorded it, where the service sent it or was told of it. */
  tx: string | null;
}

function viewOf(perp: ZecPerp, snapshot: HedgeSnapshot, tx: string | null): SnapshotView {
  const priceUnit = 10 ** (6 - perp.szDecimals);
  return {
    series: snapshot.series,
    number: snapshot.number,
    szi: snapshot.szi,
    shortZec: Number(-snapshot.szi) / 10 ** perp.szDecimals,
    oraclePx: Number(snapshot.oraclePx) / priceUnit,
    markPx: Number(snapshot.markPx) / priceUnit,
    l1Block: snapshot.l1BlockNumber,
    at: Number(snapshot.timestamp) * 1000,
    journalCount: snapshot.journalCount,
    journalRoot: snapshot.journalRoot,
    treasuryCommitment: snapshot.treasuryCommitment,
    tx,
  };
}

type ReadDeps = Pick<Deps, 'store' | 'attestor' | 'now' | 'redact'>;

async function inTime<T>(ms: number, work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer within ${ms / 1000} s`)), ms);
  });
  try {
    return await Promise.race([work, late]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A reading of the chain made for a page. It is unavailable where no
 * attestations are recorded, where their settings cannot be used, and when
 * the chain fails or takes too long.
 */
async function chainReading<T>(deps: Pick<Deps, 'attestor' | 'now' | 'redact'>, patienceMs: number, read: (attestor: AttestorPort) => Promise<T>): Promise<Reading<T>> {
  return reading(HYPEREVM, deps, async () => {
    const { attestor } = deps;
    if (attestor === null) throw new Error(NOT_RECORDED);
    return inTime(patienceMs, read(attestor));
  });
}

async function attesterAddress(deps: Pick<Deps, 'store'>, orgId: string): Promise<string | null> {
  return (await deps.store.listKeys(orgId)).find((key) => key.kind === 'hl_attester' && key.status === 'active')?.address ?? null;
}

/** Whom the chain shows as the attester of an organisation's account, read now; a null value when the account has named none. */
export async function namedAttester(deps: Pick<Deps, 'attestor' | 'now' | 'redact'>, org: Pick<OrgRecord, 'hlUser'>): Promise<Reading<string | null>> {
  return chainReading(deps, SUMMARY_PATIENCE_MS, (port) => port.attesterOf(accountOf(org)));
}

/** The numbers of the last `howMany` snapshots of a series that holds `count`, newest first. */
function latestNumbers(count: bigint, howMany: number): bigint[] {
  const numbers: bigint[] = [];
  for (let number = count - 1n; number >= 0n && numbers.length < howMany; number--) numbers.push(number);
  return numbers;
}

export interface AttestationList {
  /** The HedgeAttestor contract and the chain it is on; null where this deployment records no attestations. */
  contract: string | null;
  chainId: number | null;
  /** The organisation's Hyperliquid account. Its snapshots are recorded under this address, and anyone reading them from the contract names it. */
  account: string;
  /** The service key that records them; null when the organisation has none. */
  attester: string | null;
  /** The current series and its latest snapshots, newest first, read from the chain at the time of the request. */
  snapshots: Reading<{ series: bigint; snapshotCount: bigint; items: SnapshotView[] }>;
}

/** The latest snapshots of an organisation's current series, each read from the contract now. */
export async function attestationList(deps: ReadDeps, org: OrgRecord): Promise<AttestationList> {
  const { attestor } = deps;
  const attester = await attesterAddress(deps, org.id);
  const chain = await chainReading(deps, LIST_PATIENCE_MS, async (port) => {
    const user = accountOf(org);
    const series = await port.series(user, 'current');
    const snapshots = await Promise.all(latestNumbers(series.snapshotCount, SNAPSHOTS_SHOWN).map((number) => port.snapshot(user, series.series, number)));
    return { perp: port.perp, series, snapshots };
  });

  let snapshots: AttestationList['snapshots'];
  if (chain.status !== 'ok') {
    snapshots = chain;
  } else {
    const { perp, series } = chain.value;
    const sent = await deps.store.snapshotAttestations(
      org.id,
      series.series,
      chain.value.snapshots.map((snapshot) => snapshot.number),
    );
    const txOf = new Map(sent.map((row) => [row.number, row.tx]));
    snapshots = mapReading(chain, (read) => ({ series: series.series, snapshotCount: series.snapshotCount, items: read.snapshots.map((snapshot) => viewOf(perp, snapshot, txOf.get(snapshot.number) ?? null)) }));
  }
  return { contract: attestor?.contract ?? null, chainId: attestor?.chainId ?? null, account: org.hlUser, attester, snapshots };
}

/** The latest snapshot in a few fields, for pages that are mainly about something else. */
export interface AttestationSummary {
  contract: string;
  chainId: number;
  series: bigint;
  number: bigint;
  /** The time of the block that recorded it, ms. */
  at: number;
  shortZec: number;
  oraclePx: number;
  journalCount: bigint;
  journalRoot: Hex;
  tx: string | null;
}

/** The latest snapshot of an organisation's current series, read from the chain now; a null value when the series holds none yet. */
export async function latestAttestation(deps: ReadDeps, org: OrgRecord): Promise<Reading<AttestationSummary | null>> {
  const chain = await chainReading(deps, SUMMARY_PATIENCE_MS, async (port) => {
    const user = accountOf(org);
    const series = await port.series(user, 'current');
    const latest = series.snapshotCount === 0n ? null : await port.snapshot(user, series.series, 'latest');
    return { port, latest };
  });
  if (chain.status !== 'ok' || chain.value.latest === null) return mapReading(chain, () => null);
  const { port, latest } = chain.value;
  const [sent] = await deps.store.snapshotAttestations(org.id, latest.series, [latest.number]);
  const view = viewOf(port.perp, latest, sent?.tx ?? null);
  return available(chain.source, chain.readAt, {
    contract: port.contract,
    chainId: port.chainId,
    series: view.series,
    number: view.number,
    at: view.at,
    shortZec: view.shortZec,
    oraclePx: view.oraclePx,
    journalCount: view.journalCount,
    journalRoot: view.journalRoot,
    tx: view.tx,
  });
}

export interface OwnerAttestations extends AttestationList {
  /** What the service sent or tried, newest first, however it ended: pending, confirmed, reverted, refused or lost. */
  recorded: AttestationRow[];
  /**
   * Set while nothing is sent because the contract refused to continue the
   * current series with the organisation's journal. It ends when the owner
   * starts a new series. Unavailable when the chain cannot say which series
   * is the current one.
   */
  stopped: Reading<{ series: bigint; at: number; reason: string } | null>;
}

/** The same list for the owner, with what the service has on record beside it. */
export async function ownerAttestations(deps: ReadDeps, org: OrgRecord): Promise<OwnerAttestations> {
  const list = await attestationList(deps, org);
  const recorded = await deps.store.listAttestations(org.id);
  let stopped: OwnerAttestations['stopped'];
  if (list.snapshots.status !== 'ok') {
    stopped = list.snapshots;
  } else {
    const refusal = await deps.store.refusedAttestation(org.id, list.snapshots.value.series);
    stopped = mapReading(list.snapshots, (current) => (refusal === null ? null : { series: current.series, at: refusal.sentAt, reason: refusal.detail ?? 'the contract refused the attestation' }));
  }
  return { ...list, recorded, stopped };
}

/** What opens the treasury commitment of one snapshot. It is the organisation's to disclose, and nobody else's to read. */
export interface OpenedCommitment {
  series: bigint;
  number: bigint;
  /** The shielded balance that was committed to, in zatoshi and in ZEC. */
  treasuryZat: bigint;
  treasuryZec: string;
  salt: Hex;
  /** keccak256 of the balance and the salt, ABI-encoded as (uint64, bytes32): what the snapshot holds. */
  commitment: Hex;
}

export async function openCommitment(deps: Pick<Deps, 'store'>, org: OrgRecord, series: bigint, number: bigint): Promise<OpenedCommitment> {
  const opening = await deps.store.openAttestation(org.id, series, number);
  if (opening === null) throw notFound();
  return { series, number, treasuryZat: opening.zat, treasuryZec: formatZec(opening.zat), salt: opening.salt, commitment: opening.commitment };
}

export interface EntryProof {
  contract: string;
  chainId: number;
  /** The account the snapshot is recorded under: the first argument of `verifyEntry`. */
  account: string;
  series: bigint;
  number: bigint;
  /** The journal entry the proof is for. */
  seq: number;
  /** The entry's leaf: its digest, recomputed here from its content. Whoever checks should compute it from the entry too. */
  leaf: Hex;
  /** The partner nodes from the leaf up to the root, bottom first, as `verifyEntry` takes them. */
  proof: Hex[];
  /** What the snapshot commits to. */
  journalCount: bigint;
  journalRoot: Hex;
  /** The contract's own answer to `verifyEntry` for this leaf and proof, asked now. */
  verified: Reading<boolean>;
}

/**
 * The proof that one journal entry is under the root a snapshot committed
 * to, built from the journal as it was at that snapshot's count, with the
 * contract's own verdict on it.
 */
export async function entryProof(deps: ReadDeps, org: OrgRecord, at: { series: bigint; number: bigint; seq: number }): Promise<EntryProof> {
  const { attestor } = deps;
  if (attestor === null) throw unavailable(HYPEREVM, NOT_RECORDED);
  const user = accountOf(org);

  // Asked in this order so that a snapshot that does not exist is told apart from a chain that cannot be read.
  let snapshot: HedgeSnapshot | null;
  try {
    snapshot = await inTime(LIST_PATIENCE_MS, (async () => {
      const current = await attestor.series(user, 'current');
      if (at.series > current.series) return null;
      const series = at.series === current.series ? current : await attestor.series(user, at.series);
      return at.number >= series.snapshotCount ? null : attestor.snapshot(user, at.series, at.number);
    })());
  } catch (error) {
    throw unavailable(HYPEREVM, deps.redact(messageOf(error)));
  }
  if (snapshot === null) throw notFound();

  if (BigInt(at.seq) > snapshot.journalCount) {
    throw refused(`entry ${at.seq} is not among the ${snapshot.journalCount} entries this snapshot commits to`);
  }
  if (snapshot.journalCount > BigInt(org.nextSeq - 1)) {
    throw refused(`this snapshot commits to ${snapshot.journalCount} entries and the journal holds ${org.nextSeq - 1}, so no proof under it can be built`);
  }
  let leaves: Hex[];
  try {
    leaves = journalLeaves(await journalPrefix(deps, org.id, Number(snapshot.journalCount)));
  } catch (error) {
    throw unavailable(JOURNAL, reasonOf(deps, error));
  }
  if (!sameHex(merkleRoot(leaves), snapshot.journalRoot)) {
    throw refused('the journal as it stands does not give the root this snapshot committed to, so no proof under it can be built');
  }
  const leaf = leaves[at.seq - 1];
  if (leaf === undefined) throw notFound();
  const proof = merkleProof(leaves, at.seq - 1);

  return {
    contract: attestor.contract,
    chainId: attestor.chainId,
    account: org.hlUser,
    series: at.series,
    number: at.number,
    seq: at.seq,
    leaf,
    proof,
    journalCount: snapshot.journalCount,
    journalRoot: snapshot.journalRoot,
    verified: await chainReading(deps, LIST_PATIENCE_MS, (port) => port.verifyEntry(user, at.series, at.number, leaf, proof)),
  };
}

/** A call for the owner's wallet to send, from the organisation's account on HyperEVM. */
export interface WalletCall {
  to: string;
  data: Hex;
  chainId: number;
}

export interface AttestorView {
  /** The HedgeAttestor contract and the chain it is on; null where this deployment records no attestations. */
  contract: string | null;
  chainId: number | null;
  /** The account both calls have to come from: the organisation's Hyperliquid account, on HyperEVM. */
  account: string;
  /** The service key that records snapshots for the organisation; null when it has none. */
  attester: string | null;
  /** Whom the chain shows as the account's attester now, and whether that is this organisation's key. */
  registered: Reading<{ attester: string | null; registered: boolean }>;
  /** `setAttester(attester)`: names the organisation's key as the one that may record its snapshots. */
  setAttester: WalletCall | null;
  /** `startSeries()`: closes the current series and starts the next. The contract refuses it while the current series is empty. */
  startSeries: WalletCall | null;
}

/**
 * What the owner needs to let the service attest: the key to name, the two
 * calls only the organisation's own account can make, and what the chain
 * shows at this moment.
 */
export async function attestorOf(deps: ReadDeps, org: OrgRecord): Promise<AttestorView> {
  const { attestor } = deps;
  const attester = await attesterAddress(deps, org.id);
  const registered = mapReading(await namedAttester(deps, org), (current) => ({ attester: current, registered: current !== null && attester !== null && sameHex(current, attester) }));
  const callOf = (data: Hex): WalletCall | null => (attestor === null ? null : { to: attestor.contract, data, chainId: attestor.chainId });
  return {
    contract: attestor?.contract ?? null,
    chainId: attestor?.chainId ?? null,
    account: org.hlUser,
    attester,
    registered,
    setAttester: attester === null ? null : callOf(encodeFunctionData({ abi: hedgeAttestorAbi, functionName: 'setAttester', args: [getAddress(attester)] })),
    startSeries: callOf(encodeFunctionData({ abi: hedgeAttestorAbi, functionName: 'startSeries' })),
  };
}
