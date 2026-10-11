import { DEFAULT_POLICY, digest, type Policy } from '@holdfast/core';
import type { JournalEntry } from '@holdfast/engine';
import { LEDGER_KINDS, LEDGER_SOURCES, type LedgerEntry } from './entry';
import type { PayoutEvidence } from './evidence';
import type { DateRange } from './flows';
import { parseExact, stringifyExact } from './json';
import type { PayoutChain, SwapRecord } from './records';
import { amount, anything, type Check, flag, integer, list, nullable, number, oneOf, record, text } from './shape';
import { buildStatement, type SeriesStep, type Statement } from './statement';

export const PUBLISHED_STATEMENT_VERSION = 1;

/** What an organisation makes public about itself, enough to look its history up independently. */
export interface PublishedOrg {
  id: string;
  name: string;
  zcash: {
    network: 'mainnet' | 'testnet';
    /**
     * The unified address the treasury's viewing key receives on. It is what
     * ties a viewing key handed to a reader to the treasury this statement
     * is about, and it is the address payers already know.
     */
    address: string;
    /** First block that can hold treasury funds. */
    birthday: number;
    /** Last block the ledger's Zcash entries cover; null before the first scan. */
    scannedTo: number | null;
  };
  hyperliquid: {
    account: string;
    /** The ledger holds every fill and funding payment of the account between these two moments, ms. */
    since: number;
    through: number;
  };
  payoutAccounts: { chain: PayoutChain; account: string; token: string }[];
}

/**
 * A statement published together with everything it was derived from, so
 * that a reader can derive it again: the ledger, the journal the controller
 * wrote, the swap records, each payout run beside what its chain showed, and
 * the policy in force.
 */
export interface PublishedStatement {
  version: typeof PUBLISHED_STATEMENT_VERSION;
  generatedAt: number;
  org: PublishedOrg;
  policy: Policy;
  ledger: LedgerEntry[];
  /** The whole journal, from its first entry. */
  journal: JournalEntry[];
  swaps: SwapRecord[];
  payouts: PayoutEvidence[];
  statement: Statement;
}

export interface PublishInput {
  org: PublishedOrg;
  policy: Policy;
  ledger: readonly LedgerEntry[];
  journal: readonly JournalEntry[];
  swaps: readonly SwapRecord[];
  payouts: readonly PayoutEvidence[];
  now: number;
  monthlyBurnUsd: number | null;
  range?: DateRange;
  seriesStep?: SeriesStep;
  /**
   * Strings that must not leave the organisation: the viewing key, endpoint
   * URLs that carry a token, API keys. Journal entries are published whole,
   * error messages included, so the finished export is searched for each of
   * these and refused if one is found.
   */
  secrets?: readonly string[];
}

/**
 * The policy the controller is running under, as far as the journal shows:
 * the given one, or the given one with the hedge ratio at zero, which is what
 * the controller decides under while the lock is switched off. Null when the
 * latest entry was decided under neither.
 */
export function policyInForce(policy: Policy, journal: readonly JournalEntry[]): Policy | null {
  const latest = journal.reduce<JournalEntry | undefined>((last, entry) => (last === undefined || entry.seq > last.seq ? entry : last), undefined);
  if (latest === undefined || latest.policyDigest === digest(policy)) return policy;
  const lockOff = { ...policy, hedgeRatioBps: 0 };
  return latest.policyDigest === digest(lockOff) ? lockOff : null;
}

const VIEWING_KEY = /uview(test)?1[02-9ac-hj-np-z]{20,}/;

/**
 * Assemble the export. The statement is built here, from the same ledger and
 * journal that are published, so the figures cannot drift from what backs
 * them, and under the policy the journal shows to be in force, with that
 * policy's own limit on how old a reading may be. Records are copied field by
 * field: a database row handed in whole carries more than is meant to be
 * public, and none of the rest goes out.
 */
