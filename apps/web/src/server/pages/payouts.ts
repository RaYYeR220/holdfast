import type { OrgRecord, PayoutChain, PayoutStatus } from '@holdfast/db';
import { type KeyStatus, NETWORKS } from '@holdfast/tempo';
import type { Hex } from 'viem';
import { demoPayouts } from '../demo/service';
import type { Deps } from '../deps';
import { ApiError } from '../errors';
import { receiptOf, txUrlOf } from '../payouts/receipt';
import { type RunOnChain, type RunPreview, type RunView, listRuns, previewRun, runStatus } from '../payouts/service';
import { solanaRail, tempoRail } from '../rails/service';
import { type Reading, reading } from '../reading';
import { type SolanaReads, isMarkerSet, solanaAddressLinks } from './payouts-solana';

/**
 * What the Payouts pages and the receipt page show, put together from the
 * services behind the payout routes. Two readers are served: the owner of an
 * organisation, and anyone looking at a public demo, who is shown what the
 * public read model shows and no more: paid runs, without the names and
 * addresses of payees.
 */

export type Audience = 'owner' | 'public';

type PageDeps = Pick<Deps, 'store' | 'tempo' | 'solana' | 'now' | 'redact'>;

interface Token {
  address: string;
  symbol: string;
  decimals: number;
}

/** Where the addresses of a chain are looked at: an address goes between the two parts. */
export interface AddressLinks {
  before: string;
  after: string;
}

export function addressLinks(deps: Pick<Deps, 'tempo' | 'solana'>, chain: PayoutChain): AddressLinks {
  return chain === 'tempo' ? { before: `${NETWORKS[deps.tempo.network].explorer}/address/`, after: '' } : solanaAddressLinks(deps.solana.cluster);
}

/** Where a transaction of a chain is looked at, in the same two parts: its hash or signature goes between them. */
export function txLinks(deps: Pick<Deps, 'tempo' | 'solana'>, chain: PayoutChain): AddressLinks {
  const [before = '', after = ''] = txUrlOf(deps, chain, ' ').split(' ');
  return { before, after };
}

/** Where the service's Tempo access key stands on the organisation's account, as the Account Keychain reports it. */
export type TempoKeyShown =
  /** The organisation names no Tempo account, so there is no keychain to ask. */
  | { state: 'no_account' }
  | { state: 'unavailable'; source: string; reason: string; readAt: number }
  /** The keychain of the account does not know the key. */
  | { state: 'not_authorized'; readAt: number }
  | { state: 'revoked'; readAt: number }
  | { state: 'expired'; expiredAt: number; readAt: number }
  /** Live, but not bounded the way a payout key is; the rail does not pay with it. */
  | { state: 'broader'; problems: string[]; expiresAt: number | null; readAt: number }
  | {
      state: 'authorized';
      /** What the key may still spend in the current period, in token base units. */
      remaining: bigint;
      /** When the period ends and the limit refills; null for a limit that is given once. */
      periodEnd: number | null;
      /** Null for a key without an expiry. */
      expiresAt: number | null;
      /** The payees the key may pay; null when it may pay anyone. */
      recipients: string[] | null;
      readAt: number;
    };

/** One reading of the keychain as the state the page shows. */
export function tempoKeyShown(account: string | null, key: Reading<KeyStatus>): TempoKeyShown {
  if (account === null) return { state: 'no_account' };
  if (key.status !== 'ok') return { state: 'unavailable', source: key.source, reason: key.reason, readAt: key.readAt };
  const { value, readAt } = key;
  if (value.revoked) return { state: 'revoked', readAt };
  // A key the keychain does not know has no expiry to report; one it knows and that is not live any more has run out.
  if (!value.live) return value.expiresAt === null ? { state: 'not_authorized', readAt } : { state: 'expired', expiredAt: value.expiresAt, readAt };
  if (!value.authorized) return { state: 'broader', problems: value.mismatch, expiresAt: value.expiresAt, readAt };
  return { state: 'authorized', remaining: value.remaining, periodEnd: value.periodEnd, expiresAt: value.expiresAt, recipients: value.scope.recipients, readAt };
}

