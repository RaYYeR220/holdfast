import type { Metadata } from 'next';
import { SectionHeading } from '@/ui';
import { OwnerGate } from '../../_lib/OwnerGate';
import { loadOwner } from '../../_lib/owner';
import { NewRun } from '../../_sections/payouts/NewRun';
import { PayoutsView } from '../../_sections/payouts/PayoutsView';
import { SolanaActions } from '../../_sections/payouts/SolanaActions';
import { TempoActions } from '../../_sections/payouts/TempoActions';
import { loadPayouts } from '../../_sections/payouts/load';
import { solanaForRuns, tempoForRuns } from '../../_sections/payouts/standing';

export const metadata: Metadata = { title: 'Payouts' };

/**
 * The owner's Payouts page: the rails and the runs as the demo shows them,
 * with what only the owner can do: make the Tempo account, set and revoke
 * the bounds of each key, and draft a run.
 */
export default async function PayoutsPage() {
  const owner = await loadOwner();
  if (owner.status !== 'ok') {
    return (
      <div className="hf-stack">
        <SectionHeading level={1} size="page" title="Payouts" lead="The two payout rails, the bounds of the keys the service pays with, and the runs." />
        <OwnerGate owner={owner} what="the payouts" />
      </div>
    );
  }
  const { org } = owner;
  const data = await loadPayouts(org, 'owner');
  const tempo = data.tempo.status === 'ok' ? data.tempo.value : null;
  const solana = data.solana.status === 'ok' ? data.solana.value : null;

  return (
    <PayoutsView
      audience="owner"
      data={data}
      now={Date.now()}
      base="/app"
      tempoActions={
        <TempoActions
          org={{ id: org.id, name: org.name, tempoAccount: org.tempoAccount }}
          rail={tempo === null ? null : { chainId: tempo.chainId, token: tempo.token, accessKey: tempo.accessKey, keyState: tempo.key.state, links: tempo.links }}
        />
      }
      solanaActions={
        <SolanaActions
          org={{ id: org.id, solanaOwner: org.solanaOwner }}
          rail={
            solana === null
              ? null
              : {
                  cluster: solana.cluster,
                  token: solana.token,
                  tokenAccount: solana.tokenAccount,
                  delegate: solana.delegate,
                  remaining: solana.allowance.state === 'approved' ? solana.allowance.remaining.toString() : null,
                  allowanceState: solana.allowance.state,
                  links: solana.links,
                }
          }
        />
      }
      newRun={<NewRun orgId={org.id} tempo={tempoForRuns(data.tempo)} solana={solanaForRuns(data.solana)} />}
    />
  );
}
