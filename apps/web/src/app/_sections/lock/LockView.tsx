import type { CSSProperties, ReactNode } from 'react';
import { CopyButton, KeyValue, type KeyValueItem, Link, Panel, SectionHeading, Stat, StateTag, Timestamp, Unavailable, formatBps, formatNumber, formatUsd, hyperliquidAccountUrl, shorten } from '@/ui';
import { ReadingGap, ReadingStat, ShareBar, sourceName } from '../overview/OverviewBody';
import { AgentView } from './AgentView';
import { BacktestView } from './BacktestView';
import { JournalView } from './JournalView';
import type { LockData } from './load';
import './lock.css';
import type { LockParams } from './params';
import { PolicyView } from './PolicyView';
import { PreviewView } from './PreviewView';
import { marginScale, shareOf } from './scale';
import { ProofView, SnapshotView } from './SnapshotView';
import { formatPx, fundingWords, lotsAsZec, lotsWords, standingWords } from './words';

/**
 * The Lock page of a treasury: the hedge as the venue shows it now, the
 * margin ratio against the policy, the policy itself, what a lock would
 * take, the agent key, the controller's journal and the snapshots the chain
 * holds. The public demo and the owner's page both render it; the owner's
 * page hands in its actions, and without them each place says who can act.
 */

export interface LockActions {
  /** Switches the lock on and off. */
  lockSwitch?: ReactNode;
  /** Edits the policy. */
  policyEditor?: ReactNode;
  /** Approves the agent key on the venue. */
  agentApproval?: ReactNode;
}

export interface LockViewProps {
  /** The area the page is in: "/demo" or "/app". */
  base: string;
  /** The server's clock at render. */
  now: number;
  data: LockData;
  params: LockParams;
  actions?: LockActions;
}

const signed = (usd: number): string => (usd > 0 ? `+${formatUsd(usd)}` : formatUsd(usd));

function LockNow({ data, now, action, owner }: { data: LockData; now: number; action: ReactNode; owner: boolean }) {
  const { overview, lock } = data;
  const { hedge, coverage } = overview;
  const position = lock.position;

  const facts: KeyValueItem[] = [];
  if (hedge.status === 'ok') {
    const short = hedge.value.shortLots;
    facts.push({
      label: 'Size',
      value:
        short > 0 ? (
          <>
            <span className="hf-num">{lotsAsZec(short)}</span> short, {lotsWords(short)}
          </>
        ) : short === 0 ? (
          'No short is open.'
        ) : (
          <>
            The account is long <span className="hf-num">{lotsAsZec(-short)}</span>. The controller holds while that is so.
          </>
        ),
    });
    if (short !== 0) {
      facts.push({
        label: 'Entry',
        value:
          position.status !== 'ok' ? (
            <Unavailable inline reason={position.reason} />
          ) : position.value === null ? (
            'The venue lists no position.'
          ) : (
            <span className="hf-num">{formatPx(position.value.entryPx)}</span>
          ),
      });
    }
    facts.push({
      label: 'Mark',
      value: (
        <>
          <span className="hf-num">{formatPx(hedge.value.markPx)}</span>, oracle <span className="hf-num">{formatPx(hedge.value.oraclePx)}</span>
        </>
      ),
    });
    if (short !== 0) {
      facts.push({
        label: 'Unrealised P&L',
        value:
          position.status !== 'ok' ? (
            <Unavailable inline reason={position.reason} />
          ) : position.value === null ? (
            'The venue lists no position.'
          ) : (
            <span className="hf-num">{signed(position.value.unrealizedPnlUsd)}</span>
          ),
      });
    }
    facts.push({ label: 'Account value', value: <span className="hf-num">{formatUsd(hedge.value.accountValueUsd)}</span> });
    if (position.status === 'ok' && position.value !== null && position.value.liquidationPx !== null) {
      facts.push({ label: 'Liquidation', value: <span className="hf-num">{formatPx(position.value.liquidationPx)}</span> });
    }
  }

  return (
    <Panel
      framed
      title="The lock now"
      level={2}
      aside={overview.lockEnabled ? <StateTag state="locked" label="Lock on" boxed /> : <StateTag state="unlocked" label="Lock off" boxed />}
      foot={action}
    >
      <div className="lk-now">
        <div className="lk-now__main">
          <ReadingStat
            label="Dollar value locked"
            size="large"
            reading={overview.locked}
            failure={null}
            now={now}
            show={(v) => ({
              figure: formatUsd(v.usd),
              note: v.lots > 0 ? `${formatNumber(v.zec, 2)} ZEC of the treasury is held against a short of ${lotsWords(v.lots)}, valued at the mark.` : 'No short is open, so no part of the treasury has its dollar value fixed.',
              state: v.lots > 0 ? 'locked' : 'unlocked',
            })}
          />
          <div className="lk-now__cover">
            {coverage.status !== 'ok' ? (
              <>
                <p className="hf-px">Coverage</p>
                <ReadingGap reading={coverage} failure={null} now={now} />
              </>
            ) : coverage.value.bps === null ? (
              <p className="hf-small">The policy calls for no short at this balance: the treasury does not cover one lot of 0.01 ZEC. There is nothing to cover.</p>
            ) : (
              <>
                <ShareBar label="Coverage" share={coverage.value.bps / 100} text={formatBps(coverage.value.bps)} />
                <p className="hf-small">
                  The short against what the policy calls for at this balance: {lotsWords(coverage.value.targetLots)}. <span className="lk-asof">Read <Timestamp at={coverage.readAt} now={now} show="relative" />.</span>
                </p>
              </>
            )}
          </div>
          <p className="hf-small lk-account">
            Account{' '}
            <CopyButton value={lock.account} what="address of the Hyperliquid account">
              {shorten(lock.account, 8, 6)}
            </CopyButton>{' '}
            <Link href={hyperliquidAccountUrl(lock.account)} external>
              on the explorer
            </Link>
          </p>
        </div>

        <div className="lk-now__side">
          <h3 className="hf-px lk-sub">{owner ? 'The short on your account' : 'The short on the team’s account'}</h3>
          {hedge.status !== 'ok' ? (
            <ReadingGap reading={hedge} failure={null} now={now} />
          ) : (
            <>
              <KeyValue items={facts} />
              <p className="hf-small lk-asof">
                as of <Timestamp at={hedge.readAt} now={now} />, from {sourceName(hedge.source)}
              </p>
            </>
          )}
        </div>
      </div>
    </Panel>
  );
}

