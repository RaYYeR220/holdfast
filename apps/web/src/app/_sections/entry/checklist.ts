import type { Advisory, Policy } from '@holdfast/core';
import { formatBps, formatNumber, formatUsd } from '../../../ui/format';
import type { State } from '../../../ui/onebit/patterns';

/**
 * The owner's setup checklist and the advisories, in words. The checklist is
 * the five things that give the service its keys; each item's state is what
 * the chain or the venue showed when the page was made, never what the
 * database remembers. A state that could not be read is its own state.
 */

/** A reading as it reaches this module: read with a value, or not read with the reason. */
export type Read<T> = { status: 'ok'; readAt: number; value: T } | { status: 'unavailable'; source: string; readAt: number; reason: string };

export interface ChecklistInput {
  /** The area the links lead into: "/app". */
  base: string;
  org: { birthday: number; scannedTo: number | null; tempoAccount: string | null; solanaOwner: string | null };
  /** Whether the venue lists the service's agent among the agents of the account. */
  agent: Read<{ approved: boolean }>;
  /** The Tempo access key as the Account Keychain has it. */
  tempo: Read<{ authorized: boolean; live: boolean; revoked: boolean; expiresAt: number | null }>;
  /** What the Solana delegate may still move, in token base units. */
  solana: Read<{ remaining: bigint | string }>;
  /** Whether the account has named the service's attester key on the contract. */
  attester: Read<{ registered: boolean }>;
  now: number;
}

export type StepState = 'done' | 'open' | 'unknown';

export interface ChecklistItem {
  key: 'viewing' | 'agent' | 'tempo' | 'solana' | 'attester';
  title: string;
  state: StepState;
  /** What is true now. */
  detail: string;
  /** Where the step is done, and what the link says. */
  href: string;
  action: string;
  /** When the state was read; null for the viewing key, which is a fact of the registration. */
  readAt: number | null;
  /** For a state that could not be read: the source that failed. */
  source: string | null;
}

export const STEP_TAG: Record<StepState, { state: State; label: string }> = {
  done: { state: 'locked', label: 'Done' },
  open: { state: 'unlocked', label: 'To do' },
  unknown: { state: 'stale', label: 'Not read' },
};

type Standing = Pick<ChecklistItem, 'state' | 'detail' | 'readAt' | 'source'>;

const step = (state: StepState, detail: string, readAt: number | null): Standing => ({ state, detail, readAt, source: null });

const unread = (read: Extract<Read<unknown>, { status: 'unavailable' }>): Standing => ({
  state: 'unknown',
  detail: `This could not be read: ${read.reason}.`,
  readAt: read.readAt,
  source: read.source,
});

export function checklistOf(input: ChecklistInput): ChecklistItem[] {
  const { base, org, agent, tempo, solana, attester, now } = input;

  const viewing: ChecklistItem = {
    key: 'viewing',
    title: 'Viewing key imported',
    state: 'done',
    detail:
      org.scannedTo === null
        ? `Imported when the organisation was registered. The scan starts at block ${formatNumber(org.birthday)}; no tick has scanned yet.`
        : `Imported when the organisation was registered. Scanned from block ${formatNumber(org.birthday)} to block ${formatNumber(org.scannedTo)}.`,
    href: `${base}/treasury`,
    action: 'See the treasury',
    readAt: null,
    source: null,
  };

  const agentItem: ChecklistItem = {
    key: 'agent',
    title: 'Hyperliquid agent approved',
    href: `${base}/lock#agent`,
    action: 'Approve it on the Lock page',
    ...(agent.status !== 'ok'
      ? unread(agent)
      : agent.value.approved
        ? step('done', 'The venue lists the service’s agent key among the agents of the account. It can trade and cannot withdraw.', agent.readAt)
        : step('open', 'The venue does not list the service’s agent key, so the controller can place no order. Approving is one signature in your wallet.', agent.readAt)),
  };

  const tempoItem: ChecklistItem = {
    key: 'tempo',
    title: 'Tempo access key authorised',
    href: `${base}/payouts`,
    action: 'Authorise it on the Payouts page',
    ...(org.tempoAccount === null
      ? step('open', 'The organisation has no Tempo account yet. Creating one, with a passkey kept on your device, is the first step on the Payouts page.', null)
      : tempo.status !== 'ok'
        ? unread(tempo)
        : tempo.value.authorized
          ? step('done', 'The Account Keychain shows the key live, with a spending limit and a call scope of transferWithMemo on the payout token.', tempo.readAt)
          : tempo.value.revoked
            ? step('open', 'The key was revoked on the account. It can pay nothing until it is authorised again.', tempo.readAt)
            : tempo.value.expiresAt !== null && tempo.value.expiresAt <= now
              ? step('open', 'The key’s authorisation has expired. It can pay nothing until it is authorised again.', tempo.readAt)
              : tempo.value.live
                ? step('open', 'The key is live on the account, and not bounded the way the rail requires. The rail pays only with a key that has a limit and the one call scope.', tempo.readAt)
                : step('open', 'The Account Keychain does not know the key on this account, so it can pay nothing.', tempo.readAt)),
  };

  const solanaItem: ChecklistItem = {
    key: 'solana',
    title: 'Solana delegate approved',
    href: `${base}/payouts`,
    action: 'Approve it on the Payouts page',
    ...(org.solanaOwner === null
      ? step('open', 'The organisation has no Solana wallet yet. Connecting the team’s wallet is the first step on the Payouts page.', null)
      : solana.status !== 'ok'
        ? unread(solana)
        : BigInt(solana.value.remaining) > 0n
          ? step('done', 'The token account shows an allowance for the service’s delegate. It can pay out up to that amount and nothing after you revoke it.', solana.readAt)
          : step('open', 'The token account shows no allowance for the service’s delegate, so it can pay nothing.', solana.readAt)),
  };

  const attesterItem: ChecklistItem = {
    key: 'attester',
    title: 'Attester named on HyperEVM',
    href: `${base}/safety`,
    action: 'Name it on the Safety page',
    ...(attester.status !== 'ok'
      ? unread(attester)
      : attester.value.registered
        ? step('done', 'The contract shows the service’s attester key as the attester of the account. It records snapshots and moves nothing.', attester.readAt)
        : step('open', 'The account has not named the service’s attester key, so no snapshot of the hedge is recorded. The key can record snapshots and cannot move anything.', attester.readAt)),
  };

  return [viewing, agentItem, tempoItem, solanaItem, attesterItem];
}