export interface TempoRailShown {
  network: string;
  chainId: number;
  token: Token;
  /** The organisation's Tempo account; null until its profile names one. */
  account: string | null;
  /** The service's access key, which the root of that account authorizes. */
  accessKey: string | null;
  /** The service's account that pays the fee of every payout; null when the organisation has no access key to pay with. */
  sponsor: Reading<string> | null;
  key: TempoKeyShown;
  links: AddressLinks;
}

export async function tempoRailShown(deps: PageDeps, org: OrgRecord): Promise<TempoRailShown> {
  const rail = await tempoRail(deps, org);
  const stored = await deps.store.activeKey(org.id, 'tempo_access');
  return {
    network: rail.network,
    chainId: rail.chainId,
    token: rail.token,
    account: rail.account,
    accessKey: rail.accessKey,
    sponsor: stored === null ? null : await reading('configuration', deps, async () => deps.tempo.rail(stored.secret as Hex).sponsorAddress),
    key: tempoKeyShown(rail.account, rail.key),
    links: addressLinks(deps, 'tempo'),
  };
}

/** What the service's Solana key may still move out of the team's token account. */
export type SolanaAllowanceShown =
  /** The organisation names no Solana wallet, so there is no token account to ask about. */
  | { state: 'no_wallet' }
  | { state: 'unavailable'; source: string; reason: string; readAt: number }
  /** The key may move nothing: it was never approved, the approval was revoked, or it is spent. */
  | { state: 'nothing'; readAt: number }
  | { state: 'approved'; remaining: bigint; readAt: number };

export function solanaAllowanceShown(owner: string | null, allowance: Reading<{ remaining: bigint }>): SolanaAllowanceShown {
  if (owner === null) return { state: 'no_wallet' };
  if (allowance.status !== 'ok') return { state: 'unavailable', source: allowance.source, reason: allowance.reason, readAt: allowance.readAt };
  return allowance.value.remaining > 0n ? { state: 'approved', remaining: allowance.value.remaining, readAt: allowance.readAt } : { state: 'nothing', readAt: allowance.readAt };
}

export interface SolanaRailShown {
  cluster: string;
  token: Token;
  /** The organisation's wallet; null until its profile names one. */
  owner: string | null;
  /** The wallet's token account for the payout token, which payouts leave from. */
  tokenAccount: string | null;
  /** The service key the wallet approves as delegate. */
  delegate: string | null;
  allowance: SolanaAllowanceShown;
  /** The SOL the service key holds for fees and rent, in lamports; null when the organisation has no service key. */
  delegateLamports: Reading<bigint> | null;
  links: AddressLinks;
}

export async function solanaRailShown(deps: PageDeps, org: OrgRecord, reads: SolanaReads): Promise<SolanaRailShown> {
  const rail = await solanaRail(deps, org);
  const { owner, delegate } = rail;
  const [tokenAccount, delegateLamports] = await Promise.all([
    // An address that is not one has no token account to derive; the allowance then says what is wrong with it.
    owner === null ? null : reads.tokenAccountOf(owner, rail.token.address).catch(() => null),
    delegate === null ? null : reading('solana', deps, () => reads.lamports(delegate)),
  ]);
  return {
    cluster: rail.cluster,
    token: rail.token,
    owner,
    tokenAccount,
    delegate,
    allowance: solanaAllowanceShown(owner, rail.allowance),
    delegateLamports,
    links: addressLinks(deps, 'solana'),
  };
}

export interface RunLineShown {
  lineNo: number;
  /** Null on the public page, which does not say who was paid. */
  payee: { name: string; address: string } | null;
  /** Token base units. */
  amount: bigint;
  /** What the transfer carries on chain. */
  memo: string;
  /** The payee's own reference; null on the public page. */
  reference: string | null;
  /** The token of the line's public receipt; there is a receipt behind it once the run is paid. */
  receiptToken: string | null;
}