const ZONE_FILL = { buyBack: 'hf-pat-refused', topUp: 'hf-t12', held: '' } as const;
const MARK_NAME = { floor: 'Buy-back floor', topUp: 'Top-up threshold', target: 'Target' } as const;

function Margin({ data, now }: { data: LockData; now: number }) {
  const { overview, lock } = data;
  const { policy } = lock;
  const ratio = overview.marginRatio;
  const scale = marginScale(policy, ratio.status === 'ok' ? ratio.value.bps : null);
  const words = standingWords(scale.standing, policy);
  const pointer = scale.pointer;
  const at = pointer === null ? 0 : shareOf(scale, pointer.bps);
  const rows = Math.max(...scale.marks.map((mark) => mark.row)) + 1;
  const described = `A scale of the margin ratio from 0% to ${formatBps(scale.maxBps, 0)}. Buy-back floor at ${formatBps(policy.deRiskTriggerBps)}, top-up threshold at ${formatBps(policy.topUpWarnBps)}, target at ${formatBps(policy.marginTargetBps)}.${
    pointer === null ? '' : ` The ratio now is ${formatBps(pointer.bps)}.`
  }`;

  return (
    <Panel title="Margin ratio against the policy" level={2} {...(ratio.status === 'ok' ? { aside: <StateTag state={words.state} label={words.label} boxed /> } : {})}>
      <div className="lk-margin">
        <div className="lk-margin__figure">
          <ReadingStat
            label="Account value over the size of the short"
            reading={ratio}
            failure={null}
            now={now}
            show={(v) => (v.bps === null ? { figure: 'No short' } : { figure: formatBps(v.bps) })}
          />
          {ratio.status === 'ok' && <p className="lk-margin__words">{words.text}</p>}
        </div>

        <div className="lk-margin__scale">
          <div className="lk-scale" role="img" aria-label={described} style={{ '--rows': rows } as CSSProperties}>
            <div className="lk-scale__above">
              {pointer !== null && (
                <span className="lk-scale__now hf-px" data-side={at > 70 ? 'end' : at < 30 ? 'start' : 'middle'} style={{ left: `${at.toFixed(2)}%` }}>
                  {pointer.clipped ? `Now ${formatBps(pointer.bps)}, beyond the scale` : `Now ${formatBps(pointer.bps)}`}
                </span>
              )}
            </div>
            <div className="lk-scale__track">
              {scale.zones.map((zone) => {
                const from = shareOf(scale, zone.fromBps);
                const to = shareOf(scale, zone.toBps);
                return to > from ? <i key={zone.key} className={`lk-scale__zone ${ZONE_FILL[zone.key]}`} style={{ left: `${from.toFixed(2)}%`, width: `${(to - from).toFixed(2)}%` }} /> : null;
              })}
              {scale.marks.map((mark) => (
                <b key={mark.key} className="lk-scale__mark" data-row={mark.row} style={{ left: `${shareOf(scale, mark.bps).toFixed(2)}%` }} />
              ))}
              {pointer !== null && <b className="lk-scale__needle" style={{ left: `${at.toFixed(2)}%` }} />}
            </div>
            <div className="lk-scale__below">
              <span className="lk-scale__end hf-num" data-end="start">
                0%
              </span>
              <span className="lk-scale__end hf-num" data-end="end">
                {formatBps(scale.maxBps, 0)}
              </span>
              {scale.marks.map((mark) => (
                <span key={mark.key} className="lk-scale__tick hf-px" data-row={mark.row} style={{ left: `${shareOf(scale, mark.bps).toFixed(2)}%` }}>
                  {formatBps(mark.bps, mark.bps % 100 === 0 ? 0 : 1)}
                </span>
              ))}
            </div>
          </div>

          <ul className="lk-legend">
            <li>
              <i className="hf-swatch hf-pat-refused" aria-hidden="true" />
              <span className="hf-px">{MARK_NAME.floor}</span>
              <span className="hf-num">{formatBps(policy.deRiskTriggerBps)}</span>
              <span className="lk-legend__text">Under it the controller buys back part of the short, down to what the margin carries at {formatBps(policy.deRiskRestoreBps)}.</span>
            </li>
            <li>
              <i className="hf-swatch hf-t12 lk-legend__dots" aria-hidden="true" />
              <span className="hf-px">{MARK_NAME.topUp}</span>
              <span className="hf-num">{formatBps(policy.topUpWarnBps)}</span>
              <span className="lk-legend__text">Under it the service asks the treasurer for margin back to the target. The treasurer pays it from their own wallet.</span>
            </li>
            <li>
              <i className="hf-swatch lk-legend__target" aria-hidden="true" />
              <span className="hf-px">{MARK_NAME.target}</span>
              <span className="hf-num">{formatBps(policy.marginTargetBps)}</span>
              <span className="lk-legend__text">What a fresh lock starts at and a top-up restores.</span>
            </li>
          </ul>
        </div>
      </div>
    </Panel>
  );
}