/** How many of the steps the chain showed as done, of how many could be read. */
export function checklistCount(items: readonly ChecklistItem[]): { done: number; total: number; unknown: number } {
  return { done: items.filter((item) => item.state === 'done').length, total: items.length, unknown: items.filter((item) => item.state === 'unknown').length };
}

export interface AdvisoryShown {
  kind: Advisory['kind'];
  state: State;
  word: string;
  title: string;
  text: string;
  /** Where the treasurer acts on it. */
  href: string;
  action: string;
}

type Levels = Pick<Policy, 'marginTargetBps' | 'topUpWarnBps' | 'deRiskTriggerBps' | 'sweepAboveBps'>;

/** One advisory as the page states it: what is asked, why, and that only the treasurer can do it. */
export function advisoryShown(advisory: Advisory, policy: Levels, base: string): AdvisoryShown {
  switch (advisory.kind) {
    case 'TOP_UP_MARGIN':
      return {
        kind: advisory.kind,
        state: advisory.severity === 'critical' ? 'refused' : 'limit',
        word: advisory.severity === 'critical' ? 'Urgent' : 'Top-up',
        title: `Add ${formatUsd(advisory.usd)} of margin`,
        text:
          advisory.severity === 'critical'
            ? `The margin ratio is under the buy-back floor of ${formatBps(policy.deRiskTriggerBps)}: the controller is buying back the short. ${formatUsd(advisory.usd)} of USDC on the Hyperliquid account brings the ratio back to the target of ${formatBps(policy.marginTargetBps)}. The service cannot add margin; it is a payment you sign.`
            : `The margin on the Hyperliquid account is short of what the policy asks for. ${formatUsd(advisory.usd)} of USDC brings the ratio to the target of ${formatBps(policy.marginTargetBps)}. The service cannot add margin; it is a payment you sign.`,
        href: `${base}/treasury#funding`,
        action: 'Fund it from the treasury',
      };
    case 'SWEEP_EXCESS_MARGIN':
      return {
        kind: advisory.kind,
        state: 'unlocked',
        word: 'Excess',
        title: `${formatUsd(advisory.usd)} of margin can be taken back`,
        text: `The margin ratio is over ${formatBps(policy.sweepAboveBps)}. ${formatUsd(advisory.usd)} is more than the target of ${formatBps(policy.marginTargetBps)} needs. Withdrawing it is yours to do on Hyperliquid, with the account’s own wallet; the service’s key cannot withdraw.`,
        href: `${base}/lock`,
        action: 'See the margin on the Lock page',
      };
    case 'RELOCK':
      return {
        kind: advisory.kind,
        state: 'limit',
        word: 'Uncovered',
        title: `${formatNumber(advisory.lots)} ${advisory.lots === 1 ? 'lot is' : 'lots are'} not hedged`,
        text: `The treasury calls for a larger short than the margin on the account carries: ${formatNumber(advisory.lots)} ${advisory.lots === 1 ? 'lot' : 'lots'} of 0.01 ZEC cannot be sold. Once the margin is there the controller sells them at a later tick.`,
        href: `${base}/lock`,
        action: 'See the lock',
      };
  }
}