export function buildPublishedStatement(input: PublishInput): PublishedStatement {
  const { org } = input;
  const statement = buildStatement({
    ledger: input.ledger,
    journal: input.journal,
    policy: policyInForce(input.policy, input.journal) ?? input.policy,
    now: input.now,
    monthlyBurnUsd: input.monthlyBurnUsd,
    ...(input.range === undefined ? {} : { range: input.range }),
    ...(input.seriesStep === undefined ? {} : { seriesStep: input.seriesStep }),
  });

  const published: PublishedStatement = {
    version: PUBLISHED_STATEMENT_VERSION,
    generatedAt: input.now,
    org: {
      id: org.id,
      name: org.name,
      zcash: { network: org.zcash.network, address: org.zcash.address, birthday: org.zcash.birthday, scannedTo: org.zcash.scannedTo },
      hyperliquid: { account: org.hyperliquid.account, since: org.hyperliquid.since, through: org.hyperliquid.through },
      payoutAccounts: org.payoutAccounts.map((a) => ({ chain: a.chain, account: a.account, token: a.token })),
    },
    policy: { ...input.policy },
    ledger: input.ledger.map((e) => ({
      id: e.id,
      ts: e.ts,
      source: e.source,
      kind: e.kind,
      asset: e.asset,
      decimals: e.decimals,
      amount: e.amount,
      usd: e.usd,
      usdPrice: e.usdPrice,
      usdPriceAt: e.usdPriceAt,
      ref: e.ref,
      counterparty: e.counterparty === null ? null : { name: e.counterparty.name, address: e.counterparty.address },
      proof: { chain: e.proof.chain, tx: e.proof.tx, block: e.proof.block, url: e.proof.url },
      linked: [...e.linked],
    })),
    // An entry is covered by its digest as a whole, so it is published whole.
    journal: structuredClone([...input.journal]),
    swaps: input.swaps.map((s) => ({
      id: s.id,
      purpose: s.purpose,
      originAsset: s.originAsset,
      destinationAsset: s.destinationAsset,
      amountIn: s.amountIn,
      minAmountOut: s.minAmountOut,
      amountOut: s.amountOut,
      depositAddress: s.depositAddress,
      recipient: s.recipient,
      state: s.state,
      originTxs: [...s.originTxs],
      destinationTxs: [...s.destinationTxs],
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
    })),
    payouts: input.payouts.map(({ run, onChain }) => ({
      run: {
        id: run.id,
        chain: run.chain,
        token: run.token,
        status: run.status,
        total: run.total,
        tx: run.tx,
        createdAt: run.createdAt,
        executedAt: run.executedAt,
        lines: run.lines.map((l) => ({
          lineNo: l.lineNo,
          payeeName: l.payeeName,
          toAddress: l.toAddress,
          amount: l.amount,
          memo: l.memo,
          tx: l.tx,
          logIndex: l.logIndex,
        })),
      },
      onChain:
        onChain === null
          ? null
          : {
              tx: onChain.tx,
              transfers: onChain.transfers.map((t) => ({ to: t.to, tokenAccount: t.tokenAccount, amount: t.amount, memo: t.memo })),
              otherTxs: [...onChain.otherTxs],
            },
    })),
    statement,
  };

  const text = stringifyExact(published);
  const leaked = (input.secrets ?? []).findIndex((secret) => secret !== '' && text.includes(secret));
  if (leaked >= 0) throw new Error(`refusing to publish: the export would contain secret number ${leaked + 1} of those it was told to keep`);
  if (VIEWING_KEY.test(text)) throw new Error('refusing to publish: the export would contain a viewing key');
  return published;
}

export function serializePublishedStatement(published: PublishedStatement): string {
  return stringifyExact(published, 2);
}

export class PublishedStatementError extends Error {
  constructor(readonly faults: string[]) {
    super(`not a published statement: ${faults.slice(0, 5).join('; ')}${faults.length > 5 ? `; and ${faults.length - 5} more` : ''}`);
    this.name = 'PublishedStatementError';
  }
}

const hex = text;
const chain = oneOf(['tempo', 'solana']);

const orgShape = record({
  id: text,
  name: text,
  zcash: record({ network: oneOf(['mainnet', 'testnet']), address: text, birthday: integer, scannedTo: nullable(integer) }),
  hyperliquid: record({ account: text, since: integer, through: integer }),
  payoutAccounts: list(record({ chain, account: text, token: text })),
});

const entryShape = record({
  id: text,
  ts: number,
  source: oneOf(LEDGER_SOURCES),
  kind: oneOf(LEDGER_KINDS),
  asset: text,
  decimals: integer,
  amount,
  usd: nullable(number),
  usdPrice: nullable(number),
  usdPriceAt: nullable(number),
  ref: text,
  counterparty: nullable(record({ name: nullable(text), address: text })),
  proof: record({ chain: text, tx: nullable(text), block: nullable(integer), url: nullable(text) }),
  linked: list(text),
});

