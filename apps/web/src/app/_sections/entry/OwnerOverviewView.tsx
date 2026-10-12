import type { Policy } from '@holdfast/core';
import { Button, CopyButton, DataTable, Link, Notice, Panel, SectionHeading, StateTag, Timestamp, Unavailable, shorten } from '@/ui';
import { OverviewBody, sourceName } from '../overview/OverviewBody';
import { STEP_TAG, advisoryShown, checklistCount } from './checklist';
import './entry.css';
import type { OwnerOverview } from './load';

export interface OwnerOverviewViewProps {
  data: OwnerOverview;
  policy: Policy;
  /** The server's clock at render. */
  now: number;
  /** The organisation was registered a moment ago: its new keys are shown first. */
  justRegistered?: boolean;
}

const KEY_NAME: Record<string, { name: string; where: string; href: string }> = {
  hl_agent: { name: 'Hyperliquid agent key', where: 'Lock', href: '/app/lock#agent' },
  tempo_access: { name: 'Tempo access key', where: 'Payouts', href: '/app/payouts' },
  solana_delegate: { name: 'Solana delegate', where: 'Payouts', href: '/app/payouts' },
  hl_attester: { name: 'Attester key on HyperEVM', where: 'Safety', href: '/app/safety' },
};

/**
 * What registering made: the service's own keys for the organisation, as
 * addresses. It is shown only while the chain shows none of them authorised,
 * which is what it says.
 */
function Registered({ data }: Pick<OwnerOverviewViewProps, 'data'>) {
  return (
    <Panel framed title="The organisation is registered" level={2}>
      <div className="en-flow">
        <p className="en-lead">The viewing key is stored encrypted, and from here on it is shown only as the address derived from it. The service has made four keys of its own for this organisation. These are their addresses.</p>
        <DataTable
          className="en-keys"
          caption="The keys the service made for this organisation"
          captionHidden
          columns={[
            { key: 'name', header: 'Key', rowHeader: true },
            { key: 'address', header: 'Address' },
            { key: 'where', header: 'Authorised on' },
          ]}
          rows={data.serviceKeys.map((serviceKey) => {
            const known = KEY_NAME[serviceKey.kind];
            return {
              id: serviceKey.kind,
              cells: {
                name: known?.name ?? serviceKey.kind,
                address: (
                  <CopyButton value={serviceKey.address} what={`address of the ${known?.name ?? 'key'}`}>
                    {shorten(serviceKey.address, 10, 8)}
                  </CopyButton>
                ),
                where: known === undefined ? '' : <Link href={known.href}>{known.where}</Link>,
              },
            };
          })}
        />
        <Notice kind="info" title="None of these keys can do anything yet">
          <p>Each has to be authorised by you, in your own wallet, on its chain: the steps below. After that it can do what was authorised and nothing more, and the limit is the chain&rsquo;s to enforce, not Holdfast&rsquo;s.</p>
        </Notice>
      </div>
    </Panel>
  );
}

function Advisories({ data, policy, now }: OwnerOverviewViewProps) {
  const { advisories } = data;
  if (advisories.status === 'unavailable') {
    return (
      <Panel title="What is asked of you" level={2}>
        <Unavailable reason={`${advisories.reason}; whether anything is asked of you cannot be worked out until it answers`} source={sourceName(advisories.source)} at={advisories.at} now={now} />
      </Panel>
    );
  }
  if (advisories.status === 'refused') {
    return (
      <Panel title="What is asked of you" level={2}>
        <Unavailable reason={advisories.reason} at={advisories.at} now={now} />
      </Panel>
    );
  }
  const { value } = advisories;
  if (value.advisories.length === 0) return null;
  return (
    <section className="en-advice" aria-labelledby="en-advice-title">
      <h2 className="hf-px en-advice__title" id="en-advice-title">
        Asked of you now
      </h2>
      <ul className="en-advice__list">
        {value.advisories.map((advisory) => {
          const shown = advisoryShown(advisory, policy, '/app');
          return (
            <li key={advisory.kind}>
              <Notice kind={shown.state === 'refused' ? 'refusal' : 'warning'} word={shown.word} title={shown.title} announce={false}>
                <p>{shown.text}</p>
                <p className="en-advice__foot">
                  <Button href={shown.href} variant="secondary" small>
                    {shown.action}
                  </Button>
                  <span className="hf-small en-asof">
                    Worked out from the venue as read <Timestamp at={value.readAt} now={now} />.
                  </span>
                </p>
              </Notice>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function Checklist({ data, now }: Pick<OwnerOverviewViewProps, 'data' | 'now'>) {
  const count = checklistCount(data.checklist);
  return (
    <Panel title="Setup: the five keys" level={2} aside={<span className="hf-small">{count.done} of {count.total} done{count.unknown > 0 ? `, ${count.unknown} not read` : ''}</span>}>
      <div className="en-check">
        <p className="hf-small en-check__lead">
          Each step gives the service one key over an account of yours, and each key is bounded by its chain, not by Holdfast. The states are what the chain or the venue showed as this page was made.
        </p>
        <ol className="en-check__list">
          {data.checklist.map((item, index) => {
            const tag = STEP_TAG[item.state];
            return (
              <li key={item.key} className="en-step" data-state={item.state}>
                <span className="en-step__no hf-px" aria-hidden="true">
                  {index + 1}
                </span>
                <div className="en-step__main">
                  <p className="en-step__head">
                    <span className="hf-px en-step__title">{item.title}</span>
                    <StateTag state={tag.state} label={tag.label} />
                  </p>
                  <p className="hf-small">
                    {item.detail}{' '}
                    {item.readAt !== null && (
                      <span className="en-asof">
                        {item.state === 'unknown' ? 'Tried' : 'Read'} <Timestamp at={item.readAt} now={now} show="relative" />
                        {item.source === null ? '' : `, source: ${sourceName(item.source)}`}.
                      </span>
                    )}
                  </p>
                </div>
                <p className="en-step__link">
                  <Link href={item.href} variant="emphasis">
                    {item.state === 'done' ? (item.key === 'viewing' ? item.action : 'See it') : item.action}
                  </Link>
                </p>
              </li>
            );
          })}
        </ol>
      </div>
    </Panel>
  );
}

/** The owner's overview: what is asked of the treasurer first, then the setup, then the treasury's figures. */
export function OwnerOverviewView({ data, policy, now, justRegistered = false }: OwnerOverviewViewProps) {
  // The note says that no key can act yet; it is not shown once the chain shows one that can.
  const noneAuthorised = data.checklist.every((item) => item.key === 'viewing' || item.state !== 'done');
  return (
    <div className="hf-stack en">
      <SectionHeading level={1} size="page" title="Overview" lead="What your treasury holds, how much of its dollar value is locked, and when each figure was read. Above it, what the service still needs from you and what it asks of you now." />
      {justRegistered && noneAuthorised && <Registered data={data} />}
      <Advisories data={data} policy={policy} now={now} />
      <Checklist data={data} now={now} />
      <OverviewBody overview={data.overview} journal={data.journal} failure={null} now={now} />
    </div>
  );
}
