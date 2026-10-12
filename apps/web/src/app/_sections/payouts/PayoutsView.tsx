import type { ReactNode } from 'react';
import type { RunShown } from '@/server/pages/payouts';
import { ExternalTxLink, Link, SectionHeading, StateTag, Tag } from '@/ui';
import { RAIL_NAME, RUN_STATE, tokenAmount } from './format';
import type { PayoutsData } from './load';
import { GapNote, Ledger, When } from './parts';
import { SolanaRailPanel, TempoRailPanel } from './RailsView';
import './payouts.css';

/** A sentence that says a part of the page cannot be changed from it, and who can change it. */
export function ReadOnly({ children }: { children: ReactNode }) {
  return (
    <p className="po-readonly">
      <i className="hf-swatch hf-pat-limit" aria-hidden="true" />
      <span>
        <b className="hf-px">Read only.</b> {children}
      </span>
    </p>
  );
}

function RunsLedger({ runs, base, now }: { runs: readonly RunShown[]; base: string; now: number }) {
  return (
    <Ledger
      caption="Payout runs, newest first"
      template="minmax(176px, 1.1fr) 104px 64px minmax(128px, 0.9fr) 144px minmax(184px, 1.3fr) 200px"
      columns={[
        { key: 'run', header: 'Run', rowHeader: true },
        { key: 'rail', header: 'Rail' },
        { key: 'lines', header: 'Lines', numeric: true },
        { key: 'total', header: 'Total', numeric: true },
        { key: 'state', header: 'State' },
        { key: 'tx', header: 'Transaction', wide: true },
        { key: 'time', header: 'Time', wide: true },
      ]}
      rows={runs.map((run) => {
        const total = tokenAmount(run.total, run.token);
        const state = RUN_STATE[run.status];
        return {
          id: run.id,
          cells: {
            run: (
              <Link href={`${base}/payouts/${run.id}`} className="po-runid">
                {run.id}
              </Link>
            ),
            rail: <Tag>{RAIL_NAME[run.chain]}</Tag>,
            lines: run.lines.length,
            total: (
              <>
                {total.figure} <span className="po-unit">{total.unit}</span>
              </>
            ),
            state: <StateTag state={state.fill} label={state.word} />,
            tx: run.tx === null ? <span className="po-quiet">None. Nothing is on chain for this run.</span> : <ExternalTxLink chain={run.chain} id={run.tx} showChain={false} {...(run.txUrl === null ? {} : { href: run.txUrl })} />,
            time: run.paidAt !== null ? <When at={run.paidAt} now={now} what="Paid" /> : run.createdAt !== null ? <When at={run.createdAt} now={now} what="Drafted" /> : <span className="po-quiet">Not recorded.</span>,
          },
        };
      })}
    />
  );
}

export interface PayoutsViewProps {
  /** Who is reading: the owner sees every run and is given the actions; the public sees the paid runs. */
  audience: 'owner' | 'public';
  data: PayoutsData;
  /** The server's clock at render. */
  now: number;
  /** The path of the area: "/demo" or "/app". */
  base: string;
  /** What stands under each rail's facts and after the runs: the owner's actions. The public page says who can take them. */
  tempoActions?: ReactNode;
  solanaActions?: ReactNode;
  newRun?: ReactNode;
}

/**
 * The Payouts page: the two rails side by side, each with its key's state as
 * its chain reports it now, and under them the payout runs.
 */
export function PayoutsView({ audience, data, now, base, tempoActions, solanaActions, newRun }: PayoutsViewProps) {
  const open = audience === 'public';
  return (
    <div className="hf-stack po-page">
      <SectionHeading
        level={1}
        size="page"
        title="Payouts"
        lead={
          open
            ? 'Contractors are paid in stablecoins through two keys the service holds. Each key has a limit its chain enforces. This page shows what each may still do, read from its chain now, and what was paid. Anyone can read it; nobody can change anything from it.'
            : 'Contractors are paid in stablecoins through two keys the service holds. Each key has a limit its chain enforces. This page shows what each may still do, read from its chain now, and is where you set those limits and pay a run.'
        }
      />

      <div className="po-rails">
        <TempoRailPanel rail={data.tempo} now={now}>
          {tempoActions ?? (
            <ReadOnly>Authorizing this key and revoking it are signed by the root key of the team&apos;s Tempo account, which stays with the treasurer. The owner does that in their workspace. Nothing on this page can.</ReadOnly>
          )}
        </TempoRailPanel>
        <SolanaRailPanel rail={data.solana} now={now}>
          {solanaActions ?? <ReadOnly>Approving the delegate for an amount and revoking it are transactions the team&apos;s Solana wallet signs. The owner does that in their workspace. Nothing on this page can.</ReadOnly>}
        </SolanaRailPanel>
      </div>

      <section className="po-runs" aria-labelledby="po-runs-title">
        <SectionHeading
          level={2}
          id="po-runs-title"
          title="Payout runs"
          rule
          lead={
            open
              ? 'A run is a list of payments made in one transaction on one rail. The public page lists the runs that were paid and does not name the payees; each run’s page links the receipts of its lines.'
              : 'A run is a list of payments made in one transaction on one rail. Newest first, with the state of each as the record has it.'
          }
        />
        {data.runs.status !== 'ok' ? (
          <GapNote gap={data.runs} now={now} />
        ) : data.runs.value.length === 0 ? (
          <p className="po-empty">{open ? 'No run of this treasury has been paid yet.' : 'No run has been drafted yet. Once a rail above shows a key that may pay, add the lines of the first run below.'}</p>
        ) : (
          <RunsLedger runs={data.runs.value} base={base} now={now} />
        )}
        {open && <ReadOnly>A run is drafted and paid by the owner of the treasury, signed in with the wallet of the team&apos;s Hyperliquid account. Each line of a paid run has a receipt the payee can open without an account.</ReadOnly>}
      </section>

      {newRun}
    </div>
  );
}
