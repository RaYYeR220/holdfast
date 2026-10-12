import type { AuditModule, LedgerEntry, Statement } from '@holdfast/books';
import { lotsToZec } from '@holdfast/core';
import type { ReactNode } from 'react';
import type { CheckId, ReconciliationCheck } from '@/server/pages/books';
import type { Reading } from '@/server/reading';
import { type Chain, CopyButton, ExternalTxLink, Notice, Panel, Stat, StateTag, Swatch, Tick, Timestamp, Unavailable, WorstBars, formatBps, formatNumber, formatUsd, shorten } from '@/ui';
import { AsOf, OutLink } from '../safety/parts';
import { formatSignedUsd, formatUnits, formatZat, usdDigits } from './amounts';
import { CHECK_COPY, NOTHING_TO_COMPARE, SOURCE_NAME, type Verdict, agreementOf, ledgerRows, overallVerdict, realisedOnHedge, verdictOf } from './model';
import './books.css';

/**
 * The parts of the books that the workspace pages and the auditor's view
 * both show: the statement, the reconciliation and the ledger. Each takes
 * what the server read and renders it; none reads anything.
 */

const STALE_SOURCE: Record<string, string> = { journal: 'The journal', zcash: 'Zcash', hyperliquid: 'Hyperliquid', reference: 'The reference price' };

/** Why a section of a statement is missing: an auditor's scope leaves it out, or its source was last read too long ago. */
function whyMissing(statement: Statement, source: 'zcash' | 'hyperliquid', scoped: boolean): { reason: string; source: string } {
  if (scoped) {
    return {
      reason: 'a balance or a position is the sum of everything before it, so it is shown only to a link that covers this module from the first entry up to the present',
      source: 'the scope of this link',
    };
  }
  const stale = statement.stale.find((item) => item.source === source) ?? statement.stale.find((item) => item.source === 'journal');
  if (stale !== undefined) return { reason: stale.detail, source: STALE_SOURCE[stale.source] ?? stale.source };
  return { reason: source === 'zcash' ? 'the journal holds no treasury reading' : 'the journal holds no venue reading', source: 'the journal' };
}

const usd = (value: number): string => formatUsd(value, usdDigits(value));
const signedUsd = (value: number): string => formatSignedUsd(value, usdDigits(value));

/** A dollar figure, or the words that stand where one cannot be given. */
function Dollars({ value, signed = false, missing = 'No price on record' }: { value: number | null; signed?: boolean; missing?: string }) {
  if (value === null) {
    return (
      <span className="bk-none">
        <Swatch state="stale" /> {missing}
      </span>
    );
  }
  return <span className="hf-num">{signed ? signedUsd(value) : usd(value)}</span>;
}

export interface StatementPanelProps {
  statement: Statement;
  /** The ledger entries of the period, for the one figure the statement does not carry: what the hedge realised. */
  ledger: readonly LedgerEntry[];
  now: number;
  /** What the period is called: "All time", "October 2026", or an auditor's dates. */
  periodName: string;
  /** For an auditor's view: the modules the link covers. Left out on the workspace pages, which show every module. */
  modules?: readonly AuditModule[];
  /** For an auditor's view: whether the link covers every module from the first entry up to the present, which is what the figures that add everything together need. */
  whole?: boolean;
  /** Where the monthly burn is set, for the owner; the demo and an auditor are told only that none is set. */
  burnHref?: string;
  aside?: ReactNode;
}

/**
 * The statement: what is held now, what came in and went out in the period,
 * what the hedge made or cost, and how the value has moved since the lock.
 * A figure whose source is stale, or which lies outside an auditor's scope,
 * is shown as unavailable with the reason; it is never an older number.
 */
