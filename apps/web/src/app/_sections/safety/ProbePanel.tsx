'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { type ProbeOutcome, api } from '@/client/api';
import { useAsyncAction } from '@/client/hooks';
import { Button, Dialog, ExternalTxLink, KeyValue, Link, Notice, Panel, StateTag, Timestamp } from '@/ui';
import { FailureNotice } from '../books/FailureNotice';
import { failureCopy } from '../books/failures';
import { Address } from './parts';
import type { ProbeSpec } from './probes';

export interface ProbePanelProps {
  orgId: string;
  probes: readonly ProbeSpec[];
  /** Where the Payouts section lives, for a probe that waits on an account being set up there. */
  payoutsHref: string;
}

function Outcome({ outcome }: { outcome: ProbeOutcome }) {
  return (
    <div className="sf-act__result" role="status">
      {outcome.refused ? (
        <Notice kind="refusal" title="The limit held" announce>
          <p>
            {outcome.refusals.length === 0
              ? 'Every attempt was refused, and each refusal was already on record.'
              : `${outcome.refusals.length === 1 ? 'The refusal is' : `${outcome.refusals.length} refusals are`} now on record below.`}
          </p>
        </Notice>
      ) : (
        <Notice kind="warning" title="This run proves nothing">
          <p>{outcome.error ?? 'The attempt was not refused.'}.</p>
          <p>Nothing was added to the record for an attempt that was not refused.</p>
        </Notice>
      )}
      {outcome.refusals.map((refusal) => (
        <KeyValue
          key={refusal.id}
          stacked
          items={[
            { label: 'Answer', value: <span className="hf-num">{refusal.outcome}</span> },
            {
              label: 'Transaction',
              value:
                refusal.tx !== null && refusal.txUrl !== null && (refusal.chain === 'tempo' || refusal.chain === 'solana') ? (
                  <ExternalTxLink chain={refusal.chain} id={refusal.tx} href={refusal.txUrl} />
                ) : (
                  <StateTag state="limit" label="No transaction: the exchange’s answer" />
                ),
            },
            { label: 'On record since', value: <Timestamp at={refusal.createdAt} /> },
          ]}
        />
      ))}
    </div>
  );
}

function Probe({ orgId, spec, payoutsHref }: { orgId: string; spec: ProbeSpec; payoutsHref: string }) {
  const router = useRouter();
  const [asking, setAsking] = useState(false);
  const action = useAsyncAction(async () => {
    const outcome = await api.runProbe(orgId, spec.kind);
    // The record on this page is the server's; it is read again rather than patched here.
    router.refresh();
    return outcome;
  });
  const failed = action.status === 'failed' ? failureCopy(action.error) : null;
  const facts = [
    { label: 'Signed by', value: spec.signer },
    { label: 'What is sent', value: spec.sends },
    {
      label: 'Addressed to',
      value: (
        <>
          {spec.to.what}
          {spec.to.address !== null && (
            <>
              : <Address value={spec.to.address} what="address" />
            </>
          )}
        </>
      ),
    },
    { label: 'Meant to fail', value: spec.expected },
    { label: 'Cost', value: spec.cost },
  ];

  return (
    <li className="sf-act__probe">
      <h4 className="sf-act__name">{spec.title}</h4>
      <KeyValue stacked items={facts} className="sf-act__facts" />
      {spec.blocked !== null ? (
        <Notice kind="info" title="Cannot be run yet" className="sf-act__go">
          <p>
            {spec.blocked.reason} <Link href={payoutsHref}>Set it up on Payouts</Link>, then come back.
          </p>
        </Notice>
      ) : (
        <div className="sf-act__go">
          <Button variant="secondary" busy={action.status === 'pending'} onClick={() => setAsking(true)}>
            {action.status === 'pending' ? 'Sent, waiting for the answer' : action.status === 'idle' ? 'Run this probe' : 'Run it again'}
          </Button>
          {action.status === 'pending' && (
            <p className="sf-act__said" role="status">
              The attempt has left the service. Waiting for the {spec.kind === 'hyperliquid_withdrawal' ? 'exchange' : 'chain'} to answer and for the answer to be recorded.
            </p>
          )}
        </div>
      )}
      {action.status === 'done' && <Outcome outcome={action.result} />}
      {failed !== null && (
        <FailureNotice failed={failed} className="sf-act__result">
          <p>Nothing was added to the record.</p>
        </FailureNotice>
      )}

      <Dialog
        open={asking}
        onClose={() => setAsking(false)}
        title={spec.title}
        closeLabel="Cancel"
        actions={
          <>
            <Button variant="quiet" onClick={() => setAsking(false)}>
              Do not send
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                setAsking(false);
                void action.run();
              }}
            >
              Send it
            </Button>
          </>
        }
      >
        <p>This sends something the {spec.kind === 'hyperliquid_withdrawal' ? 'exchange' : 'chain'} must refuse, signed by a key of the service. It is meant to fail, and the refusal is kept on this page as evidence that the limit holds.</p>
        <KeyValue stacked items={facts} />
        <p>It names only the team’s own accounts, and you sign nothing: no wallet will open.</p>
      </Dialog>
    </li>
  );
}

/**
 * The owner's probes: each makes one key of the service try something its
 * chain or venue must refuse, and puts the refusal on record. What will be
 * sent is stated on the page and again before it is sent.
 */
export function ProbePanel({ orgId, probes, payoutsHref }: ProbePanelProps) {
  return (
    <Panel title="Make a key try" level={3} flush>
      <ul className="sf-act__grid">
        {probes.map((spec) => (
          <Probe key={spec.kind} orgId={orgId} spec={spec} payoutsHref={payoutsHref} />
        ))}
      </ul>
    </Panel>
  );
}
