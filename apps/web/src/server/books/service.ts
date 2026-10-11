import {
  type AssetDirectory,
  type AuditScope,
  DEFAULT_EXPLORERS,
  type DateRange,
  type ExplorerTemplates,
  type LedgerEntry,
  type PayoutEvidence,
  type PricePoint,
  type Reconciliation,
  type ScopedStatement,
  type Statement,
  buildLedger,
  buildPublishedStatement,
  buildStatement,
  policyInForce,
  reconcile,
  scopeStatement,
  serializePublishedStatement,
  solanaRunOnChain,
  tempoRunOnChain,
} from '@holdfast/books';
import type { OrgRecord, PayoutRunRow, SwapRow } from '@holdfast/db';
import type { JournalEntry } from '@holdfast/engine';
import type { Hex } from 'viem';
import type { Deps } from '../deps';
import { refused, unavailable } from '../errors';
import { messageOf } from '../redact';

/** The widest sequence number the journal's integer column holds. */
const LAST_SEQ = 2_147_483_647;
const MIN_SECRET_LENGTH = 8;

type BooksDeps = Pick<Deps, 'store' | 'hyperliquid' | 'tempo' | 'solana' | 'now' | 'redact'>;

/** Everything the books of one organisation are built from, read at one moment. */
export interface Books {
  ledger: LedgerEntry[];
  journal: JournalEntry[];
  swaps: SwapRow[];
  runs: PayoutRunRow[];
  /** The stablecoins this deployment pays out in: the service's own knowledge, never taken from a record. */
  assets: AssetDirectory;
  /** The venue's fills and funding are in the ledger from the organisation's start up to this moment. */
  through: number;
}

/** The tokens payouts are made in, each carried at one dollar a unit. */
export function payoutAssets(deps: Pick<Deps, 'tempo' | 'solana'>): AssetDirectory {
  return {
    [deps.tempo.token]: { symbol: deps.tempo.tokenSymbol, decimals: deps.tempo.decimals, chain: 'tempo', usdPegged: true },
    [deps.tempo.token.toLowerCase()]: { symbol: deps.tempo.tokenSymbol, decimals: deps.tempo.decimals, chain: 'tempo', usdPegged: true },
    [deps.solana.mint]: { symbol: deps.solana.tokenSymbol, decimals: deps.solana.decimals, chain: 'solana', usdPegged: true },
  };
}

function explorers(deps: Pick<Deps, 'tempo' | 'solana'>): ExplorerTemplates {
  return { ...DEFAULT_EXPLORERS, tempo: deps.tempo.txUrl('{tx}'), solana: deps.solana.txUrl('{tx}') };
}

/** ZEC/USD as each tick saw it: the venue's mark where it was read, the reference price where it was not. */
function pricesOf(journal: readonly JournalEntry[]): PricePoint[] {
  return journal.flatMap((entry): PricePoint[] => {
    const { hl, ref } = entry.snapshot;
    if (hl !== null) return [{ ts: hl.asOf, px: hl.markPx }];
    return ref === null ? [] : [{ ts: ref.asOf, px: ref.px }];
  });
}

/**
 * Read what the books are made of. The treasury's notes, the swaps and the
 * payout runs are the service's own records; the hedge's fills and funding
 * are read from the venue now. Without the venue there is no ledger: one that
 * silently lacked the hedge would be a wrong one.
 */
export async function gatherBooks(deps: BooksDeps, org: OrgRecord): Promise<Books> {
  const through = deps.now();
  const [journal, notes, outgoing, fees, swaps, runs] = await Promise.all([
    deps.store.journalRange(org.id, 1, LAST_SEQ),
    deps.store.notes(org.id),
    deps.store.outgoing(org.id),
    deps.store.fees(org.id),
    deps.store.listSwaps(org.id),
    deps.store.listPayoutRuns(org.id),
  ]);

  const venue = deps.hyperliquid.venue();
  const [fills, funding] = await Promise.all([venue.userFills(org.hlUser, org.createdAt), venue.userFunding(org.hlUser, org.createdAt)]).catch((error: unknown) => {
    throw unavailable('Hyperliquid', deps.redact(messageOf(error)));
  });

  const assets = payoutAssets(deps);
  const ledger = buildLedger({ notes, outgoing, fees, fills, funding, swaps, payoutRuns: runs, prices: pricesOf(journal), assets, explorers: explorers(deps) });
  return { ledger, journal, swaps, runs, assets, through };
}

/** The statement as of now, under the policy the journal shows the controller to be running under. */
export function statementOf(deps: Pick<Deps, 'now'>, org: OrgRecord, books: Books, range?: DateRange): Statement {
  return buildStatement({
    ledger: books.ledger,
    journal: books.journal,
    policy: policyInForce(org.policy, books.journal) ?? org.policy,
    now: deps.now(),
    monthlyBurnUsd: org.monthlyBurnUsd,
    ...(range === undefined ? {} : { range }),
  });
}

