import { marginRatio } from '@holdfast/core';
import type { OrgRecord } from '@holdfast/db';
import type { TypedData } from '@holdfast/hyperliquid';
import type { ApprovalTerms, Deps } from '../deps';
import { invalid, refused, unavailable } from '../errors';
import { type VenueReading, venueReading } from '../live';
import { messageOf } from '../redact';

/** The name the agent is approved under. Approving it again replaces the agent that held the name. */
export const AGENT_NAME = 'holdfast';
const VENUE = 'Hyperliquid';

export interface ApprovalOptions {
  /** Chain id of the chain the signing wallet is connected to; Arbitrum unless given. */
  signatureChainId?: number | undefined;
  /** When the approval lapses, ms; Hyperliquid allows at most 180 days ahead. */
  validUntil?: number | undefined;
}

export interface ApprovalRequest {
  agentAddress: string;
  agentName: string;
  /** Send this back with the signature: it is part of what was signed. */
  nonce: number;
  signatureChainId: number | null;
  validUntil: number | null;
  /** EIP-712 data for the owner's wallet to sign. */
  typedData: TypedData;
}

async function termsOf(deps: Pick<Deps, 'store'>, org: OrgRecord, nonce: number, options: ApprovalOptions): Promise<ApprovalTerms> {
  const agent = await deps.store.activeKey(org.id, 'hl_agent');
  if (agent === null) throw refused('the organisation has no Hyperliquid agent key');
  return {
    agentAddress: agent.address,
    agentName: AGENT_NAME,
    nonce,
    ...(options.signatureChainId === undefined ? {} : { signatureChainId: options.signatureChainId }),
    ...(options.validUntil === undefined ? {} : { validUntil: options.validUntil }),
  };
}

/**
 * What the owner signs to let the organisation's agent key trade its
 * account. The agent can place and cancel orders; it cannot withdraw.
 */
export async function approvalRequest(deps: Pick<Deps, 'store' | 'hyperliquid' | 'now'>, org: OrgRecord, options: ApprovalOptions): Promise<ApprovalRequest> {
  const terms = await termsOf(deps, org, deps.now(), options);
  let typedData: TypedData;
  try {
    typedData = deps.hyperliquid.approvalRequest(terms).typedData;
  } catch (error) {
    throw invalid(messageOf(error));
  }
  return {
    agentAddress: terms.agentAddress,
    agentName: terms.agentName,
    nonce: terms.nonce,
    signatureChainId: options.signatureChainId ?? null,
    validUntil: options.validUntil ?? null,
    typedData,
  };
}

/**
 * Send the owner's signature over an approval to Hyperliquid. The signature
 * is checked against the organisation's own account before anything is sent,
 * so a wallet connected to another account approves nothing.
 */
export async function submitApproval(
  deps: Pick<Deps, 'store' | 'hyperliquid' | 'redact'>,
  org: OrgRecord,
  input: ApprovalOptions & { nonce: number; signature: string },
): Promise<{ approved: true; agentAddress: string }> {
  const terms = await termsOf(deps, org, input.nonce, input);
  let reply: Awaited<ReturnType<Deps['hyperliquid']['submitApproval']>>;
  try {
    reply = await deps.hyperliquid.submitApproval({ ...terms, user: org.hlUser, signature: input.signature });
  } catch (error) {
    throw invalid(messageOf(error));
  }
  if (reply.ok) return { approved: true, agentAddress: terms.agentAddress };

  const reason = deps.redact(reply.error ?? 'no reason given');
  // Stopped before anything reached the venue: the signature is not one over these terms by this account.
  if (!reply.delivered && reason.startsWith('not sent:')) throw invalid(`the approval was ${reason}`);
  // Hyperliquid processed the action and turned it down.
  if (reply.httpStatus === 200) throw refused(`Hyperliquid refused the approval: ${reason}`);
  throw unavailable(VENUE, reason);
}

/** The organisation's account on the venue as it stands now, or "unavailable". */
export async function venueState(deps: Pick<Deps, 'store' | 'hyperliquid' | 'now' | 'redact'>, org: OrgRecord): Promise<{ readAt: number; account: string; agentAddress: string | null; marginRatioBps: number | null; state: VenueReading }> {
  const read = await venueReading(deps, org);
  if (read.status !== 'ok') throw unavailable(VENUE, read.reason);
  const agent = await deps.store.activeKey(org.id, 'hl_agent');
  const ratio = marginRatio(read.value);
  return {
    readAt: read.readAt,
    account: org.hlUser,
    agentAddress: agent?.address ?? null,
    marginRatioBps: ratio === null ? null : Math.round(ratio * 10_000),
    state: read.value,
  };
}