function Funding({ data, now }: { data: LockData; now: number }) {
  const { overview, lock } = data;
  const funding = overview.funding;
  const words = funding.status === 'ok' ? fundingWords(funding.value.aprBps, lock.policy) : null;
  return (
    <Panel title="Funding" level={2} {...(words?.underFloor === true ? { aside: <StateTag state="limit" label="Under the floor" boxed /> } : {})}>
      {funding.status !== 'ok' ? (
        <ReadingGap reading={funding} failure={null} now={now} />
      ) : (
        <div className="lk-funding">
          <Stat label={`Last ${lock.fundingWindowHours} hours, annualised`} figure={formatBps(funding.value.aprBps)} unit="a year" asOf={funding.readAt} now={now} source={sourceName(funding.source)} />
          <p>{words?.who}</p>
          <p className="hf-small">{words?.consequence}</p>
        </div>
      )}
    </Panel>
  );
}

export function LockView({ base, now, data, params, actions = {} }: LockViewProps) {
  const { lock } = data;
  const owner = actions.lockSwitch !== undefined;
  return (
    <div className="hf-stack lk">
      <SectionHeading
        level={1}
        size="page"
        title="Lock"
        lead={
          owner
            ? 'A short ZEC perpetual on your own Hyperliquid account, sized to the ZEC the treasury holds. The service trades it with an agent key that cannot withdraw. Margin is yours to add and to take back.'
            : 'A short ZEC perpetual on the team’s own Hyperliquid account, sized to the ZEC the treasury holds. Every figure is read now, from the venue, the journal and the chain.'
        }
      />

      <LockNow
        data={data}
        now={now}
        owner={owner}
        action={
          actions.lockSwitch ?? (
            <p>
              Only the owner of the treasury can switch the lock, signed in with the wallet of its Hyperliquid account. The switch records what the treasurer wants; the controller acts on it at its next tick.
            </p>
          )
        }
      />

      <Margin data={data} now={now} />

      {owner ? (
        <>
          <div className="hf-grid lk-chain">
            <Funding data={data} now={now} />
            <PreviewView preview={lock.preview} lockEnabled={lock.lockEnabled} now={now} owner={owner} base={base} />
          </div>
          <AgentView agent={lock.agent} now={now} approval={actions.agentApproval} />
        </>
      ) : (
        <div className="hf-grid lk-three">
          <Funding data={data} now={now} />
          <PreviewView preview={lock.preview} lockEnabled={lock.lockEnabled} now={now} owner={owner} base={base} />
          <AgentView agent={lock.agent} now={now} />
        </div>
      )}

      <div id="policy">
        <PolicyView policy={lock.policy} isDefault={lock.policyIsDefault} editor={actions.policyEditor} />
      </div>

      <JournalView base={base} now={now} journal={data.journal} snapshots={data.snapshots} params={params} />

      <div className="hf-grid lk-chain">
        <SnapshotView base={base} now={now} snapshots={data.snapshots} />
        <ProofView base={base} now={now} snapshots={data.snapshots} proof={data.proof} params={params} publicOrgId={data.org.publicDemo ? data.org.id : null} />
      </div>

      <BacktestView backtest={data.backtest} policyIsDefault={lock.policyIsDefault} />
    </div>
  );
}