/**
 * Each run that was ever handed to a rail, beside what its chain shows for
 * it now. A draft was never sent and is left out. A chain that cannot be read
 * makes the whole answer unavailable: "nothing found" is a statement about
 * the chain and may only come from the chain.
 */
export async function payoutEvidence(deps: BooksDeps, org: OrgRecord, runs: readonly PayoutRunRow[]): Promise<PayoutEvidence[]> {
  const evidence: PayoutEvidence[] = [];
  for (const run of runs) {
    if (run.status === 'draft') continue;
    try {
      if (run.chain === 'tempo') {
        const key = await deps.store.activeKey(org.id, 'tempo_access');
        const account = run.account ?? org.tempoAccount;
        if (key === null || account === null) throw new Error('the organisation has no Tempo access key or account to look the run up with');
        evidence.push({ run, onChain: tempoRunOnChain(await deps.tempo.rail(key.secret as Hex).findRun(account, run.id)) });
      } else {
        const key = await deps.store.activeKey(org.id, 'solana_delegate');
        const account = run.account ?? org.solanaOwner;
        if (key === null || account === null) throw new Error('the organisation has no Solana service key or wallet to look the run up with');
        const earlier = (await deps.store.listKeys(org.id)).filter((k) => k.kind === 'solana_delegate' && k.status === 'revoked').map((k) => k.address);
        const found = await deps.solana.rail(key.secret, earlier).findRun(account, run.id, run.notBefore === null ? {} : { notBefore: run.notBefore });
        evidence.push({ run, onChain: solanaRunOnChain(found) });
      }
    } catch (error) {
      throw unavailable(run.chain === 'tempo' ? 'Tempo' : 'Solana', `run ${run.id} could not be looked up: ${deps.redact(messageOf(error))}`);
    }
  }
  return evidence;
}

/** The records that must agree, held against each other and against the chains. */
export async function reconciliationOf(deps: BooksDeps, org: OrgRecord, books: Books): Promise<Reconciliation> {
  const payouts = await payoutEvidence(deps, org, books.runs);
  return reconcile({ ledger: books.ledger, journal: books.journal, payouts, swaps: books.swaps, assets: books.assets });
}

/** A statement and its ledger cut down to what an auditor's scope covers. */
export async function scopedBooks(deps: BooksDeps, org: OrgRecord, scope: AuditScope): Promise<ScopedStatement> {
  const books = await gatherBooks(deps, org);
  return scopeStatement(statementOf(deps, org, books), books.ledger, scope);
}

/**
 * The statement with everything it was derived from, in the form
 * `holdfast verify` reads. It names the treasury by its address, which is
 * derived from the viewing key here; the key itself is given to the export
 * only as a string it must not contain.
 */
export async function publishedStatement(deps: BooksDeps & Pick<Deps, 'zcash' | 'knownSecrets'>, org: OrgRecord): Promise<string> {
  const books = await gatherBooks(deps, org);
  const payouts = await payoutEvidence(deps, org, books.runs);

  const { ufvk } = await deps.store.loadOrg(org.id);
  const treasury = deps.zcash.check(ufvk);
  if (!treasury.ok) throw refused('the stored viewing key no longer passes its check, so the treasury address cannot be named');

  const accounts = new Map<string, { chain: 'tempo' | 'solana'; account: string; token: string }>();
  const add = (chain: 'tempo' | 'solana', account: string | null, token: string) => {
    if (account !== null) accounts.set(`${chain}:${account}:${token}`, { chain, account, token });
  };
  add('tempo', org.tempoAccount, deps.tempo.token);
  add('solana', org.solanaOwner, deps.solana.mint);
  for (const run of books.runs) add(run.chain, run.account, run.token);

  try {
    return serializePublishedStatement(
      buildPublishedStatement({
        org: {
          id: org.id,
          name: org.name,
          zcash: { network: deps.zcash.network, address: treasury.address, birthday: org.birthday, scannedTo: org.scannedTo },
          hyperliquid: { account: org.hlUser, since: org.createdAt, through: books.through },
          payoutAccounts: [...accounts.values()],
        },
        policy: org.policy,
        ledger: books.ledger,
        journal: books.journal,
        swaps: books.swaps,
        payouts,
        now: deps.now(),
        monthlyBurnUsd: org.monthlyBurnUsd,
        secrets: [ufvk, ...deps.knownSecrets()].filter((secret) => secret.length >= MIN_SECRET_LENGTH),
      }),
    );
  } catch (error) {
    // The export refuses to be built around a secret; its message names none.
    throw refused(deps.redact(messageOf(error)).split(ufvk).join('[viewing key]'));
  }
}
