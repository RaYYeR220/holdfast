import type { AuditScope } from '@holdfast/books';
import type { Policy } from '@holdfast/core';
import type { PayoutChain } from '@holdfast/db';
import type { attestationList, attestorOf, entryProof, openCommitment, ownerAttestations } from '../server/attestations/service';
import type { Session } from '../server/auth/session';
import type { issueNonce } from '../server/auth/sign-in';
import type { scorecardOf, seriesOf } from '../server/backtest/service';
import type { auditView, createLink, listLinks, revokeLink } from '../server/books/audit-links';
import type { Books, reconciliationOf, statementOf } from '../server/books/service';
import type { demoBooks, demoJournal, demoList, demoOverview, demoPayouts, demoReceipts, demoSafety } from '../server/demo/service';
import type { FundingPurpose, listSwaps, quoteFunding, swapStatus } from '../server/funding/service';
import type { approvalRequest, submitApproval, venueState } from '../server/hyperliquid/service';
import type { NewOrganisation, OrganisationProfile, createOrganisation, listOrganisations, readOrganisation, updateOrganisation } from '../server/orgs/service';
import type { receiptOf } from '../server/payouts/receipt';
import type { createRun, executeRun, listRuns, previewRun, runStatus } from '../server/payouts/service';
import type { currentAdvisories, previewLock, replacePolicy, setLock } from '../server/policy/service';
import type { solanaApproval, solanaRail, solanaRevoke, submitTempoAuthorization, tempoAuthorizationRequest, tempoRail } from '../server/rails/service';
import type { ProbeKind, listRefusals, runProbe, safetyOf } from '../server/safety/service';
import type { runTick } from '../server/tick/service';
import { ClientError } from './errors';

export { ClientError, isClientError, isNotFound, isUnauthenticated } from './errors';

/**
 * A value of the server as it arrives here. The API writes every amount in
 * base units as a decimal string, because a JSON number cannot carry one
 * exactly; everything else arrives as it is.
 */
export type Wire<T> = T extends bigint ? string : T extends string | number | boolean | null | undefined ? T : T extends object ? { [K in keyof T]: Wire<T[K]> } : T;

/** What a service function of the server answers with, as it arrives here. */
type Answer<F extends (...args: never[]) => unknown> = Wire<Awaited<ReturnType<F>>>;

export type SignInChallenge = Answer<typeof issueNonce> & { domain: string; version: '1'; statement: string };
export type SessionInfo = Pick<Session, 'address' | 'expiresAt'>;
export type OrganisationSummary = Answer<typeof listOrganisations>[number];
export type Me = SessionInfo & { orgs: OrganisationSummary[] };
export type Organisation = Answer<typeof readOrganisation>;
export type PolicyState = Answer<typeof replacePolicy>;
export type LockPreview = Answer<typeof previewLock>;
export type Advisories = Answer<typeof currentAdvisories>;
export type HyperliquidApprovalRequest = Answer<typeof approvalRequest>;
export type HyperliquidApproval = Answer<typeof submitApproval>;
export type HyperliquidState = Answer<typeof venueState>;
export type TempoRail = Answer<typeof tempoRail>;
export type TempoAuthorizationRequest = Answer<typeof tempoAuthorizationRequest>;
export type TempoAuthorization = Answer<typeof submitTempoAuthorization>;
export type SolanaRail = Answer<typeof solanaRail>;
export type SolanaApproval = Answer<typeof solanaApproval>;
export type SolanaRevoke = Answer<typeof solanaRevoke>;
export type FundingQuote = Answer<typeof quoteFunding>;
export type Swap = Answer<typeof swapStatus>;
export type PayoutRun = Answer<typeof createRun>;
export type PayoutStatus = Answer<typeof runStatus>;
export type PayoutPreview = Answer<typeof previewRun>;
export type PayoutExecution = Answer<typeof executeRun>;
export type Statement = { statement: Answer<typeof statementOf>; ledger: Wire<Books['ledger']> };
export type Reconciliation = Answer<typeof reconciliationOf>;
export type AuditLink = Answer<typeof revokeLink>;
export type NewAuditLink = Answer<typeof createLink>;
export type AuditStatement = Answer<typeof auditView>;
export type Safety = Answer<typeof safetyOf>;
export type Refusal = Answer<typeof listRefusals>[number];
export type ProbeOutcome = Answer<typeof runProbe>;
export type Attestor = Answer<typeof attestorOf>;
export type Attestations = Answer<typeof ownerAttestations>;
export type OpenedCommitment = Answer<typeof openCommitment>;
export type DemoAttestations = Answer<typeof attestationList>;
export type EntryProof = Answer<typeof entryProof>;
export type DemoOrganisation = Answer<typeof demoList>[number];
export type DemoOverview = Answer<typeof demoOverview>;
export type DemoJournal = Answer<typeof demoJournal>;
export type DemoReceipts = Answer<typeof demoReceipts>;
export type DemoPayouts = Answer<typeof demoPayouts>;
export type DemoSafety = Answer<typeof demoSafety>;
export type DemoBooks = Answer<typeof demoBooks>;
export type Scorecard = Answer<typeof scorecardOf>;
export type BacktestSeries = Answer<typeof seriesOf>;
export type Receipt = Answer<typeof receiptOf>;
export type TickReport = Answer<typeof runTick>;

