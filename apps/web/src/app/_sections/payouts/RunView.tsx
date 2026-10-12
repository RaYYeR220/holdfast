import type { ReactNode } from 'react';
import type { RunPageShown, RunShown } from '@/server/pages/payouts';
import { CopyButton, ExternalTxLink, KeyValue, type KeyValueItem, Link, Notice, Panel, SectionHeading, Stat, StateTag, Tag, Timestamp } from '@/ui';
import { sentence } from './flow';
import { RAIL_NAME, RUN_STATE, addressUrl, receiptPath, tokenAmount, tokenText } from './format';
import { Address, Fact, GapNote, Ledger, type LedgerColumn, type LedgerRow } from './parts';
import './payouts.css';

type Links = RunPageShown['links'];

function TxLink({ run }: { run: Pick<RunShown, 'chain' | 'tx' | 'txUrl'> }) {
  if (run.tx === null) return <>None. Nothing is on chain for this run.</>;
  return <ExternalTxLink chain={run.chain} id={run.tx} {...(run.txUrl === null ? {} : { href: run.txUrl })} />;
}

/** The marker of a Solana run: its address and whether the chain holds it, read now. */
function MarkerFact({ marker, paid, links, now }: { marker: NonNullable<RunPageShown['marker']>; paid: boolean; links: Links; now: number }) {
  if (marker.status !== 'ok') return <GapNote gap={{ source: marker.source, reason: marker.reason, at: marker.readAt }} now={now} />;
  const found = marker.value;
  if (found === null) return <>None to show: the organisation has no service key to derive it from.</>;
  const earlier = found.presentKey ? '' : ' It is derived from a service key the organisation paid with before its present one.';
  return (
    <Fact
      note={
        <>
          {found.set
            ? 'The chain holds it. The System program allocates an account once, so a second payment of this run fails as a whole.'
            : paid
              ? 'The chain holds no marker for this run: it was paid without one, as runs were before payouts carried markers. The rule of the System program does not cover it.'
              : 'Not set yet. The transaction that pays the run sets it, and the chain then refuses a second payment of the run.'}
          {earlier} Read <Timestamp key={marker.readAt} at={marker.readAt} now={now} show="relative" />.
        </>
      }
    >
      <span className="po-marker">
        <StateTag state={found.set ? 'locked' : 'unlocked'} label={found.set ? 'Set' : 'Not set'} />
        <Address value={found.address} href={addressUrl(links, found.address)} what="run marker" />
      </span>
    </Fact>
  );
}

/** What the run's chain holds under its id, beside the record. */
function OnChain({ run, onChain, now }: { run: RunShown; onChain: NonNullable<RunPageShown['onChain']>; now: number }) {
  if (onChain.status !== 'ok') {
    return (
      <Panel title="What the chain holds under this id" level={2} state="stale" stateLabel="Unavailable">
        <GapNote gap={{ source: onChain.source, reason: onChain.reason, at: onChain.readAt }} now={now} />
        <p className="po-note">The record above is what the database has. Whether the chain agrees with it could not be read just now.</p>
      </Panel>
    );
  }
  const found = onChain.value;
  const read = (
    <p className="hf-small po-asof">
      looked up <Timestamp key={onChain.readAt} at={onChain.readAt} now={now} />, on {RAIL_NAME[run.chain]}
    </p>
  );
  if (found === null) {
    return (
      <Panel title="What the chain holds under this id" level={2} state="unlocked" stateLabel="No payment">
        <p>
          {RAIL_NAME[run.chain]} holds no payment under the id {run.id}.
        </p>
        {read}
      </Panel>
    );
  }
  return (
    <Panel title="What the chain holds under this id" level={2} state={found.matchesRun ? 'locked' : 'refused'} stateLabel={found.matchesRun ? 'These lines' : 'Other lines'}>
      <div className="po-chain">
        <p>
          {found.matchesRun
            ? 'The chain holds the lines of this run under its id: the same payees and the same amounts, in the same order, in one transaction.'
            : 'The chain holds a payment under this id whose transfers are not the lines of this run.'}
        </p>
        <p>
          <ExternalTxLink chain={run.chain} id={found.tx} href={found.txUrl} />
        </p>
        {found.otherTxs.length > 0 && (
          <Notice kind="warning" title="Lines of this run are on chain more than once">
            <p>Further transactions carry the memos of this run:</p>
            <ul className="po-bullets">
              {found.otherTxs.map((tx) => (
                <li key={tx} className="hf-num">
                  {tx}
                </li>
              ))}
            </ul>
          </Notice>
        )}
        {read}
      </div>
    </Panel>
  );
}

