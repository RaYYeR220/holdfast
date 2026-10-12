import type { ReactNode } from 'react';
import type { RunPageShown, SolanaRailShown, TempoRailShown } from '@/server/pages/payouts';
import { ExternalTxLink, KeyValue, type KeyValueItem, Notice, Panel } from '@/ui';
import { leftAfter, sentence, solanaCostTotal } from './flow';
import { RAIL_NAME, addressUrl, formatSol, tokenText } from './format';
import type { Loaded } from './load';
import { Fact, GapNote } from './parts';

export interface RunPreviewProps {
  page: RunPageShown;
  /** The rail the run is paid through, as its chain reports it now; null for a run on the other rail, and for a paid run. */
  tempo: Loaded<TempoRailShown> | null;
  solana: Loaded<SolanaRailShown> | null;
  /** The server's clock at render. */
  now: number;
  /** The button that pays the run, and its answer. */
  children: ReactNode;
}

/** What the run takes from the Tempo key's limit, and what it leaves. */
function tempoFacts(page: RunPageShown, rail: Loaded<TempoRailShown> | null): KeyValueItem[] {
  const { run } = page;
  const total = tokenText(run.total, run.token);
  const key = rail?.status === 'ok' ? rail.value.key : null;
  const remaining = key?.state === 'authorized' ? key.remaining : null;
  const after = leftAfter(remaining, run.total);
  return [
    { label: 'Pays out', value: `${total} in ${run.lines.length} ${run.lines.length === 1 ? 'transfer' : 'transfers'}, one transaction` },
    {
      label: 'From the limit',
      value: (
        <Fact
          note={
            remaining === null
              ? key === null || key.state === 'unavailable'
                ? 'What the key has left could not be read from Tempo just now.'
                : 'The access key may pay nothing as it stands, so there is no limit to pay this from.'
              : after === null
                ? `The key has ${tokenText(remaining, run.token)} left in this period, which does not cover the run.`
                : `The key has ${tokenText(remaining, run.token)} left in this period. After the run: ${tokenText(after, run.token)}.`
          }
        >
          {total}
        </Fact>
      ),
    },
    { label: 'Fee', value: 'Paid by the service’s sponsor account. Nothing is taken for it from the limit or from the team’s account.' },
    { label: 'On chain', value: 'Each transfer carries the memo “run id/line”, which is how the run is found again and never paid twice.' },
  ];
}

/** What the run takes from the allowance and from the service key's SOL, and what it leaves of each. */
function solanaFacts(page: RunPageShown, rail: Loaded<SolanaRailShown> | null): KeyValueItem[] {
  const { run, preview } = page;
  const total = tokenText(run.total, run.token);
  const state = rail?.status === 'ok' ? rail.value.allowance.state : 'unavailable';
  const allowance = rail?.status === 'ok' && rail.value.allowance.state === 'approved' ? rail.value.allowance.remaining : null;
  const after = leftAfter(allowance, run.total);
  const lamports = rail?.status === 'ok' && rail.value.delegateLamports?.status === 'ok' ? rail.value.delegateLamports.value : null;
  const cost = preview?.status === 'ok' ? (preview.value.solana?.cost ?? null) : null;
  const facts: KeyValueItem[] = [
    { label: 'Pays out', value: `${total} in ${run.lines.length} ${run.lines.length === 1 ? 'transfer' : 'transfers'}, one transaction` },
    {
      label: 'From the allowance',
      value: (
        <Fact
          note={
            allowance === null
              ? state === 'nothing'
                ? 'The delegate has no allowance, so there is nothing to pay this from.'
                : state === 'no_wallet'
                  ? 'The organisation names no Solana wallet.'
                  : 'What the delegate has left could not be read from Solana just now.'
              : after === null
                ? `The delegate has ${tokenText(allowance, run.token)} of allowance left, which does not cover the run.`
                : `The delegate has ${tokenText(allowance, run.token)} of allowance left. After the run: ${tokenText(after, run.token)}.`
          }
        >
          {total}
        </Fact>
      ),
    },
  ];
  if (cost === null) {
    facts.push({ label: 'From the delegate’s SOL', value: 'The rail did not work out what the run would cost the service key, for the reason above.' });
    return facts;
  }
  const spent = solanaCostTotal(cost);
  const left = lamports === null || spent > lamports ? null : lamports - spent;
  facts.push(
    {
      label: 'New token accounts',
      value: (
        <Fact note="A payee who has no account for the token yet gets one in the same transaction, at most three in a run. The rent stays in the payee’s account; it is not a fee.">
          {cost.newTokenAccounts === 0 ? 'None: every payee has one.' : `${cost.newTokenAccounts}, with ${formatSol(cost.rentLamports)} SOL of rent`}
        </Fact>
      ),
    },
    { label: 'Run marker', value: <Fact note="The rent of the marker that makes the chain refuse a second payment of this run. It stays on chain for good.">{formatSol(cost.markerLamports)} SOL</Fact> },
    { label: 'Fee', value: `${formatSol(cost.feeLamports)} SOL` },
    {
      label: 'From the delegate’s SOL',
      value: (
        <Fact
          note={
            lamports === null
              ? 'What the service key holds could not be read.'
              : left === null
                ? `The service key holds ${formatSol(lamports)} SOL, which does not cover this.`
                : `The service key holds ${formatSol(lamports)} SOL. After the run: ${formatSol(left)} SOL.`
          }
        >
          {formatSol(spent)} SOL in all
        </Fact>
      ),
    },
  );
  return facts;
}