export interface RunShown {
  id: string;
  chain: PayoutChain;
  /** Symbol and decimals are null on runs written before they were kept. */
  token: { address: string; symbol: string | null; decimals: number | null };
  status: PayoutStatus;
  /** Token base units. */
  total: bigint;
  tx: string | null;
  txUrl: string | null;
  /** Why the last attempt to pay did not end in a payment. */
  error: string | null;
  /** Null on the public page, which shows when a run was paid and not when it was drafted. */
  createdAt: number | null;
  paidAt: number | null;
  /** The account the run pays from; null on the public page. */
  account: string | null;
  lines: RunLineShown[];
}

function ownerRun(run: RunView): RunShown {
  return {
    id: run.id,
    chain: run.chain,
    token: { address: run.token, symbol: run.tokenSymbol, decimals: run.tokenDecimals },
    status: run.status,
    total: run.total,
    tx: run.tx,
    txUrl: run.txUrl,
    error: run.error,
    createdAt: run.createdAt,
    paidAt: run.executedAt,
    account: run.account,
    lines: run.lines.map((line) => ({
      lineNo: line.lineNo,
      payee: { name: line.payeeName, address: line.toAddress },
      amount: line.amount,
      memo: line.memo,
      reference: line.reference,
      receiptToken: line.receiptToken,
    })),
  };
}

/** The runs a page lists, newest first: every run for the owner, the paid ones for the public. */
export async function payoutRunsShown(deps: PageDeps, org: OrgRecord, audience: Audience): Promise<RunShown[]> {
  if (audience === 'owner') return (await listRuns(deps, org.id)).map(ownerRun);
  const { payouts } = await demoPayouts(deps, org);
  if (payouts.status !== 'ok') return [];
  return payouts.value.map((run) => ({
    id: run.id,
    chain: run.chain,
    token: run.token,
    status: 'paid',
    total: run.total,
    tx: run.tx,
    txUrl: run.txUrl,
    error: null,
    createdAt: null,
    paidAt: run.paidAt,
    account: null,
    lines: run.lines.map((line) => ({ lineNo: line.lineNo, payee: null, amount: line.amount, memo: line.memo, reference: null, receiptToken: line.receiptToken })),
  }));
}

export interface RunMarkerShown {
  address: string;
  /** The service key the marker is derived from. */
  delegate: string;
  /** False when that key is one the organisation paid with before its present one. */
  presentKey: boolean;
  /** Whether the chain holds the marker: a System account at that address that carries data. */
  set: boolean;
}

/**
 * The marker of a Solana run as the chain has it now. A run is marked under
 * the service key that paid it, so the present key is looked at first and
 * then the earlier ones; when none of them holds a marker, the answer is the
 * present key's address, not set.
 */
async function runMarkerShown(deps: PageDeps, org: OrgRecord, run: { id: string; account: string; mint: string }, reads: SolanaReads): Promise<RunMarkerShown | null> {
  const keys = (await deps.store.listKeys(org.id)).filter((key) => key.kind === 'solana_delegate');
  const ordered = [...keys.filter((key) => key.status === 'active'), ...keys.filter((key) => key.status !== 'active')];
  let first: RunMarkerShown | null = null;
  for (const key of ordered) {
    const address = await reads.markerOf({ delegate: key.address, owner: run.account, mint: run.mint, runId: run.id });
    const set = isMarkerSet(await reads.account(address));
    const shown: RunMarkerShown = { address, delegate: key.address, presentKey: key.status === 'active', set };
    if (set) return shown;
    first ??= shown;
  }
  return first;
}

