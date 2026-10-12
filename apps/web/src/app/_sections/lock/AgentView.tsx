import type { ReactNode } from 'react';
import type { LockPage } from '@/server/pages/lock';
import { CopyButton, Panel, StateTag, Timestamp, Unavailable, shorten } from '@/ui';
import { sourceName } from '../overview/OverviewBody';

export interface AgentViewProps {
  agent: LockPage['agent'];
  now: number;
  /** The owner's approval; without it the panel says who can approve. */
  approval?: ReactNode;
}

/**
 * The Hyperliquid agent key: the service's key for this treasury, whether
 * the venue shows it approved now, and what an approved agent can and cannot
 * do. The key is shown as its address and as nothing else.
 */
export function AgentView({ agent, now, approval }: AgentViewProps) {
  const read = agent.approval;
  return (
    <Panel
      title="Hyperliquid agent"
      level={2}
      {...(read.status === 'ok' ? { aside: read.value.approved ? <StateTag state="locked" label="Approved" boxed /> : <StateTag state="unlocked" label="Not approved" boxed /> } : {})}
    >
      <div className={approval === undefined ? 'lk-agent' : 'lk-agent lk-agent--owner'} id="agent">
        <div className="lk-agent__facts">
          {agent.address === null ? (
            <Unavailable reason="the organisation has no Hyperliquid agent key" source="the database" now={now} />
          ) : (
            <p>
              <span className="hf-px lk-agent__label">The service&rsquo;s key</span>{' '}
              <CopyButton value={agent.address} what="address of the agent key">
                {shorten(agent.address, 10, 8)}
              </CopyButton>
            </p>
          )}

          {read.status !== 'ok' ? (
            <Unavailable reason={read.reason} source={sourceName(read.source)} at={read.readAt} now={now} />
          ) : read.value.approved ? (
            <p className="hf-small">
              The venue lists this key among the agents of the account, under the name &ldquo;{agent.name}&rdquo;
              {read.value.validUntil === null ? '' : ', until '}
              {read.value.validUntil !== null && <Timestamp at={read.value.validUntil} show="absolute" />}. <span className="lk-asof">Read <Timestamp at={read.readAt} now={now} show="relative" />.</span>
            </p>
          ) : (
            <p className="hf-small">
              The venue does not list this key among the agents of the account, so the controller can place no order.
              {read.value.nameHeldBy === null ? '' : ` Another agent, ${shorten(read.value.nameHeldBy, 8, 6)}, holds the name “${agent.name}”; approving this key replaces it.`}{' '}
              <span className="lk-asof">Read <Timestamp at={read.readAt} now={now} show="relative" />.</span>
            </p>
          )}

          <dl className="lk-can">
            <div>
              <dt className="hf-px">
                <i className="hf-swatch hf-pat-locked" aria-hidden="true" />
                It can
              </dt>
              <dd>Place and cancel orders on the team&rsquo;s account, and switch its account mode.</dd>
            </div>
            <div>
              <dt className="hf-px">
                <i className="hf-swatch hf-pat-refused" aria-hidden="true" />
                It cannot
              </dt>
              <dd>Withdraw or transfer the team&rsquo;s funds. Hyperliquid applies a withdrawal or a transfer to the account of whoever signed it, and the agent&rsquo;s own account is empty.</dd>
            </div>
          </dl>
          {approval === undefined && <p className="hf-small lk-who">The owner of the account approves the key once, by signing in their own wallet. The service cannot approve itself.</p>}
        </div>
        {approval !== undefined && <div className="lk-agent__approval">{approval}</div>}
      </div>
    </Panel>
  );
}