/**
 * For the owner, between a run's record and its lines: what paying the run
 * would do as things stand, read from the rail without sending anything, and
 * the button that pays it. A paid run keeps the button, because executing it
 * again is how the rail shows that it pays a run once.
 */
export function RunPreview({ page, tempo, solana, now, children }: RunPreviewProps) {
  const { run, preview } = page;
  const rail = RAIL_NAME[run.chain];

  if (run.status === 'paid') {
    return (
      <Panel title="Paid once" level={2} state="locked" stateLabel="Nothing to pay">
        <div className="po-preview">
          <p>This run is paid. Executing it again sends nothing: the rail answers with the transaction that paid it, however often it is asked. That is what makes paying a run safe to repeat.</p>
          {children}
        </div>
      </Panel>
    );
  }

  const read = preview?.status === 'ok' ? preview.value : null;
  const gap = run.chain === 'tempo' ? tempo : solana;
  // An attempt whose outcome was not seen may have paid: nothing here may say that nothing was sent.
  const unsettled = run.status === 'sending';
  return (
    <Panel
      framed
      title={unsettled ? 'What asking the rail again would do' : 'What paying this run would do'}
      level={2}
      {...(read === null ? { state: 'stale' as const, stateLabel: 'No preview' } : read.wouldProceed ? { state: 'locked' as const, stateLabel: read.solana?.alreadyPaid === true ? 'Already on chain' : 'Would be sent' } : { state: 'refused' as const, stateLabel: 'Would be refused' })}
    >
      <div className="po-preview">
        {preview !== null && preview.status !== 'ok' && (
          <>
            <GapNote gap={{ source: preview.source, reason: preview.reason, at: preview.readAt }} now={now} />
            <p>The rail could not say what paying the run would do. Executing asks it again; it sends nothing it cannot check first.</p>
          </>
        )}
        {gap !== null && gap.status !== 'ok' && <GapNote gap={gap} now={now} />}

        {read !== null && !read.wouldProceed && (
          <Notice kind={unsettled ? 'warning' : 'refusal'} title={unsettled ? `${rail} would send nothing for this run now` : `${rail} would not pay this run as things stand`}>
            {read.problems.length === 0 ? (
              <p>The rail gave no reason.</p>
            ) : (
              <ul className="po-bullets">
                {read.problems.map((problem) => (
                  <li key={problem}>{sentence(problem)}</li>
                ))}
              </ul>
            )}
            <p>{unsettled ? 'Whether the earlier attempt paid is not established. Asking the rail again has it look the run up on its chain, and settle it if the chain shows it paid.' : 'Nothing has been sent. The run stays as it is until this changes.'}</p>
          </Notice>
        )}
        {read?.solana?.alreadyPaid === true && (
          <Notice kind="info" title="These lines are already paid on chain under this id">
            <p>Executing sends nothing and records the run as paid by that transaction.</p>
            {read.solana.paidBy !== null && (
              <p>
                <ExternalTxLink chain="solana" id={read.solana.paidBy} href={addressUrl(page.txLinks, read.solana.paidBy)} />
              </p>
            )}
          </Notice>
        )}
        {read?.solana !== null && read?.solana !== undefined && read.solana.spent && !read.solana.alreadyPaid && (
          <Notice kind="warning" title="The id of this run is taken on chain">
            <p>A payment under this id is on chain or on its way, and it is not established that it paid these lines. Paying would send nothing.</p>
          </Notice>
        )}
        {read?.solana?.historyError !== null && read?.solana?.historyError !== undefined && (
          <Notice kind="warning" title="The history of the paying account could not be read in full">
            <p>{sentence(read.solana.historyError)}</p>
          </Notice>
        )}

        <KeyValue items={run.chain === 'tempo' ? tempoFacts(page, tempo) : solanaFacts(page, solana)} className="po-facts" />
        <p className="hf-small">Read from {rail} just now, without sending anything. Paying needs no signature from you: the service&apos;s key signs, and the chain holds it to its bounds.</p>
        {children}
      </div>
    </Panel>
  );
}