type LineKey = 'line' | 'payee' | 'amount' | 'reference' | 'memo' | 'receipt';

function Lines({ run, audience, links, origin }: { run: RunShown; audience: 'owner' | 'public'; links: Links; origin: string }) {
  const paid = run.status === 'paid';
  const owner = audience === 'owner';
  // On Solana a line's reference is its memo on chain; on Tempo the memo is the run id and the line, and the reference is kept beside it.
  const separateReference = owner && run.chain === 'tempo';
  const columns: LedgerColumn<LineKey>[] = [
    { key: 'line', header: 'Line', rowHeader: true },
    ...(owner ? [{ key: 'payee', header: 'Payee', wide: true } satisfies LedgerColumn<LineKey>] : []),
    { key: 'amount', header: 'Amount', numeric: true },
    ...(separateReference ? [{ key: 'reference', header: 'Reference' } satisfies LedgerColumn<LineKey>] : []),
    { key: 'memo', header: owner && run.chain === 'solana' ? 'Reference and memo' : 'Memo on chain' },
    { key: 'receipt', header: 'Receipt', wide: true },
  ];
  const template = [
    '56px',
    ...(owner ? ['minmax(220px, 1.6fr)'] : []),
    'minmax(120px, 0.8fr)',
    ...(separateReference ? ['minmax(120px, 1fr)'] : []),
    'minmax(168px, 1.2fr)',
    'minmax(176px, 1fr)',
  ].join(' ');

  const rows: LedgerRow<LineKey>[] = run.lines.map((line) => {
    const amount = tokenAmount(line.amount, run.token);
    return {
      id: String(line.lineNo),
      cells: {
        line: (
          <span className="po-lineno">
            <span className="po-lineno__word">Line </span>
            {line.lineNo}
          </span>
        ),
        payee:
          line.payee === null ? null : (
            <span className="po-payee">
              <span>{line.payee.name}</span>
              <Address value={line.payee.address} href={addressUrl(links, line.payee.address)} what="payee address" />
            </span>
          ),
        amount: (
          <>
            {amount.figure} <span className="po-unit">{amount.unit}</span>
          </>
        ),
        reference: line.reference === null || line.reference === '' ? <span className="po-quiet">None given.</span> : line.reference,
        memo: line.memo === '' ? <span className="po-quiet">None: the line was given no reference.</span> : <span className="hf-num">{line.memo}</span>,
        receipt:
          line.receiptToken === null ? (
            <span className="po-quiet">None.</span>
          ) : paid ? (
            <span className="po-receipt">
              <Link href={receiptPath(line.receiptToken)}>Open the receipt</Link>
              <CopyButton value={`${origin}${receiptPath(line.receiptToken)}`} what={`link to the receipt of line ${line.lineNo}`} />
            </span>
          ) : (
            <span className="po-quiet">There is one once the run is paid.</span>
          ),
      },
    };
  });

  return <Ledger caption={`The lines of run ${run.id}`} columns={columns} rows={rows} template={template} className="po-lines" />;
}

export interface RunViewProps {
  /** Who is reading: the owner sees the payees and is given the actions; the public sees amounts, memos and receipts. */
  audience: 'owner' | 'public';
  page: RunPageShown;
  /** The server's clock at render. */
  now: number;
  /** The path of the area: "/demo" or "/app". */
  base: string;
  /** The address the pages are served from, for the receipt links that are copied and sent on. */
  origin: string;
  /** What stands between the record and the lines: for the owner, what paying the run would do and the button that pays it. */
  actions?: ReactNode;
}