export type { FundingPurpose, NewOrganisation, OrganisationProfile, PayoutChain, Policy, ProbeKind };

/** The bounds of a Tempo access key. `limit` is in token base units; `expiry` is in unix seconds. */
export interface TempoTermsInput {
  limit: bigint;
  /** Length of the spending window; 0 makes the limit a one-off. */
  periodSeconds: number;
  expiry: number;
  /** Payees the key may pay; left out, it may pay anyone. */
  recipients?: readonly string[];
}

export interface FundingQuoteInput {
  purpose: FundingPurpose;
  amountZat: bigint;
  /** A transparent Zcash address of the treasurer's, where the ZEC returns if the swap cannot complete. */
  refundTo: string;
  slippageBps?: number;
  /** Price the swap without creating a deposit address or recording anything. */
  dry?: boolean;
}

export interface PayoutLineInput {
  payee: { name: string; address: string };
  /** Token base units. */
  amount: bigint;
  /** The payee's own reference, such as an invoice number. */
  reference?: string;
}

export interface AuditLinkInput {
  label: string;
  scope: { from: number | null; to: number | null; modules: AuditScope['modules'] };
  expiresAt?: number | null;
}

export interface DateRangeInput {
  /** Milliseconds; either end may be left open. */
  from?: number;
  to?: number;
}

/** One snapshot the HedgeAttestor contract holds: the series and the number in it, both counted from zero. */
export interface SnapshotRef {
  /** As a bigint, or as the decimal digits the server writes it with. */
  series: bigint | string;
  number: bigint | string;
}

export interface ApiOptions {
  /** Used in place of the global `fetch`. */
  fetch?: typeof fetch;
  /** Put before every path. Empty in the browser, where requests go to the page's own origin. */
  baseUrl?: string;
}

export interface CallOptions {
  signal?: AbortSignal;
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
type Query = Record<string, string | number | undefined>;

interface Call extends CallOptions {
  query?: Query;
  /** The JSON body of a state-changing request; one without a body sends `{}`. */
  body?: unknown;
  /** Sent as `Authorization: Bearer`, without the session cookie. */
  bearer?: string;
}

const JSON_TYPE = /^application\/json\s*(;|$)/i;

/** A body as the API reads it: amounts in base units written as decimal strings. */
function toWire(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => (typeof v === 'bigint' ? v.toString() : v));
}

