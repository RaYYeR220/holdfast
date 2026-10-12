import { DEFAULT_POLICY, type Policy } from '@holdfast/core';
import type { OrgRecord } from '@holdfast/db';
import { FUNDING_WINDOW_HOURS } from '@holdfast/engine';
import { type AttestationList, type EntryProof, attestationList, entryProof } from '../attestations/service';
import { type DemoJournal, demoJournal } from '../demo/service';
import type { Deps } from '../deps';
import { ApiError } from '../errors';
import { AGENT_NAME } from '../hyperliquid/service';
import { type LockPreview, previewLock } from '../policy/service';
import { type Reading, reading } from '../reading';
import { type PositionDetail, type VenueIo, readAgents, readPosition } from './lock-venue';
import { type Outcome, outcomeOf } from './treasury-lock-reads';

/**
 * What the Lock page shows beside the overview's figures, for one
 * organisation: the policy, the position as the venue states it, what a lock
 * of the treasury as it is now would take, whether the venue shows the
 * service's agent approved, the journal a page at a time, the snapshots the
 * chain holds and the proof of one entry under one of them.
 *
 * The same reads serve the public demo and the owner. Nothing here is a key:
 * the agent is shown as its address and the policy as its numbers.
 */

type LockDeps = Pick<Deps, 'store' | 'hyperliquid' | 'attestor' | 'now' | 'redact' | 'report'>;

const HYPERLIQUID = 'hyperliquid';
const JOURNAL = 'journal';
const HYPEREVM = 'hyperevm';
/** Entries on one page of the journal. */
export const JOURNAL_PAGE = 20;

export interface AgentApproval {
  /** Whether the venue lists the organisation's agent key among the agents of its account. */
  approved: boolean;
  /** When that approval lapses, ms; null when the venue names no expiry or the key is not approved. */
  validUntil: number | null;
  /** Another agent that holds the name the service's agent is approved under; approving replaces it. */
  nameHeldBy: string | null;
}

export interface LockPage {
  /** The organisation's Hyperliquid account. */
  account: string;
  lockEnabled: boolean;
  policy: Policy;
  /** Whether the policy is the default one, which is the one the backtest grades. */
  policyIsDefault: boolean;
  /** The window the venue's funding rate is averaged over, hours. */
  fundingWindowHours: number;
  /** The ZEC position as the venue states it, read now; a null value when the account holds none. */
  position: Reading<PositionDetail | null>;
  /** What locking the treasury as it is now would take. Refused when there is nothing to lock. */
  preview: Outcome<LockPreview>;
  agent: {
    /** The service's agent key for this organisation; null when it has none. */
    address: string | null;
    /** The name it is approved under. */
    name: string;
    approval: Reading<AgentApproval>;
  };
}

const samePolicy = (a: Policy, b: Policy): boolean => (Object.keys(b) as (keyof Policy)[]).every((key) => a[key] === b[key]) && Object.keys(a).length === Object.keys(b).length;

/** The address of the organisation's agent key; null when it has none. */
async function agentAddressOf(deps: Pick<Deps, 'store'>, orgId: string): Promise<string | null> {
  return (await deps.store.listKeys(orgId)).find((key) => key.kind === 'hl_agent' && key.status === 'active')?.address ?? null;
}

/** Whether the venue shows the organisation's agent key approved on its account, read now. */
export async function agentApprovalOf(deps: Pick<Deps, 'store' | 'hyperliquid' | 'now' | 'redact'>, org: Pick<OrgRecord, 'id' | 'hlUser'>, io: Pick<VenueIo, 'fetch'> = {}, agentAddress?: string | null): Promise<Reading<AgentApproval>> {
  const venue: VenueIo = { network: deps.hyperliquid.network, ...io };
  return reading<AgentApproval>(HYPERLIQUID, deps, async () => {
    const address = agentAddress === undefined ? await agentAddressOf(deps, org.id) : agentAddress;
    if (address === null) throw new Error('the organisation has no Hyperliquid agent key');
    const agents = await readAgents(venue, org.hlUser);
    const mine = agents.find((agent) => agent.address === address.toLowerCase());
    const named = agents.find((agent) => agent.name === AGENT_NAME);
    return { approved: mine !== undefined, validUntil: mine?.validUntil ?? null, nameHeldBy: mine === undefined && named !== undefined ? named.address : null };
  });
}

/** The lock of one organisation as the page reads it. `fetch` replaces the network in tests. */
export async function lockPage(deps: LockDeps, org: OrgRecord, io: Pick<VenueIo, 'fetch'> = {}): Promise<LockPage> {
  const venue: VenueIo = { network: deps.hyperliquid.network, ...io };
  const agentAddress = await agentAddressOf(deps, org.id);

  const [position, preview, approval] = await Promise.all([
    reading(HYPERLIQUID, deps, () => readPosition(venue, org.hlUser)),
    outcomeOf(deps, HYPERLIQUID, () => previewLock(deps, org)),
    agentApprovalOf(deps, org, io, agentAddress),
  ]);

  return {
    account: org.hlUser,
    lockEnabled: org.lockEnabled,
    policy: org.policy,
    policyIsDefault: samePolicy(org.policy, DEFAULT_POLICY),
    fundingWindowHours: FUNDING_WINDOW_HOURS,
    position,
    preview,
    agent: { address: agentAddress, name: AGENT_NAME, approval },
  };
}

/** One page of the organisation's journal, newest first, with the chain check of that page. */
export async function journalPage(deps: LockDeps, org: OrgRecord, page: { beforeSeq?: number | undefined } = {}): Promise<Outcome<DemoJournal>> {
  return outcomeOf(deps, JOURNAL, () => demoJournal(deps, org, { limit: JOURNAL_PAGE, beforeSeq: page.beforeSeq }));
}

/** The latest snapshots the HedgeAttestor contract holds for the organisation, read from the chain now. */
export async function snapshotsOf(deps: LockDeps, org: OrgRecord): Promise<Outcome<AttestationList>> {
  return outcomeOf(deps, HYPEREVM, () => attestationList(deps, org));
}

export interface ProofRequest {
  series: bigint;
  number: bigint;
  /** The journal entry to prove. */
  seq: number;
}

/**
 * The proof that one journal entry is under the root a snapshot committed
 * to, with the contract's own verdict. A snapshot that does not exist and an
 * entry the snapshot does not cover are refusals, each with its reason.
 */
export async function proofOf(deps: LockDeps, org: OrgRecord, request: ProofRequest): Promise<Outcome<EntryProof>> {
  return outcomeOf(deps, HYPEREVM, async () => {
    try {
      return await entryProof(deps, org, request);
    } catch (error) {
      // The service says "not found" without saying what; here the reader named the snapshot and the entry themselves.
      if (error instanceof ApiError && error.code === 'not_found') {
        throw new ApiError(404, 'not_found', `the contract holds no snapshot ${request.number} in series ${request.series} for this account, or the journal has no entry ${request.seq}`);
      }
      throw error;
    }
  });
}
