import type { NewRefusal, OrgRecord, RefusalRow } from '@holdfast/db';
import type { ProbeAttempt } from '@holdfast/hyperliquid';
import type { ProbeResult } from '@holdfast/tempo';
import type { Hex } from 'viem';
import type { Deps } from '../deps';
import { refused as refusedError, unavailable } from '../errors';
import { txUrlOf } from '../payouts/receipt';
import { solanaAccess, tempoAccess } from '../rails/access';
import { messageOf } from '../redact';
import { type KeyScope, keyScopes } from './scopes';

type SafetyDeps = Pick<Deps, 'store' | 'hyperliquid' | 'tempo' | 'solana' | 'attestor' | 'now' | 'redact'>;

export const PROBE_KINDS = ['hyperliquid_withdrawal', 'tempo_over_limit', 'tempo_out_of_scope', 'solana_over_allowance'] as const;
export type ProbeKind = (typeof PROBE_KINDS)[number];

export interface RefusalView extends RefusalRow {
  txUrl: string | null;
}

/** What a probe established. It is `refused` only when the chain or venue itself recorded a refusal. */
export interface ProbeOutcome {
  kind: ProbeKind;
  refused: boolean;
  /** Why the probe proves nothing, when it does not; null when every attempt was refused. */
  error: string | null;
  /** The refusals this probe added to the record. */
  refusals: RefusalView[];
}

function viewOf(deps: Pick<Deps, 'tempo' | 'solana'>, row: RefusalRow): RefusalView {
  const onChain = row.tx !== null && (row.chain === 'tempo' || row.chain === 'solana');
  return { ...row, txUrl: onChain && row.tx !== null ? txUrlOf(deps, row.chain as 'tempo' | 'solana', row.tx) : null };
}

/** The refusals on record for the organisation, newest first. */
export async function listRefusals(deps: Pick<Deps, 'store' | 'tempo' | 'solana'>, orgId: string): Promise<RefusalView[]> {
  return (await deps.store.listRefusals(orgId)).map((row) => viewOf(deps, row));
}

/** Each key with its scope as its chain reports it now, and the refusals on record. */
export async function safetyOf(deps: SafetyDeps, org: OrgRecord): Promise<{ keys: KeyScope[]; refusals: RefusalView[] }> {
  return { keys: await keyScopes(deps, org), refusals: await listRefusals(deps, org.id) };
}

async function record(deps: SafetyDeps, orgId: string, refusal: NewRefusal): Promise<RefusalView[]> {
  const row = await deps.store.recordRefusal(orgId, refusal);
  return row === null ? [] : [viewOf(deps, row)];
}

/** The venue's own words for turning an action down. */
function venueReason(attempt: ProbeAttempt): string {
  const response = attempt.response as { response?: unknown } | null;
  return typeof response?.response === 'string' ? response.response : JSON.stringify(attempt.response);
}

/**
 * Have the agent key sign a withdrawal and a transfer, both to the
 * organisation's own account, and keep Hyperliquid's refusal of each.
 */
async function probeHyperliquid(deps: SafetyDeps, org: OrgRecord): Promise<ProbeOutcome> {
  const agent = await deps.store.activeKey(org.id, 'hl_agent');
  if (agent === null) throw refusedError('the organisation has no Hyperliquid agent key');
  const probe = await deps.hyperliquid.probeWithdrawal({ agentPrivateKey: agent.secret as Hex, user: org.hlUser }).catch((error: unknown) => {
    throw unavailable('Hyperliquid', deps.redact(messageOf(error)));
  });

  const attempts = [
    ['withdraw3', 'a withdrawal', probe.withdraw3],
    ['usdSend', 'a transfer of dollars', probe.usdSend],
  ] as const;
  // No answer to either attempt says nothing about the key; it says the venue could not be reached.
  if (attempts.every(([, , attempt]) => attempt.httpStatus === null)) throw unavailable('Hyperliquid', deps.redact(probe.withdraw3.error ?? 'no answer'));

  const refusals: RefusalView[] = [];
  const unproven: string[] = [];
  for (const [kind, what, attempt] of attempts) {
    if (!attempt.refused) {
      unproven.push(`${kind}: ${deps.redact(attempt.error ?? 'not refused')}`);
      continue;
    }
    refusals.push(
      ...(await record(deps, org.id, {
        chain: 'hyperliquid',
        kind,
        attempted: `${what} to the organisation's own account, signed by the agent key ${probe.agentAddress}`,
        outcome: venueReason(attempt),
        tx: null,
        evidence: { attempted: attempt.attempted, response: attempt.response, httpStatus: attempt.httpStatus },
      })),
    );
  }
  return { kind: 'hyperliquid_withdrawal', refused: unproven.length === 0, error: unproven.length === 0 ? null : unproven.join('; '), refusals };
}