export interface RunPageShown {
  run: RunShown;
  /** What the run's chain holds under its id now. Null for a draft, which was never sent, and on the public page, which shows the record. */
  onChain: Reading<RunOnChain | null> | null;
  /** What executing would do now, for a run of the owner's that is not paid; null otherwise. */
  preview: Reading<RunPreview> | null;
  /** A Solana run's marker; a null value when the organisation has no service key to derive one from. Null for a Tempo run. */
  marker: Reading<RunMarkerShown | null> | null;
  /** Where the addresses of the run's chain are looked at. */
  links: AddressLinks;
  /** Where its transactions are looked at. */
  txLinks: AddressLinks;
}

const RUN_ID = /^HF-\d{4}-\d{2}-\d{4}$/;

/**
 * One run for its page, or null when the reader has no such run. For the
 * owner this is what `GET /payouts/[runId]` answers, and like that route it
 * records a run as paid when the chain shows its lines under its id.
 */
export async function payoutRunShown(deps: PageDeps, org: OrgRecord, runId: string, audience: Audience, reads: SolanaReads): Promise<RunPageShown | null> {
  if (!RUN_ID.test(runId)) return null;

  let run: RunShown;
  let onChain: RunPageShown['onChain'] = null;
  let preview: RunPageShown['preview'] = null;
  if (audience === 'owner') {
    let status: Awaited<ReturnType<typeof runStatus>>;
    try {
      status = await runStatus(deps, org, runId);
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return null;
      throw error;
    }
    run = ownerRun(status.run);
    onChain = status.onChain;
    if (run.status !== 'paid') preview = await reading(run.chain, deps, () => previewRun(deps, org, runId));
  } else {
    const found = (await payoutRunsShown(deps, org, 'public')).find((candidate) => candidate.id === runId);
    if (found === undefined) return null;
    run = found;
  }

  let marker: RunPageShown['marker'] = null;
  if (run.chain === 'solana') {
    // The public page does not carry the wallet with the run; the organisation's profile names it.
    const account = run.account ?? org.solanaOwner;
    marker = await reading('solana', deps, async () => (account === null ? null : runMarkerShown(deps, org, { id: run.id, account, mint: run.token.address }, reads)));
  }
  return { run, onChain, preview, marker, links: addressLinks(deps, run.chain), txLinks: txLinks(deps, run.chain) };
}

export interface ReceiptShown {
  /** The name of the organisation that paid. */
  organisation: string;
  chain: PayoutChain;
  /** The network the payment is on, as the deployment names it: a Tempo network or a Solana cluster. */
  network: string;
  token: { address: string; symbol: string | null; decimals: number | null };
  /** Token base units. */
  amount: bigint;
  /** The address that was paid. */
  to: string;
  /** What the transfer carries on chain. */
  memo: string;
  /** The payee's own reference, such as an invoice number; empty when the run gave none. */
  reference: string;
  /** When the payment was confirmed. */
  paidAt: number | null;
  tx: string;
  txUrl: string;
  /** Where the addresses of the payment's chain are looked at. */
  links: AddressLinks;
}

/**
 * What the receipt page shows for a receipt token, or null when there is no
 * receipt behind it. Whether there is one is what `GET /api/receipts/[token]`
 * says; this adds who paid, whom, when and under which reference, for the
 * payee the link was sent to. Nothing else about the organisation is read.
 */
export async function receiptShown(deps: Pick<Deps, 'store' | 'tempo' | 'solana'>, token: string): Promise<ReceiptShown | null> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  let receipt: Awaited<ReturnType<typeof receiptOf>>;
  try {
    receipt = await receiptOf(deps, token);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
  const found = await deps.store.findReceipt(token);
  const org = found === null ? null : await deps.store.findOrg(found.run.orgId);
  if (found === null || org === null) return null;
  return {
    organisation: org.name,
    chain: receipt.chain,
    network: receipt.chain === 'tempo' ? deps.tempo.network : deps.solana.cluster,
    token: receipt.token,
    amount: receipt.amount,
    to: found.line.toAddress,
    memo: receipt.memo,
    reference: found.line.reference,
    paidAt: found.run.executedAt,
    tx: receipt.tx,
    txUrl: receipt.txUrl,
    links: addressLinks(deps, receipt.chain),
  };
}