/** One payout run: what it pays, where it stands, its lines with their receipts, and where it is on its chain. */
export function RunView({ audience, page, now, base, origin, actions }: RunViewProps) {
  const { run, onChain, marker, links } = page;
  const state = RUN_STATE[run.status];
  const paid = run.status === 'paid';
  const total = tokenAmount(run.total, run.token);
  const lines = `${run.lines.length} ${run.lines.length === 1 ? 'line' : 'lines'}`;

  const facts: KeyValueItem[] = [
    { label: 'Transaction', value: <TxLink run={run} /> },
    ...(run.paidAt === null ? [] : [{ label: 'Paid', value: <Timestamp at={run.paidAt} now={now} /> }]),
    ...(run.createdAt === null ? [] : [{ label: 'Drafted', value: <Timestamp at={run.createdAt} now={now} /> }]),
    ...(run.account === null ? [] : [{ label: 'Pays from', value: <Address value={run.account} href={addressUrl(links, run.account)} what={run.chain === 'tempo' ? 'Tempo account' : 'Solana wallet'} /> }]),
    {
      label: 'Token',
      value: (
        <>
          {run.token.symbol ?? 'Not recorded'} <Address value={run.token.address} href={addressUrl(links, run.token.address)} what="token" />
        </>
      ),
    },
    ...(marker === null ? [] : [{ label: 'Run marker', value: <MarkerFact marker={marker} paid={paid} links={links} now={now} /> }]),
  ];

  return (
    <div className="hf-stack po-page">
      <nav className="po-crumbs" aria-label="Where this page is">
        <Link href={`${base}/payouts`}>Payouts</Link>
        <span aria-hidden="true">/</span>
        <span aria-current="page">{run.id}</span>
      </nav>

      <SectionHeading
        level={1}
        size="page"
        kicker={`Payout run on ${RAIL_NAME[run.chain]}`}
        title={run.id}
        lead={
          paid
            ? `${lines}, paid in one transaction on ${RAIL_NAME[run.chain]}. Each line has a receipt its payee can open without an account.`
            : `${lines} to be paid in one transaction on ${RAIL_NAME[run.chain]}. ${state.meaning}`
        }
      />

      <div className="po-run">
        <Panel framed title="Total of the run" level={2} aside={<Tag variant="solid">{RAIL_NAME[run.chain]}</Tag>} state={state.fill} stateLabel={state.word}>
          <Stat size="large" label={paid ? 'Paid out' : 'To pay out'} figure={total.figure} unit={total.unit} note={`${lines}. ${state.meaning}`} {...(paid ? { state: 'locked' as const } : {})} />
          {run.error !== null && !paid && (
            <Notice kind={run.status === 'sending' ? 'warning' : 'refusal'} word={run.status === 'sending' ? 'Not settled' : run.status === 'failed' ? 'Failed' : 'Refused'} title="How the last attempt to pay ended" className="po-run__error">
              <p>{sentence(run.error)}</p>
            </Notice>
          )}
        </Panel>
        <Panel title="On the record" level={2}>
          <KeyValue items={facts} className="po-facts" />
        </Panel>
      </div>

      {actions}

      <section className="po-runs" aria-labelledby="po-lines-title">
        <SectionHeading
          level={2}
          id="po-lines-title"
          title="Lines"
          rule
          lead={
            audience === 'public'
              ? 'The public page does not name the payees. The addresses that were paid are in the transaction itself, on the chain. A demo treasury also publishes each line’s receipt here, the page a payee is sent: it shows the address that was paid and the payee’s reference.'
              : `Each line is one transfer of ${run.token.symbol ?? 'the token'}. ${paid ? 'Send each payee the link to their receipt.' : 'A line has a receipt once the run is paid.'}`
          }
        />
        <Lines run={run} audience={audience} links={links} origin={origin} />
        <p className="po-sum">
          <span className="hf-px">Total</span> <span className="hf-num">{tokenText(run.total, run.token)}</span>
        </p>
      </section>

      {onChain !== null && <OnChain run={run} onChain={onChain} now={now} />}
    </div>
  );
}

/** What a run's page shows when the reader has no run under that id. */
export function NoSuchRun({ runId, base, audience }: { runId: string; base: string; audience: 'owner' | 'public' }) {
  return (
    <div className="hf-stack po-page">
      <nav className="po-crumbs" aria-label="Where this page is">
        <Link href={`${base}/payouts`}>Payouts</Link>
        <span aria-hidden="true">/</span>
        <span aria-current="page">No such run</span>
      </nav>
      <SectionHeading level={1} size="page" kicker="Payout run" title="No such run" />
      <Notice kind="info" title="There is no run here">
        <p>
          {audience === 'public' ? 'The demo treasury has no paid run' : 'This treasury has no run'} under the id <span className="hf-num">{runId.slice(0, 40)}</span>. Run ids have the form HF-YYYY-MM-NNNN. <Link href={`${base}/payouts`}>The runs there are</Link> are listed on the Payouts page.
        </p>
      </Notice>
    </div>
  );
}