async function recordTempo(deps: SafetyDeps, org: OrgRecord, kind: 'tempo_over_limit' | 'tempo_out_of_scope', attempted: string, result: ProbeResult): Promise<ProbeOutcome> {
  if (!result.includedOnChain || result.tx === null) throw unavailable('Tempo', deps.redact(result.error ?? 'the probe produced no receipt'));
  if (!result.reverted) return { kind, refused: false, error: `the chain included ${result.tx} and did not refuse it`, refusals: [] };
  const refusals = await record(deps, org.id, {
    chain: 'tempo',
    kind: kind === 'tempo_over_limit' ? 'over_limit' : 'out_of_scope',
    attempted,
    outcome: result.reason ?? 'reverted; the node did not return the reason',
    tx: result.tx,
    evidence: { reverted: result.reverted, reason: result.reason, returnData: result.returnData, gasUsed: result.gasUsed },
  });
  return { kind, refused: true, error: null, refusals };
}

/**
 * Send, with the organisation's own service key, something its chain or
 * venue must refuse, and keep the refusal as evidence that the limit holds.
 * Every probe aims at the organisation's own account, so that even an answer
 * nobody expects could move nothing anywhere else.
 */
export async function runProbe(deps: SafetyDeps, org: OrgRecord, kind: ProbeKind): Promise<ProbeOutcome> {
  if (kind === 'hyperliquid_withdrawal') return probeHyperliquid(deps, org);

  if (kind === 'tempo_over_limit' || kind === 'tempo_out_of_scope') {
    const { rail, account } = await tempoAccess(deps, org);
    if (kind === 'tempo_out_of_scope') {
      return recordTempo(deps, org, kind, `a plain transfer of one base unit to the organisation's own account, which the key is not scoped for`, await rail.probeOutOfScope({ account, to: account }));
    }
    // The limit is only reached by a call the scope lets through, so the probe has to name a payee the key may pay.
    const key = await rail.keyStatus(account).catch((error: unknown) => {
      throw unavailable('Tempo', deps.redact(messageOf(error)));
    });
    const to = key.scope.recipients?.[0] ?? account;
    return recordTempo(deps, org, kind, `transferWithMemo of the largest amount there is, to ${to}`, await rail.probeOverLimit({ account, to }));
  }

  const { rail, owner } = await solanaAccess(deps, org);
  const result = await rail.probeOverAllowance({ account: owner, to: owner });
  if (result.signature === null) throw unavailable('Solana', deps.redact(result.error ?? 'the probe was not sent'));
  if (!result.failedOnChain) return { kind, refused: false, error: deps.redact(result.error ?? `the chain did not record ${result.signature} as refused`), refusals: [] };
  const refusals = await record(deps, org.id, {
    chain: 'solana',
    kind: 'over_allowance',
    attempted: `a transfer of one base unit more than the allowance, to the organisation's own wallet`,
    outcome: result.error ?? 'failed on chain',
    tx: result.signature,
    evidence: { failedOnChain: result.failedOnChain, error: result.error },
  });
  return { kind, refused: true, error: null, refusals };
}