const journalShape = record({
  orgId: text,
  seq: integer,
  at: integer,
  prev: hex,
  digest: hex,
  snapshot: record({
    now: number,
    treasury: nullable(record({ zat: amount, asOf: number })),
    hl: nullable(record({ asOf: number, markPx: number, oraclePx: number, shortLots: number, accountValueUsd: number, fundingAprBps: number })),
    ref: nullable(record({ px: number, asOf: number })),
  }),
  policyDigest: hex,
  decision: record({}),
  advisories: list(anything),
  order: nullable(
    record({
      seq: integer,
      cloid: hex,
      side: oneOf(['buy', 'sell']),
      lots: number,
      limitPx: number,
      reduceOnly: flag,
      result: record({ ok: flag, filledLots: number, avgPx: nullable(number), oid: nullable(text), error: nullable(text) }),
    }),
  ),
  errors: list(anything),
  scan: nullable(record({ from: integer, to: integer, tip: integer, caughtUp: flag })),
});

const swapShape = record({
  id: text,
  purpose: text,
  originAsset: text,
  destinationAsset: text,
  amountIn: amount,
  minAmountOut: amount,
  amountOut: nullable(amount),
  depositAddress: text,
  recipient: text,
  state: text,
  originTxs: list(text),
  destinationTxs: list(text),
  createdAt: integer,
  updatedAt: integer,
});

const payoutShape = record({
  run: record({
    id: text,
    chain,
    token: text,
    status: text,
    total: amount,
    tx: nullable(text),
    createdAt: integer,
    executedAt: nullable(integer),
    lines: list(
      record({ lineNo: integer, payeeName: text, toAddress: text, amount, memo: text, tx: nullable(text), logIndex: nullable(integer) }),
    ),
  }),
  onChain: nullable(
    record({
      tx: text,
      transfers: list(record({ to: text, tokenAccount: nullable(text), amount, memo: nullable(text) })),
      otherTxs: list(text),
    }),
  ),
});

/** Only the form is checked: an organisation may publish under a policy the controller itself would refuse to act on. */
const policyShape = record(Object.fromEntries(Object.keys(DEFAULT_POLICY).map((key): [string, Check] => [key, number])));

const statementShape = record({
  asOf: integer,
  range: record({ from: nullable(number), to: nullable(number) }),
  monthlyBurnUsd: nullable(number),
  staleAfterMs: number,
  seriesStep: oneOf(['entry', 'day']),
  fees: record({}),
  series: list(anything),
  stale: list(anything),
  unpriced: list(text),
});

const publishedShape = record({
  generatedAt: integer,
  org: orgShape,
  policy: policyShape,
  ledger: list(entryShape),
  journal: list(journalShape),
  swaps: list(swapShape),
  payouts: list(payoutShape),
  statement: statementShape,
});

/**
 * Read an export back. The file comes from whoever published it, so its
 * structure is checked before anything is computed from it; what is wrong is
 * reported by path.
 */
export function parsePublishedStatement(json: string): PublishedStatement {
  let value: unknown;
  try {
    value = parseExact(json);
  } catch (e) {
    throw new PublishedStatementError([`not valid JSON: ${e instanceof Error ? e.message : String(e)}`]);
  }
  const version = typeof value === 'object' && value !== null ? (value as { version?: unknown }).version : undefined;
  if (version !== PUBLISHED_STATEMENT_VERSION) {
    const named = typeof version === 'number' || typeof version === 'string' ? JSON.stringify(version) : 'missing';
    throw new PublishedStatementError([`version ${named} is not supported; this reader understands version ${PUBLISHED_STATEMENT_VERSION}`]);
  }
  const faults: string[] = [];
  publishedShape(value, 'statement file', faults);
  if (faults.length > 0) throw new PublishedStatementError(faults);

  const published = value as PublishedStatement;
  // The file states its moment twice; a reader shown one and a check run on the other would be looking at different statements.
  if (published.generatedAt !== published.statement.asOf) {
    throw new PublishedStatementError(['statement file.generatedAt: differs from statement.asOf, the moment the figures are for']);
  }
  return published;
}
