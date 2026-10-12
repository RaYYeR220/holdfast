import type { OrgRecord } from '@holdfast/db';
import { type DemoJournal, type DemoOverview, demoJournal, demoOverview } from '@/server/demo/service';
import { agentApprovalOf } from '@/server/pages/lock';
import { type Failure, type Outcome, PAGE_PATIENCE_MS, failureOf, outcomeOf, within } from '@/server/pages/treasury-lock-reads';
import { type Advisories, currentAdvisories } from '@/server/policy/service';
import { type Reading, mapReading, missing } from '@/server/reading';
import { runtime } from '@/server/runtime';
import { type KeyScope, keyScopes } from '@/server/safety/scopes';
import { type ChecklistItem, checklistOf } from './checklist';

/**
 * The owner's overview as the page reads it, once for a request: the same
 * figures the public Overview shows, read for the owner's own organisation,
 * the state of the five steps that give the service its keys, and what the
 * treasurer is asked to do now. Nothing here throws.
 */

const JOURNAL_ROWS = 6;

export interface OwnerOverview {
  overview: DemoOverview;
  journal: { status: 'ok'; value: DemoJournal } | ({ status: 'unavailable' } & Failure);
  checklist: ChecklistItem[];
  advisories: Outcome<Advisories>;
  /** The keys the service made for the organisation, each as its address. */
  serviceKeys: { kind: KeyScope['kind']; address: string }[];
}

export type OwnerOverviewRead = { status: 'ok'; data: OwnerOverview } | ({ status: 'unavailable' } & Failure);

/** The scope of one key out of the list the safety service reads, as the reading the checklist takes. */
function scopeOf<T>(keys: readonly KeyScope[], kind: KeyScope['kind'], now: number): Reading<T> {
  const found = keys.find((key) => key.kind === kind);
  return found === undefined ? missing<T>('database', now, 'the organisation has no such key') : (found.scope as Reading<T>);
}

export async function loadOwnerOverview(org: OrgRecord): Promise<OwnerOverviewRead> {
  const deps = runtime();
  try {
    const [overview, journal, keys, agent, advisories] = await within(
      PAGE_PATIENCE_MS,
      Promise.all([
        demoOverview(deps, org),
        demoJournal(deps, org, { limit: JOURNAL_ROWS }).then(
          (value) => ({ status: 'ok' as const, value }),
          (error: unknown) => ({ status: 'unavailable' as const, ...failureOf(deps, error, deps.now(), 'journal') }),
        ),
        keyScopes(deps, org),
        agentApprovalOf(deps, org),
        outcomeOf(deps, 'hyperliquid', () => currentAdvisories(deps, org)),
      ]),
    );
    const now = deps.now();
    const checklist = checklistOf({
      base: '/app',
      org: { birthday: org.birthday, scannedTo: org.scannedTo, tempoAccount: org.tempoAccount, solanaOwner: org.solanaOwner },
      agent: mapReading(agent, (approval) => ({ approved: approval.approved })),
      tempo: scopeOf(keys, 'tempo_access', now),
      solana: scopeOf(keys, 'solana_delegate', now),
      attester: scopeOf(keys, 'hl_attester', now),
      now,
    });
    const serviceKeys = keys.flatMap((key) => (key.address === null ? [] : [{ kind: key.kind, address: key.address }]));
    return { status: 'ok', data: { overview, journal, checklist, advisories, serviceKeys } };
  } catch (error) {
    return { status: 'unavailable', ...failureOf(deps, error, deps.now()) };
  }
}
