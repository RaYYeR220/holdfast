import type { OrgRecord } from '@holdfast/db';
import { type AttestorView, attestorOf, latestAttestation } from '@/server/attestations/service';
import { demoOrg, demoSafety } from '@/server/demo/service';
import { safetyFacts } from '@/server/pages/safety';
import { safetyOf } from '@/server/safety/service';
import { type Attempt, attempt } from './attempt';
import type { SafetyData } from './model';

/**
 * What the Safety page reads, for the public demo and for an owner. Each
 * reads every key's scope from its chain at the time of the request, through
 * the same service functions the API routes answer with.
 */

/** The demo treasury's keys, refusals and latest snapshot, from the public read model. */
export function loadDemoSafety(orgId: string): Promise<Attempt<SafetyData>> {
  return attempt(async (deps) => {
    const org = await demoOrg(deps, orgId);
    const [safety, facts] = await Promise.all([demoSafety(deps, org), safetyFacts(deps, org)]);
    return {
      keys: safety.keys,
      refusals: safety.refusals.status === 'ok' ? safety.refusals.value.map((refusal, index) => ({ ...refusal, id: `${refusal.at}-${index}` })) : [],
      attestation: safety.attestation,
      facts,
    };
  });
}

export interface OwnerSafety {
  data: SafetyData;
  /** The attester key, the contract and the call that names the key, with what the chain shows now. */
  attestor: AttestorView;
}

/** The same for the organisation of the signed-in owner, with what the owner needs to name the attester. */
export function loadOwnerSafety(org: OrgRecord): Promise<Attempt<OwnerSafety>> {
  return attempt(async (deps) => {
    const [safety, attestation, facts, attestor] = await Promise.all([safetyOf(deps, org), latestAttestation(deps, org), safetyFacts(deps, org), attestorOf(deps, org)]);
    return {
      data: {
        keys: safety.keys,
        refusals: safety.refusals.map((refusal) => ({ id: refusal.id, chain: refusal.chain, kind: refusal.kind, attempted: refusal.attempted, outcome: refusal.outcome, tx: refusal.tx, txUrl: refusal.txUrl, at: refusal.createdAt })),
        attestation,
        facts,
      },
      attestor,
    };
  });
}
