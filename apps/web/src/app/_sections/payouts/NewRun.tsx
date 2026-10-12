'use client';

import { useRouter } from 'next/navigation';
import { useId, useState } from 'react';
import { api } from '@/client/api';
import { useAsyncAction } from '@/client/hooks';
import { Button, Input, Notice, Panel, Select } from '@/ui';
import { EMPTY_LINE, type LineDraft, MAX_LINES, checkRun, failureTold } from './flow';
import { type PayoutChain, RAIL_NAME, formatUnits } from './format';
import type { RailForRuns } from './standing';
import { ToldNotice, Waiting } from './Told';

export interface NewRunProps {
  orgId: string;
  tempo: RailForRuns;
  solana: RailForRuns;
}

/**
 * The lines of a new run. Drafting it sends nothing: the run gets its id and
 * its own page, where what paying it would do is shown before it is paid.
 * What the chosen rail's key would refuse is said here at once.
 */
export function NewRun({ orgId, tempo, solana }: NewRunProps) {
  const router = useRouter();
  const formId = useId();
  const [chain, setChain] = useState<PayoutChain>(tempo.blocked === null || solana.blocked !== null ? 'tempo' : 'solana');
  const [lines, setLines] = useState<LineDraft[]>([{ ...EMPTY_LINE }]);
  // Mistakes in a field are pointed out once the treasurer has asked for the run to be drafted, not while they type the first line.
  const [asked, setAsked] = useState(false);
  const rail = chain === 'tempo' ? tempo : solana;
  const { symbol, decimals } = rail.token;
  const check = checkRun(lines, { chain, decimals, symbol, remaining: rail.remaining === null ? null : BigInt(rail.remaining), recipients: rail.recipients });

  const draft = useAsyncAction(async () => {
    setAsked(true);
    if (check.payload === null) return;
    const run = await api.createPayout(orgId, { chain, lines: check.payload });
    router.push(`/app/payouts/${run.id}`);
  });

  const change = (index: number, patch: Partial<LineDraft>) => setLines(lines.map((line, at) => (at === index ? { ...line, ...patch } : line)));
  const busy = draft.status === 'pending';
  const shown = (message: string | undefined) => (asked && message !== undefined ? { error: message } : {});

  return (
    <Panel title="New payout run" level={2} className="po-new">
      <div className="po-new__rail">
        <Select
          label="Rail"
          hint="The chain the run is paid on, in that rail's token. One run is one transaction on one rail."
          value={chain}
          onChange={(event) => setChain(event.target.value === 'solana' ? 'solana' : 'tempo')}
          disabled={busy}
          options={[
            { value: 'tempo', label: `Tempo, in ${tempo.token.symbol}` },
            { value: 'solana', label: `Solana, in ${solana.token.symbol}` },
          ]}
        />
        <p className="po-new__standing">
          <span className="hf-px">{RAIL_NAME[chain]} now.</span> {rail.standing}
        </p>
      </div>

      {rail.blocked !== null ? (
        <Notice kind="info" title={`A run cannot be drafted on ${RAIL_NAME[chain]} yet`}>
          <p>{rail.blocked}</p>
        </Notice>
      ) : (
        <>
          <ol className="po-new__lines">
            {lines.map((line, index) => {
              const errors = check.lines[index] ?? { units: null };
              return (
                <li key={`${formId}-${index}`} className="po-new__line">
                  <span className="po-new__no hf-px" aria-hidden="true">
                    {index + 1}
                  </span>
                  <Input label="Payee" aria-label={`Line ${index + 1}: name of the payee`} placeholder="Name" value={line.name} maxLength={120} onChange={(event) => change(index, { name: event.target.value })} disabled={busy} {...shown(errors.name)} />
                  <Input
                    label={`${RAIL_NAME[chain]} address`}
                    aria-label={`Line ${index + 1}: ${RAIL_NAME[chain]} address of the payee`}
                    numeric
                    spellCheck={false}
                    autoComplete="off"
                    placeholder={chain === 'tempo' ? '0x…' : 'Base58 address'}
                    value={line.address}
                    onChange={(event) => change(index, { address: event.target.value })}
                    disabled={busy}
                    {...shown(errors.address)}
                  />
                  <Input label="Amount" aria-label={`Line ${index + 1}: amount in ${symbol}`} numeric inputMode="decimal" value={line.amount} onChange={(event) => change(index, { amount: event.target.value })} disabled={busy} {...shown(errors.amount)} />
                  <Input label="Reference" aria-label={`Line ${index + 1}: the payee's reference`} placeholder="Invoice number" value={line.reference} maxLength={64} onChange={(event) => change(index, { reference: event.target.value })} disabled={busy} {...shown(errors.reference)} />
                  <div className="po-new__remove">
                    {lines.length > 1 && (
                      <Button variant="quiet" small disabled={busy} aria-label={`Remove line ${index + 1}`} onClick={() => setLines(lines.filter((_line, at) => at !== index))}>
                        Remove
                      </Button>
                    )}
                  </div>
                </li>
              );
            })}
          </ol>
          <p className="hf-small">
            {chain === 'tempo'
              ? 'On Tempo every transfer carries the memo “run id/line” on chain; the reference is kept with the run and shown on the receipt.'
              : 'On Solana the reference of a line goes on chain as its memo, so each one in a run has to be its own. A payee without a token account gets one, at most three in a run, paid for by the service key.'}
          </p>

          <div className="po-new__foot">
            <Button variant="secondary" disabled={busy || lines.length >= MAX_LINES} onClick={() => setLines([...lines, { ...EMPTY_LINE }])}>
              Add a line
            </Button>
            <p className="po-new__total">
              <span className="hf-px">Total</span>{' '}
              {check.lines.some((line) => line.units !== null) ? (
                <>
                  <span className="hf-num">
                    {formatUnits(check.total, decimals)} {symbol}
                  </span>{' '}
                  <span className="hf-small">
                    in {lines.length} {lines.length === 1 ? 'line' : 'lines'}
                  </span>
                </>
              ) : (
                <span className="hf-small">No amount entered yet.</span>
              )}
            </p>
          </div>

          {check.warnings.length > 0 && (
            <Notice kind="warning" title={`${RAIL_NAME[chain]} would refuse this run as its key stands now`}>
              <ul className="po-bullets">
                {check.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
              <p>The run can still be drafted. It can be paid once the key allows it.</p>
            </Notice>
          )}
          {asked && check.problem !== null && <Notice kind="refusal" word="Not a run" title={check.problem} />}
          {asked && check.problem === null && check.payload === null && <Notice kind="refusal" word="Not yet" title="Some lines are not complete; each field says what it needs" />}

          <div className="po-row">
            <Button variant="primary" busy={busy} onClick={() => void draft.run()}>
              Draft the run
            </Button>
            <span className="hf-small">Drafting sends nothing. The next page shows what paying the run would do; paying it is a step of its own.</span>
          </div>
          {busy && <Waiting>Recording the run and giving it its id.</Waiting>}
          {draft.status === 'failed' && <ToldNotice told={failureTold(draft.error)} />}
        </>
      )}
    </Panel>
  );
}
