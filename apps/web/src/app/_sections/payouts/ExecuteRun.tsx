'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api } from '@/client/api';
import { useAsyncAction } from '@/client/hooks';
import { Button, Dialog, ExternalTxLink } from '@/ui';
import { executionTold, failureTold } from './flow';
import { type PayoutChain, RAIL_NAME } from './format';
import { ToldNotice, Waiting } from './Told';

export interface ExecuteRunProps {
  orgId: string;
  runId: string;
  chain: PayoutChain;
  /** The total of the run as it is written on the page: "0.75 USDC". */
  total: string;
  lines: number;
  /** Where the run stands on the record when the page was read. */
  standing: 'unpaid' | 'unsettled' | 'paid';
  /** Whether the preview says the rail would go ahead; null when there is no preview to go by. */
  wouldProceed: boolean | null;
}

/**
 * Paying a run, and the answer. The service's key signs, not the treasurer:
 * what they confirm here is that the run is to be paid now. Every way an
 * attempt can end has its own words, and after each the page is read again.
 */
export function ExecuteRun({ orgId, runId, chain, total, lines, standing, wouldProceed }: ExecuteRunProps) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const execute = useAsyncAction(async () => {
    try {
      return await api.executePayout(orgId, runId);
    } finally {
      // Whatever the answer, the record and the chain are read again: the page never keeps a figure of its own.
      router.refresh();
    }
  });
  const pending = execute.status === 'pending';
  const count = `${lines} ${lines === 1 ? 'line' : 'lines'}`;

  const label = standing === 'paid' ? 'Execute the paid run again' : standing === 'unsettled' ? 'Ask the rail again' : 'Pay this run';
  const answer = execute.status === 'done' ? execute.result : null;

  return (
    <>
      <div className="po-row">
        <Button variant={standing === 'unpaid' && wouldProceed !== false ? 'primary' : 'secondary'} busy={pending} onClick={() => (standing === 'unpaid' ? setConfirming(true) : void execute.run())}>
          {label}
        </Button>
        <span className="hf-small">
          {standing === 'paid'
            ? 'It sends nothing: a paid run answers with the transaction that paid it.'
            : standing === 'unsettled'
              ? 'The rail looks the run up on its chain before anything else, and settles it if the chain shows it paid.'
              : wouldProceed === false
                ? 'The preview says the rail would refuse. Executing asks the rail itself, which answers with its reason and sends nothing it would refuse.'
                : 'You will be asked to confirm. The service’s key signs the payout; no wallet of yours is asked.'}
        </span>
      </div>

      {pending && <Waiting>The rail is checking the run against the chain and, if nothing is in the way, sending it and waiting for the chain to include it. Keep this page open.</Waiting>}
      {execute.status === 'failed' && <ToldNotice told={failureTold(execute.error)} />}
      {answer !== null && (
        <ToldNotice told={executionTold({ outcome: answer.outcome, replayed: answer.replayed, error: answer.error, chain, hasTx: answer.run.tx !== null })}>
          {answer.run.tx !== null && (
            <p>
              <ExternalTxLink chain={chain} id={answer.run.tx} {...(answer.run.txUrl === null ? {} : { href: answer.run.txUrl })} />
            </p>
          )}
        </ToldNotice>
      )}

      <Dialog
        open={confirming}
        onClose={() => setConfirming(false)}
        title={`Pay run ${runId}`}
        closeLabel="Cancel"
        actions={
          <>
            <Button variant="quiet" onClick={() => setConfirming(false)}>
              Do not pay yet
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                setConfirming(false);
                void execute.run();
              }}
            >
              Pay {total}
            </Button>
          </>
        }
      >
        <p>
          <b className="po-strong">What is sent.</b> One transaction on {RAIL_NAME[chain]} that pays {count}, {total} in all, to the payees listed on this page.
        </p>
        <p>
          <b className="po-strong">Who signs.</b> The service&apos;s key, within the bounds its chain holds it to. If the run is outside those bounds the chain refuses it as a whole and nothing is paid.
        </p>
        <p>
          <b className="po-strong">It cannot be taken back.</b> A payment on chain is final. The run is paid once: executing it again sends nothing.
        </p>
      </Dialog>
    </>
  );
}