function queryString(query: Query | undefined): string {
  const pairs = Object.entries(query ?? {}).filter((pair): pair is [string, string | number] => pair[1] !== undefined);
  return pairs.length === 0 ? '' : `?${pairs.map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(String(value))}`).join('&')}`;
}

const segment = (value: string): string => encodeURIComponent(value);
const orgPath = (orgId: string, rest = ''): string => `/api/orgs/${segment(orgId)}${rest}`;
const demoPath = (orgId: string, rest: string): string => `/api/demo/${segment(orgId)}${rest}`;
const snapshotPath = (snapshot: SnapshotRef): string => `/attestations/${segment(String(snapshot.series))}/${segment(String(snapshot.number))}`;

/** The server's refusal as an error: its code and message, and the rest of its answer as details. */
async function refusalOf(response: Response): Promise<ClientError> {
  const text = await response.text().catch(() => '');
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
    const { error, message, ...details } = parsed as Record<string, unknown>;
    if (typeof error === 'string' && typeof message === 'string') return new ClientError(error, message, { status: response.status, details });
  }
  return new ClientError('bad_response', `the server answered HTTP ${response.status} without saying why`, { status: response.status });
}

/**
 * The API of the application, one function for each operation of each route
 * under `/api`. Every function resolves with the server's answer or rejects
 * with a `ClientError`.
 *
 * A request is made once. Nothing is sent again on a failure: a state-changing
 * call whose answer was lost may have taken effect, and only the caller can
 * decide what to do about that.
 */
export function createApi(options: ApiOptions = {}) {
  const baseUrl = options.baseUrl ?? '';

  async function send(method: Method, path: string, call: Call): Promise<Response> {
    const changesState = method !== 'GET';
    const headers: Record<string, string> = { accept: 'application/json' };
    // The server reads the body of every state-changing request, and reads it only as JSON.
    if (changesState) headers['content-type'] = 'application/json';
    if (call.bearer !== undefined) headers.authorization = `Bearer ${call.bearer}`;

    const doFetch = options.fetch ?? globalThis.fetch;
    let response: Response;
    try {
      response = await doFetch(`${baseUrl}${path}${queryString(call.query)}`, {
        method,
        headers,
        // The session is a cookie of this origin and goes nowhere else.
        credentials: call.bearer === undefined ? 'same-origin' : 'omit',
        cache: 'no-store',
        ...(changesState ? { body: toWire(call.body ?? {}) } : {}),
        ...(call.signal === undefined ? {} : { signal: call.signal }),
      });
    } catch (error) {
      if (call.signal?.aborted === true) throw new ClientError('aborted', 'the request was given up', { cause: error });
      throw new ClientError('network', 'the server could not be reached', { cause: error });
    }
    if (!response.ok) throw await refusalOf(response);
    return response;
  }

  async function json<T>(method: Method, path: string, call: Call = {}): Promise<T> {
    const response = await send(method, path, call);
    if (!JSON_TYPE.test(response.headers.get('content-type') ?? '')) {
      throw new ClientError('bad_response', 'the server answered with something other than JSON', { status: response.status });
    }
    try {
      return (await response.json()) as T;
    } catch (error) {
      throw new ClientError('bad_response', 'the server answered with JSON that cannot be read', { status: response.status, cause: error });
    }
  }

  /** The body of an answer that is a file: a CSV ledger or the published statement. */
  async function text(path: string, call: Call = {}): Promise<string> {
    const response = await send('GET', path, call);
    try {
      return await response.text();
    } catch (error) {
      throw new ClientError('bad_response', 'the answer of the server could not be read', { status: response.status, cause: error });
    }
  }

  const range = (r: DateRangeInput | undefined): Query => ({ from: r?.from, to: r?.to });

  return {
    // Signing in.

    /** GET /api/auth/nonce: a challenge for a sign-in message, and what the message has to say. */
    nonce: (call?: CallOptions) => json<SignInChallenge>('GET', '/api/auth/nonce', call),
    /** POST /api/auth/verify: checks a signed sign-in message; the answer sets the session cookie. */
    verify: (body: { message: string; signature: string }, call?: CallOptions) => json<SessionInfo>('POST', '/api/auth/verify', { ...call, body }),
    /** POST /api/auth/logout: has the browser drop the session cookie. */
    logout: (call?: CallOptions) => json<{ ok: true }>('POST', '/api/auth/logout', call),
    /** GET /api/auth/me: who is signed in and the organisations that address owns; 401 when nobody is. */
    me: (call?: CallOptions) => json<Me>('GET', '/api/auth/me', call),

    // Organisations.

    /** GET /api/orgs */
    listOrgs: (call?: CallOptions) => json<{ orgs: OrganisationSummary[] }>('GET', '/api/orgs', call),
    /** POST /api/orgs: registers an organisation owned by the signed-in address. */
    createOrg: (body: NewOrganisation, call?: CallOptions) => json<Answer<typeof createOrganisation>>('POST', '/api/orgs', { ...call, body }),
    /** GET /api/orgs/[orgId] */
    getOrg: (orgId: string, call?: CallOptions) => json<Organisation>('GET', orgPath(orgId), call),
    /** PATCH /api/orgs/[orgId]: fields left out stay as they are; null clears. */
    updateOrg: (orgId: string, body: OrganisationProfile, call?: CallOptions) => json<Answer<typeof updateOrganisation>>('PATCH', orgPath(orgId), { ...call, body }),

    // The policy and the lock.

    /** GET /api/orgs/[orgId]/policy */
    getPolicy: (orgId: string, call?: CallOptions) => json<PolicyState>('GET', orgPath(orgId, '/policy'), call),
    /** PUT /api/orgs/[orgId]/policy: the whole policy, which has to pass validation as it stands. */
    putPolicy: (orgId: string, policy: Policy, call?: CallOptions) => json<PolicyState>('PUT', orgPath(orgId, '/policy'), { ...call, body: policy }),
    /** PUT /api/orgs/[orgId]/lock */
    setLock: (orgId: string, enabled: boolean, call?: CallOptions) => json<Answer<typeof setLock>>('PUT', orgPath(orgId, '/lock'), { ...call, body: { enabled } }),
    /** GET /api/orgs/[orgId]/lock/preview?swapCostBps= */
    lockPreview: (orgId: string, input: { swapCostBps?: number } = {}, call?: CallOptions) => json<LockPreview>('GET', orgPath(orgId, '/lock/preview'), { ...call, query: { swapCostBps: input.swapCostBps } }),
    /** GET /api/orgs/[orgId]/advisories */
    advisories: (orgId: string, call?: CallOptions) => json<Advisories>('GET', orgPath(orgId, '/advisories'), call),

    // Hyperliquid.

    /** GET /api/orgs/[orgId]/hyperliquid/approval?chainId=&validUntil=: the typed data that approves the organisation's agent. */
    hyperliquidApproval: (orgId: string, input: { chainId?: number; validUntil?: number } = {}, call?: CallOptions) =>
      json<HyperliquidApprovalRequest>('GET', orgPath(orgId, '/hyperliquid/approval'), { ...call, query: { chainId: input.chainId, validUntil: input.validUntil } }),
    /** POST /api/orgs/[orgId]/hyperliquid/approval: submits the owner's signature over that typed data. */
    submitHyperliquidApproval: (orgId: string, body: { nonce: number; signature: string; signatureChainId?: number; validUntil?: number }, call?: CallOptions) =>
      json<HyperliquidApproval>('POST', orgPath(orgId, '/hyperliquid/approval'), { ...call, body }),
    /** GET /api/orgs/[orgId]/hyperliquid/state */
    hyperliquidState: (orgId: string, call?: CallOptions) => json<HyperliquidState>('GET', orgPath(orgId, '/hyperliquid/state'), call),

    // The payout rails.

    /** GET /api/orgs/[orgId]/rails/tempo */
    tempoRail: (orgId: string, call?: CallOptions) => json<TempoRail>('GET', orgPath(orgId, '/rails/tempo'), call),
    /** POST /api/orgs/[orgId]/rails/tempo/authorization: what the root of the Tempo account signs. Changes nothing. */
    tempoAuthorization: (orgId: string, terms: TempoTermsInput, call?: CallOptions) => json<TempoAuthorizationRequest>('POST', orgPath(orgId, '/rails/tempo/authorization'), { ...call, body: terms }),
    /** POST /api/orgs/[orgId]/rails/tempo/authorization/submit: the root's signature, or the authorization signed and serialized. */
    submitTempoAuthorization: (orgId: string, body: { terms: TempoTermsInput } & ({ signature: string } | { signedWire: string }), call?: CallOptions) =>
      json<TempoAuthorization>('POST', orgPath(orgId, '/rails/tempo/authorization/submit'), { ...call, body }),
    /** GET /api/orgs/[orgId]/rails/solana */
    solanaRail: (orgId: string, call?: CallOptions) => json<SolanaRail>('GET', orgPath(orgId, '/rails/solana'), call),
    /** POST /api/orgs/[orgId]/rails/solana/approval: the unsigned approval for the owner's wallet. Changes nothing. */
    solanaApproval: (orgId: string, amount: bigint, call?: CallOptions) => json<SolanaApproval>('POST', orgPath(orgId, '/rails/solana/approval'), { ...call, body: { amount } }),
    /** POST /api/orgs/[orgId]/rails/solana/revoke: the unsigned revocation for the owner's wallet. Changes nothing. */
    solanaRevoke: (orgId: string, call?: CallOptions) => json<SolanaRevoke>('POST', orgPath(orgId, '/rails/solana/revoke'), call),

    // Funding.

    /** POST /api/orgs/[orgId]/funding/quotes: quotes ZEC into dollars for one of the organisation's own accounts. */
    quoteFunding: (orgId: string, body: FundingQuoteInput, call?: CallOptions) => json<FundingQuote>('POST', orgPath(orgId, '/funding/quotes'), { ...call, body }),
    /** GET /api/orgs/[orgId]/funding/swaps */
    listSwaps: (orgId: string, call?: CallOptions) => json<{ swaps: Answer<typeof listSwaps> }>('GET', orgPath(orgId, '/funding/swaps'), call),
    /** GET /api/orgs/[orgId]/funding/swaps/[swapId]: asks the swap service where the swap stands. */
    getSwap: (orgId: string, swapId: string, call?: CallOptions) => json<Swap>('GET', orgPath(orgId, `/funding/swaps/${segment(swapId)}`), call),

    // Payouts.

    /** GET /api/orgs/[orgId]/payouts */
    listPayouts: (orgId: string, call?: CallOptions) => json<{ runs: Answer<typeof listRuns> }>('GET', orgPath(orgId, '/payouts'), call),
    /** POST /api/orgs/[orgId]/payouts: a draft run. */
    createPayout: (orgId: string, body: { chain: PayoutChain; lines: readonly PayoutLineInput[] }, call?: CallOptions) => json<PayoutRun>('POST', orgPath(orgId, '/payouts'), { ...call, body }),
    /** GET /api/orgs/[orgId]/payouts/[runId]: the run beside what its chain shows now. */
    getPayout: (orgId: string, runId: string, call?: CallOptions) => json<PayoutStatus>('GET', orgPath(orgId, `/payouts/${segment(runId)}`), call),
    /** GET /api/orgs/[orgId]/payouts/[runId]/preview: what executing would do, without sending. */
    previewPayout: (orgId: string, runId: string, call?: CallOptions) => json<PayoutPreview>('GET', orgPath(orgId, `/payouts/${segment(runId)}/preview`), call),
    /** POST /api/orgs/[orgId]/payouts/[runId]/execute: pays the run through its rail. The server makes it safe to repeat. */
    executePayout: (orgId: string, runId: string, call?: CallOptions) => json<PayoutExecution>('POST', orgPath(orgId, `/payouts/${segment(runId)}/execute`), call),

    // The books.

    /** GET /api/orgs/[orgId]/books/statement?from=&to=: the statement as of now and the ledger entries of the period. */
    statement: (orgId: string, input?: DateRangeInput, call?: CallOptions) => json<Statement>('GET', orgPath(orgId, '/books/statement'), { ...call, query: range(input) }),
    /** GET /api/orgs/[orgId]/books/statement?format=csv: the ledger of the period as CSV text. */
    statementCsv: (orgId: string, input?: DateRangeInput, call?: CallOptions) => text(orgPath(orgId, '/books/statement'), { ...call, query: { ...range(input), format: 'csv' } }),
    /** GET /api/orgs/[orgId]/books/reconciliation */
    reconciliation: (orgId: string, call?: CallOptions) => json<Reconciliation>('GET', orgPath(orgId, '/books/reconciliation'), call),
    /** GET /api/orgs/[orgId]/books/export: the published statement, as the JSON text `holdfast verify` reads. */
    exportStatement: (orgId: string, call?: CallOptions) => text(orgPath(orgId, '/books/export'), call),
    /** GET /api/orgs/[orgId]/books/export?format=csv: the whole ledger as CSV text. */
    exportLedgerCsv: (orgId: string, call?: CallOptions) => text(orgPath(orgId, '/books/export'), { ...call, query: { format: 'csv' } }),
    /** GET /api/orgs/[orgId]/audit-links */
    auditLinks: (orgId: string, call?: CallOptions) => json<{ links: Answer<typeof listLinks> }>('GET', orgPath(orgId, '/audit-links'), call),
    /** POST /api/orgs/[orgId]/audit-links: the answer holds the link's token, which is shown this once. */
    createAuditLink: (orgId: string, body: AuditLinkInput, call?: CallOptions) => json<NewAuditLink>('POST', orgPath(orgId, '/audit-links'), { ...call, body }),
    /** DELETE /api/orgs/[orgId]/audit-links/[linkId]: the link stops working from this moment. */
    revokeAuditLink: (orgId: string, linkId: string, call?: CallOptions) => json<{ link: AuditLink }>('DELETE', orgPath(orgId, `/audit-links/${segment(linkId)}`), call),
    /** GET /api/audit/[token]: the scoped statement behind an auditor link. No session is asked for. */
    audit: (token: string, call?: CallOptions) => json<AuditStatement>('GET', `/api/audit/${segment(token)}`, call),
    /** GET /api/audit/[token]?format=csv: the scoped ledger as CSV text. */
    auditCsv: (token: string, call?: CallOptions) => text(`/api/audit/${segment(token)}`, { ...call, query: { format: 'csv' } }),

    // Safety.

    /** GET /api/orgs/[orgId]/safety: each key's scope as its chain reports it now, and the refusals on record. */
    safety: (orgId: string, call?: CallOptions) => json<Safety>('GET', orgPath(orgId, '/safety'), call),
    /** GET /api/orgs/[orgId]/safety/refusals */
    refusals: (orgId: string, call?: CallOptions) => json<{ refusals: Refusal[] }>('GET', orgPath(orgId, '/safety/refusals'), call),
    /** POST /api/orgs/[orgId]/safety/probes: sends something the key's chain or venue must refuse and records the refusal. */
    runProbe: (orgId: string, kind: ProbeKind, call?: CallOptions) => json<ProbeOutcome>('POST', orgPath(orgId, '/safety/probes'), { ...call, body: { kind } }),

    // Attestations of the hedge.

    /** GET /api/orgs/[orgId]/attestor: the attester key, the contract, the two calls for the owner's wallet, and what the chain shows now. */
    attestor: (orgId: string, call?: CallOptions) => json<Attestor>('GET', orgPath(orgId, '/attestor'), call),
    /** GET /api/orgs/[orgId]/attestations: the latest snapshots as the chain holds them, and what the service sent or tried. */
    attestations: (orgId: string, call?: CallOptions) => json<Attestations>('GET', orgPath(orgId, '/attestations'), call),
    /** POST /api/orgs/[orgId]/attestations/[series]/[number]/open: the balance and the salt behind the treasury commitment of one snapshot. */
    openAttestation: (orgId: string, snapshot: SnapshotRef, call?: CallOptions) => json<OpenedCommitment>('POST', orgPath(orgId, `${snapshotPath(snapshot)}/open`), call),

    // What anyone may read.

    /** GET /api/demo/[orgId]/attestations */
    demoAttestations: (orgId: string, call?: CallOptions) => json<DemoAttestations>('GET', demoPath(orgId, '/attestations'), call),
    /** GET /api/demo/[orgId]/attestations/[series]/[number]/proof?seq=: the proof that a journal entry is under the root a snapshot committed to. */
    demoEntryProof: (orgId: string, entry: SnapshotRef & { seq: number }, call?: CallOptions) => json<EntryProof>('GET', demoPath(orgId, `${snapshotPath(entry)}/proof`), { ...call, query: { seq: entry.seq } }),
    /** GET /api/demo */
    demoList: (call?: CallOptions) => json<{ orgs: DemoOrganisation[] }>('GET', '/api/demo', call),
    /** GET /api/demo/[orgId]/overview */
    demoOverview: (orgId: string, call?: CallOptions) => json<DemoOverview>('GET', demoPath(orgId, '/overview'), call),
    /** GET /api/demo/[orgId]/journal?limit=&beforeSeq= */
    demoJournal: (orgId: string, page: { limit?: number; beforeSeq?: number } = {}, call?: CallOptions) =>
      json<DemoJournal>('GET', demoPath(orgId, '/journal'), { ...call, query: { limit: page.limit, beforeSeq: page.beforeSeq } }),
    /** GET /api/demo/[orgId]/receipts */
    demoReceipts: (orgId: string, call?: CallOptions) => json<DemoReceipts>('GET', demoPath(orgId, '/receipts'), call),
    /** GET /api/demo/[orgId]/payouts */
    demoPayouts: (orgId: string, call?: CallOptions) => json<DemoPayouts>('GET', demoPath(orgId, '/payouts'), call),
    /** GET /api/demo/[orgId]/safety */
    demoSafety: (orgId: string, call?: CallOptions) => json<DemoSafety>('GET', demoPath(orgId, '/safety'), call),
    /** GET /api/demo/[orgId]/books */
    demoBooks: (orgId: string, call?: CallOptions) => json<DemoBooks>('GET', demoPath(orgId, '/books'), call),
    /** GET /api/backtest/scorecard */
    scorecard: (call?: CallOptions) => json<Scorecard>('GET', '/api/backtest/scorecard', call),
    /** GET /api/backtest/series?scenario= */
    series: (scenario: string, call?: CallOptions) => json<BacktestSeries>('GET', '/api/backtest/series', { ...call, query: { scenario } }),
    /** GET /api/receipts/[token]: one paid payout line, for whoever holds its token. */
    receipt: (token: string, call?: CallOptions) => json<Receipt>('GET', `/api/receipts/${segment(token)}`, call),

    // The scheduler.

    /**
     * POST /api/tick with the tick secret as a bearer token and no cookie.
     * It is the scheduler's call. No page holds the secret, and none calls this.
     */
    tick: (secret: string, call?: CallOptions) => json<TickReport>('POST', '/api/tick', { ...call, bearer: secret }),
  };
}

export type Api = ReturnType<typeof createApi>;

/** The API of the origin the page was loaded from. */
export const api: Api = createApi();

/**
 * Where the answers that are files can be fetched from by a link, so that the
 * browser saves them under the name the server gives them.
 */
export const downloads = {
  statementCsv: (orgId: string, input: DateRangeInput = {}): string => `${orgPath(orgId, '/books/statement')}${queryString({ from: input.from, to: input.to, format: 'csv' })}`,
  publishedStatement: (orgId: string): string => orgPath(orgId, '/books/export'),
  ledgerCsv: (orgId: string): string => `${orgPath(orgId, '/books/export')}?format=csv`,
  auditCsv: (token: string): string => `/api/audit/${segment(token)}?format=csv`,
};