export function StatementPanel({ statement, ledger, now, periodName, modules, whole = true, burnHref, aside }: StatementPanelProps) {
  const { treasury, hedge, lock, receipts, payments, swapped, funding, fees, payouts } = statement;
  const scoped = modules !== undefined;
  const has = (module: AuditModule) => modules === undefined || modules.includes(module);
  const realised = realisedOnHedge(ledger);
  const unpriced = statement.unpriced.length;

  const flows: { id: string; label: string; note: string; own: ReactNode; dollars: ReactNode }[] = [];
  const outside = (
    <span className="bk-none">
      <Swatch state="stale" /> Outside this scope
    </span>
  );
  const zec = (zat: bigint, sign: '+' | '−' | '') => <span className="hf-num">{`${zat === 0n ? '' : sign}${formatZat(zat)} ZEC`}</span>;
  const counted = (n: number, one = 'payment', many = 'payments') => (n === 0 ? `No ${many}` : n === 1 ? `One ${one}` : `${n} ${many}`);

  flows.push(
    receipts === null
      ? { id: 'in', label: 'Came in', note: '', own: outside, dollars: null }
      : { id: 'in', label: 'Came in', note: counted(receipts.count), own: zec(receipts.zat, '+'), dollars: <Dollars value={receipts.usd} signed /> },
  );
  flows.push(
    payments === null
      ? { id: 'out', label: 'Sent from the treasury', note: '', own: outside, dollars: null }
      : { id: 'out', label: 'Sent from the treasury', note: counted(payments.count), own: zec(payments.zat, '−'), dollars: <Dollars value={payments.usd === null ? null : 0 - payments.usd} signed /> },
  );
  flows.push(
    swapped === null
      ? { id: 'swapped', label: 'Sent into swaps', note: '', own: outside, dollars: null }
      : { id: 'swapped', label: 'Sent into swaps', note: counted(swapped.count, 'deposit', 'deposits'), own: zec(swapped.zat, '−'), dollars: <Dollars value={swapped.usd === null ? null : 0 - swapped.usd} signed /> },
  );
  flows.push({
    id: 'network',
    label: 'Network fees',
    note: 'Paid in ZEC by the treasury’s own transactions',
    own: fees.networkZat === null ? outside : zec(fees.networkZat, '−'),
    dollars: fees.networkZat === null ? null : <Dollars value={fees.networkUsd === null ? null : 0 - fees.networkUsd} signed />,
  });
  flows.push({
    id: 'swapcost',
    label: 'Cost of swaps',
    note: 'Value sent into completed swaps, less value delivered',
    own: null,
    dollars: !has('swaps') ? outside : <Dollars value={fees.swapUsd === null ? null : 0 - fees.swapUsd} signed />,
  });
  flows.push(
    funding === null
      ? { id: 'funding', label: 'Funding on the short', note: '', own: null, dollars: outside }
      : {
          id: 'funding',
          label: 'Funding on the short',
          note: funding.count === 0 ? 'No payment' : funding.count === 1 ? 'One hourly payment' : `${funding.count} hourly payments, received less paid`,
          own: null,
          dollars: <Dollars value={funding.usd} signed />,
        },
  );
  flows.push({
    id: 'tradefees',
    label: 'Trading fees',
    note: 'Charged by Hyperliquid, less rebates',
    own: null,
    dollars: !has('hedge') ? outside : <Dollars value={fees.tradeUsd === null ? null : 0 - fees.tradeUsd} signed />,
  });
  if (funding !== null) {
    flows.push({
      id: 'realised',
      label: 'Realised on the hedge',
      note: realised.count === 0 ? 'Nothing was bought back, so nothing is realised' : realised.count === 1 ? 'One buy-back' : `${realised.count} buy-backs`,
      own: null,
      dollars: <Dollars value={realised.usd} signed />,
    });
  }
  flows.push(
    payouts === null
      ? { id: 'payouts', label: 'Paid out', note: '', own: outside, dollars: null }
      : {
          id: 'payouts',
          label: 'Paid out',
          note: payouts.count === 0 ? 'No payout line' : payouts.count === 1 ? 'One line' : `${payouts.count} lines`,
          own:
            payouts.byAsset.length === 0 ? null : (
              <span className="bk-assets">
                {payouts.byAsset.map((asset) => (
                  <span key={`${asset.chain}:${asset.asset}`} className="hf-num">
                    {`−${formatUnits(asset.amount, asset.decimals, 2)} ${asset.asset}`} <span className="bk-on">on {SOURCE_NAME[asset.chain as keyof typeof SOURCE_NAME] ?? asset.chain}</span>
                  </span>
                ))}
              </span>
            ),
          dollars: <Dollars value={payouts.usd === null ? null : 0 - payouts.usd} signed />,
        },
  );

  const treasuryMissing = treasury === null ? whyMissing(statement, 'zcash', scoped) : treasury.zat === null ? whyMissing(statement, 'zcash', false) : null;
  // A statement cut to a scope leaves the hedge out; one that is whole lacks it only when the venue reading is stale.
  const hedgeMissing = hedge === null ? whyMissing(statement, 'hyperliquid', scoped && !statement.stale.some((item) => item.source === 'hyperliquid')) : null;
  const drift = lock !== null && lock.driftUsd !== null && lock.unhedgedDriftUsd !== null ? { locked: lock.driftUsd, unlocked: lock.unhedgedDriftUsd } : null;

  return (
    <Panel framed title="Statement" level={2} aside={aside ?? <span className="bk-period hf-px">{periodName}</span>}>
      <div className="bk-held">
        {treasury !== null && treasury.zat !== null ? (
          <Stat
            label="Treasury, shielded"
            size="large"
            figure={formatZat(treasury.zat)}
            unit="ZEC"
            note={
              <>
                {treasury.usd !== null && treasury.px !== null ? `${usd(treasury.usd)} at ${formatUsd(treasury.px)} a ZEC.` : 'No current price to value it at.'}
                {treasury.untrackedZat !== null && treasury.untrackedZat > 0n && ` ${formatZat(treasury.untrackedZat)} ZEC of it arrived in a pool whose spends a viewing key cannot follow.`}
              </>
            }
            {...(treasury.asOf === null ? {} : { asOf: treasury.asOf, now, source: 'Zcash, by the latest tick' })}
          />
        ) : (
          <Stat label="Treasury, shielded" size="large" now={now} unavailable={{ reason: treasuryMissing?.reason ?? 'the balance could not be stated', source: treasuryMissing?.source ?? 'the journal' }} />
        )}
        {hedge !== null ? (
          <Stat
            label="Hedge account"
            figure={usd(hedge.accountValueUsd)}
            note={
              hedge.shortLots === 0
                ? 'No short is open.'
                : `Short ${formatNumber(lotsToZec(hedge.shortLots), 2)} ZEC, ${usd(hedge.notionalUsd)} at a mark of ${formatUsd(hedge.markPx)}.${hedge.marginRatioBps === null ? '' : ` Margin ratio ${formatBps(hedge.marginRatioBps)}.`}`
            }
            asOf={hedge.asOf}
            now={now}
            source="Hyperliquid, by the latest tick"
          />
        ) : (
          <Stat label="Hedge account" now={now} unavailable={{ reason: hedgeMissing?.reason ?? 'the venue was not read', source: hedgeMissing?.source ?? 'the journal' }} />
        )}
        {statement.runwayMonths !== null && statement.monthlyBurnUsd !== null ? (
          <Stat label="Runway" figure={formatNumber(statement.runwayMonths, 1)} unit="months" note={`Everything held, in dollars, over a burn of ${formatUsd(statement.monthlyBurnUsd, 0)} a month.`} />
        ) : (
          <div className="hf-stat">
            <p className="hf-stat__label">Runway</p>
            <p className="bk-norunway">
              {scoped && !whole
                ? 'Runway adds every module together, so it is shown only to a link that covers them all from the first entry up to the present.'
                : statement.monthlyBurnUsd === null
                  ? 'No monthly burn is set for this treasury, so no runway is worked out.'
                  : statement.monthlyBurnUsd <= 0
                    ? 'The monthly burn is set to nothing, so there is no runway to work out.'
                    : 'The treasury and the venue were not both read recently enough to value what is held.'}
              {burnHref !== undefined && statement.monthlyBurnUsd === null && (
                <>
                  {' '}
                  <a className="hf-link" href={burnHref}>
                    Set it in Settings
                  </a>
                  .
                </>
              )}
            </p>
          </div>
        )}
      </div>

      <table className="bk-flows">
        <caption className="hf-px">
          In the period: <span className="bk-flows__period">{periodName}</span>
        </caption>
        <thead>
          <tr>
            <th scope="col">What</th>
            <th scope="col" className="bk-flows__num">
              In its own unit
            </th>
            <th scope="col" className="bk-flows__num">
              In dollars
            </th>
          </tr>
        </thead>
        <tbody>
          {flows.map((flow) => (
            <tr key={flow.id}>
              <th scope="row">
                <span className="bk-flows__label">{flow.label}</span>
                {flow.note !== '' && <span className="bk-flows__note">{flow.note}</span>}
              </th>
              <td className="bk-flows__num" data-label="In its own unit" {...(flow.own === null ? { 'data-empty': true } : {})}>
                {flow.own}
              </td>
              <td className="bk-flows__num" data-label="In dollars" {...(flow.dollars === null ? { 'data-empty': true } : {})}>
                {flow.dollars}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {unpriced > 0 && (
        <p className="hf-small bk-foot">
          A ZEC entry takes its dollar value from the price a tick recorded within the hour before it. {unpriced} {unpriced === 1 ? 'entry of this period has' : 'entries of this period have'} no such price, and a total that includes one is left without a dollar figure rather than given a guessed one.
        </p>
      )}

      {lock !== null && (
        <div className="bk-lock">
          <div>
            <h3 className="hf-px bk-lock__title">Since the lock</h3>
            <dl className="bk-lock__facts">
              <div>
                <dt>Locked</dt>
                <dd>
                  <Timestamp at={lock.lockedAt} now={now} />, by journal entry {lock.lockedSeq}
                </dd>
              </div>
              <div>
                <dt>Value at the lock</dt>
                <dd>
                  <Dollars value={lock.navAtLockUsd} missing="Not valued" />
                </dd>
              </div>
              <div>
                <dt>In and out on purpose since</dt>
                <dd>
                  <Dollars value={lock.externalFlowsUsd} signed missing="Includes an entry with no price" />
                </dd>
              </div>
              <div>
                <dt>Value now</dt>
                <dd>
                  <Dollars value={lock.navNowUsd} missing="No current reading" />
                </dd>
              </div>
            </dl>
          </div>
          <div className="bk-drift">
            <p className="hf-px bk-drift__title">Drift since the lock</p>
            {drift === null ? (
              <Unavailable reason="the value at the lock, the flows since or the value now is missing, so the drift cannot be stated" source="the journal and the ledger" />
            ) : (
              <>
                <WorstBars
                  scale={Math.max(Math.abs(drift.locked), Math.abs(drift.unlocked), 0.01)}
                  bars={[
                    { label: 'Locked', value: drift.locked, text: signedUsd(drift.locked), state: 'locked' },
                    { label: 'Unlocked', value: drift.unlocked, text: signedUsd(drift.unlocked), state: 'unlocked' },
                  ]}
                />
                <p className="hf-small">
                  Drift is the change in value that is not money arriving or leaving on purpose. “Unlocked” is the same holdings had none of them been hedged or sold for margin. The bars compare sizes; the sign is in the figure.
                </p>
              </>
            )}
          </div>
        </div>
      )}
      {statement.stale.length > 0 && (
        <Notice kind="warning" title="Some sources have no current reading" className="bk-stale">
          <ul>
            {statement.stale.map((item) => (
              <li key={item.source}>
                {STALE_SOURCE[item.source] ?? item.source}: {item.detail}.
              </li>
            ))}
          </ul>
          <p>Figures that rest on them are shown as unavailable above. Nothing older is shown in their place.</p>
        </Notice>
      )}
      <p className="sx-asof bk-asof">
        Statement drawn up <Timestamp at={statement.asOf} now={now} />
      </p>
    </Panel>
  );
}

const VERDICT: Record<Verdict, { state: 'locked' | 'refused' | 'limit' | 'unlocked'; word: string }> = {
  agrees: { state: 'locked', word: 'Agrees' },
  differs: { state: 'refused', word: 'Differs' },
  warned: { state: 'limit', word: 'Not settled' },
  nothing: { state: 'unlocked', word: 'Nothing to compare' },
};

export interface ReconciliationPanelProps {
  reconciliation: Reading<ReconciliationCheck[]>;
  now: number;
  /** Checks an auditor's scope leaves out, each with nothing but its name shown. */
  hidden?: readonly CheckId[];
}

/** Each check of the reconciliation: what was held against what, and whether the two agree. */
export function ReconciliationPanel({ reconciliation, now, hidden = [] }: ReconciliationPanelProps) {
  if (reconciliation.status !== 'ok') {
    return (
      <Panel title="Reconciliation" level={2} state="stale" stateLabel="Unavailable">
        <div className="bk-recon__gap">
          <Unavailable reason={reconciliation.reason} source={reconciliation.source} at={reconciliation.readAt} now={now} />
          <p className="hf-small">
            The reconciliation looks every payout run up on its chain. When one of those chains cannot be read there is no reconciliation at all: a check that skipped a run would read as agreement. The statement and the ledger do not depend on it.
          </p>
        </div>
      </Panel>
    );
  }
  const checks = reconciliation.value;
  const overall = VERDICT[overallVerdict(checks)];
  return (
    <Panel title="Reconciliation" level={2} state={overall.state} stateLabel={overall.word} flush>
      <ol className="bk-recon">
        {checks.map((check) => {
          const verdict = VERDICT[verdictOf(check)];
          const copy = CHECK_COPY[check.id];
          const agreement = agreementOf(check);
          return (
            <li key={check.id} className="bk-check" data-verdict={verdictOf(check)}>
              <div className="bk-check__head">
                <h3 className="hf-px">{copy.title}</h3>
                <StateTag state={verdict.state} label={verdict.word} />
              </div>
              <p className="bk-check__what">
                {copy.left}, held against {copy.right}.
              </p>
              {agreement !== null && (
                <p className="bk-check__found">
                  <Tick /> {agreement}
                </p>
              )}
              {agreement === null && check.problems.length === 0 && <p className="bk-check__found">{NOTHING_TO_COMPARE[check.id]}</p>}
              {check.problems.length > 0 && (
                <ul className="bk-check__problems">
                  {check.problems.map((problem, index) => (
                    <li key={`${problem.kind}:${index}`}>
                      <StateTag state={problem.severity === 'error' ? 'refused' : 'limit'} label={problem.severity === 'error' ? 'Differs' : 'Not settled'} />
                      <span>{problem.detail}.</span>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
        {hidden.map((id) => (
          <li key={id} className="bk-check" data-verdict="hidden">
            <div className="bk-check__head">
              <h3 className="hf-px">{CHECK_COPY[id].title}</h3>
              <StateTag state="stale" label="Outside this scope" />
            </div>
            <p className="bk-check__what">This check reads records the link does not cover, so its outcome is not shown.</p>
          </li>
        ))}
      </ol>
      <div className="bk-recon__foot">
        <AsOf source={reconciliation.source} at={reconciliation.readAt} now={now} verb="Held against each other from" />
      </div>
    </Panel>
  );
}

const CHAINS: readonly string[] = ['zcash', 'hyperliquid', 'tempo', 'solana'];

function ProofLink({ proof }: { proof: NonNullable<ReturnType<typeof ledgerRows>[number]['proof']> }) {
  if (CHAINS.includes(proof.chain)) {
    return <ExternalTxLink chain={proof.chain as Chain} id={proof.tx} {...(proof.url === null ? {} : { href: proof.url })} showChain={false} />;
  }
  if (proof.url === null) {
    return (
      <CopyButton value={proof.tx} what="transaction id">
        {shorten(proof.tx)}
      </CopyButton>
    );
  }
  return (
    <OutLink href={proof.url} label={`Transaction ${shorten(proof.tx)} on the explorer`} title={proof.tx}>
      {shorten(proof.tx)}
    </OutLink>
  );
}

export interface LedgerPanelProps {
  ledger: readonly LedgerEntry[];
  now: number;
  /** What an empty ledger means here: nothing has happened yet, or nothing falls in the period or the scope. */
  empty: string;
  /** Said under the table: what was left out of it and where the rest is. */
  note?: ReactNode;
  aside?: ReactNode;
}

/**
 * The ledger, newest first: when, where, what happened, the amount in its
 * own unit and in dollars, and the transaction to check it by. On a narrow
 * screen each entry is set out as a block of its own.
 */
export function LedgerPanel({ ledger, now, empty, note, aside }: LedgerPanelProps) {
  const rows = ledgerRows(ledger);
  return (
    <Panel title="Ledger" level={2} flush {...(aside === undefined ? {} : { aside })}>
      <div className="bk-ledger__wrap">
        {rows.length === 0 ? (
          <p className="bk-ledger__empty">{empty}</p>
        ) : (
          <table className="bk-ledger">
            <caption className="hf-sr">Ledger entries, newest first</caption>
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">Source</th>
                <th scope="col">What happened</th>
                <th scope="col" className="bk-ledger__num">
                  Amount
                </th>
                <th scope="col" className="bk-ledger__num">
                  Dollars
                </th>
                <th scope="col">Transaction</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td className="bk-ledger__when" data-label="When">
                    <Timestamp at={row.ts} now={now} show="absolute" />
                  </td>
                  <td className="bk-ledger__source hf-px" data-label="Source">
                    {SOURCE_NAME[row.source] ?? row.source}
                  </td>
                  <th scope="row" className="bk-ledger__what">
                    <span>{row.what}</span>
                    {row.payee !== null && <span className="bk-ledger__detail">To {row.payee}</span>}
                    {row.detail !== null &&
                      (row.detail.kind === 'text' ? (
                        <span className="bk-ledger__detail">“{row.detail.value}”</span>
                      ) : (
                        <span className="bk-ledger__ref hf-num" title={row.detail.value}>
                          {row.source === 'hyperliquid' ? 'Order ' : 'Ref. '}
                          {shorten(row.detail.value, 10, 6)}
                        </span>
                      ))}
                  </th>
                  <td className="bk-ledger__num" data-label="Amount">
                    <span className="hf-num">
                      {row.amount} {row.asset}
                    </span>
                  </td>
                  <td className="bk-ledger__num" data-label="Dollars">
                    {row.usd === null ? (
                      <span className="bk-none">
                        <Swatch state="stale" /> No price
                      </span>
                    ) : row.notional ? (
                      <span className="hf-num">{usd(Math.abs(row.usd))} notional</span>
                    ) : (
                      <span className="hf-num">{signedUsd(row.usd)}</span>
                    )}
                  </td>
                  <td className="bk-ledger__proof" data-label="Transaction">
                    {row.proof === null ? (
                      <span className="bk-ledger__noproof">{row.source === 'hyperliquid' ? 'Venue history, no transaction' : 'None on record'}</span>
                    ) : (
                      <ProofLink proof={row.proof} />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {note !== undefined && <div className="bk-ledger__note hf-small">{note}</div>}
    </Panel>
  );
}

/** What `holdfast verify` works out again from the chains, and what it says it takes on trust, in its own words. */
export function VerifyNotes() {
  return (
    <div className="bk-verify">
      <div>
        <h4 className="hf-px">It derives again</h4>
        <ul>
          <li>The journal’s chain of digests, entry by entry.</li>
          <li>The Zcash entries, from a scan of the chain with the viewing key.</li>
          <li>The fills and the funding, from the account’s history on Hyperliquid.</li>
          <li>The reconciliation, and the arithmetic of every total in the statement.</li>
        </ul>
        <p className="hf-small">It exits <span className="hf-num">0</span> only when every step ran and passed. Without a viewing key, or with <code className="hf-num">--offline</code>, the two chain steps are not run and the verdict is NOT VERIFIED. It verifies mainnet statements only.</p>
      </div>
      <div>
        <h4 className="hf-px">It takes on trust</h4>
        <ul>
          <li>That the journal is the only journal ever written. A journal root stored on HyperEVM is what answers that, and the tool does not make that comparison itself.</li>
          <li>That the address of the viewing key is the address the organisation is paid at.</li>
          <li>What a payment into a swap paid for: the chain shows the payment, and the swap service is not asked.</li>
          <li>The account value the journal recorded at each moment, which the venue cannot be asked for afterwards.</li>
          <li>The payout transfers on Tempo and Solana, which it holds against the statement’s own list without reading either chain.</li>
          <li>The dollar price applied to each ZEC entry, which is the ledger’s own.</li>
        </ul>
      </div>
    </div>
  );
}
