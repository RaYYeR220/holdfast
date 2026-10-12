import { Panel, SectionHeading, Skeleton } from '@/ui';
import './payouts.css';

/** One rail while its chain is being read: the panel, and in it what is being asked of which chain. */
function RailLoading({ title, doing }: { title: string; doing: string }) {
  return (
    <Panel title={title} level={2} className="po-rail">
      <Skeleton height={128} label={doing} />
      <p className="po-loading">{doing}</p>
    </Panel>
  );
}

/** The Payouts page while its sources are being read. Nothing is shown in place of a figure that has not arrived. */
export function PayoutsLoading() {
  return (
    <div className="hf-stack po-page" aria-busy="true">
      <SectionHeading level={1} size="page" title="Payouts" lead="Each rail is read from its own chain when the page is opened, so this takes a few seconds. Nothing here is answered from memory." />
      <div className="po-rails">
        <RailLoading title="Tempo rail" doing="Asking Tempo’s Account Keychain what the access key may still do." />
        <RailLoading title="Solana rail" doing="Asking Solana’s Token program what allowance the delegate has left." />
      </div>
      <p className="po-loading">Then the payout runs, from the record.</p>
    </div>
  );
}

/** A run's page while the run is being read and looked up on its chain. */
export function RunLoading() {
  return (
    <div className="hf-stack po-page" aria-busy="true">
      <SectionHeading level={1} size="page" kicker="Payout run" title="Reading the run" lead="The run is read from the record and then looked up on its own chain, so this takes a few seconds." />
      <Panel title="On the record" level={2}>
        <Skeleton height={96} label="Reading the run" />
        <p className="po-loading">Reading the run, its lines and, on Solana, its marker.</p>
      </Panel>
    </div>
  );
}
