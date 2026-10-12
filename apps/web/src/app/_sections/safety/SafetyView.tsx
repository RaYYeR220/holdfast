import { Fragment, type ReactNode } from 'react';
import {
  ChainPlate,
  ExternalTxLink,
  KeyPlate,
  KeyValue,
  type KeyValueItem,
  Link,
  Notice,
  Panel,
  Plate,
  SectionHeading,
  Stat,
  StateTag,
  Swatch,
  Tag,
  Tick,
  Timestamp,
  Unavailable,
  formatNumber,
  formatUsd,
  hyperliquidAccountUrl,
  shorten,
} from '@/ui';
import { hyperEvmUrl, sourceName } from './links';
import { type KeyCard, NO_ATTEMPT, type RefusalCard, type SafetyData, type ScopeView, keyCards, refusalCards } from './model';
import { Address, AsOf, KeyPicture, OutLink } from './parts';
import './safety.css';

export interface SafetyViewProps {
  data: SafetyData;
  /** The server's clock at render. */
  now: number;
  /** Where the other sections of this workspace live: "/demo" or "/app". */
  base: string;
  /** The public demo is read only; the owner's page carries the actions. */
  audience: 'demo' | 'owner';
  /** The owner's panel that runs a probe. The demo passes none, and the page says who can. */
  probes?: ReactNode;
  /** The owner's panel that names the attester on HyperEVM. */
  attester?: ReactNode;
}

const PROOF_URL = 'https://github.com/RaYYeR220/holdfast/blob/main/docs/PROOF.md';
/** Refusals beyond this many are listed in a table under the slips. */
const SLIPS = 8;

/** A chain's answer such as `SpendingLimitExceeded` may break between its words on a narrow screen. */
function Breakable({ text }: { text: string }) {
  const parts = text.split(/(?<=[a-z])(?=[A-Z])/);
  return (
    <>
      {parts.map((part, index) => (
        <Fragment key={index}>
          {index > 0 && <wbr />}
          {part}
        </Fragment>
      ))}
    </>
  );
}

function Scope({ scope, now }: { scope: ScopeView; now: number }) {
  if (scope.status !== 'ok') return <Unavailable reason={scope.reason} source={sourceName(scope.source)} at={scope.at} now={now} />;
  const items: KeyValueItem[] = scope.lines.map((line) => ({
    label: line.label,
    value:
      'text' in line ? (
        line.text
      ) : 'figure' in line ? (
        <span className="sf-figure hf-px">{line.figure}</span>
      ) : 'time' in line ? (
        <Timestamp at={line.time} show="absolute" />
      ) : (
        <ul className="sf-list">
          {line.addresses.map((address) => (
            <li key={address}>
              <Address value={address} what="recipient address" />
            </li>
          ))}
        </ul>
      ),
  }));
  return (
    <>
      <p>
        <StateTag state={scope.state} label={scope.headline} boxed />
      </p>
      <KeyValue stacked items={items} />
      {scope.warnings.length > 0 && (
        <Notice kind="warning" title="Broader than the service accepts">
          <ul>
            {scope.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </Notice>
      )}
      <AsOf source={scope.source} at={scope.at} now={now} verb={scope.source === 'key format' ? 'Known from' : 'Read from'} />
    </>
  );
}

function KeyRing({ cards }: { cards: readonly KeyCard[] }) {
  return (
    <ul className="sf-ring">
      {cards.map((card) => (
        <li key={card.id} className="sf-ring__key">
          <Plate className="sf-ring__plate">
            <KeyPicture id={card.id} name={card.name} className="sf-ring__pic" />
          </Plate>
          <a className="sf-ring__name hf-px" href={`#key-${card.id}`} aria-label={`${card.name}, ${card.chain}: its bound, below`}>
            {card.name}
          </a>
          <span className="sf-ring__chain">{card.chain}</span>
          <span className="sf-ring__bound">{card.scope.status === 'ok' ? <StateTag state={card.scope.state} label={card.scope.headline} /> : <StateTag state="stale" label="Scope unavailable" />}</span>
        </li>
      ))}
    </ul>
  );
}

function KeyEntry({ card, now, audience, mainnet }: { card: KeyCard; now: number; audience: SafetyViewProps['audience']; mainnet: boolean }) {
  const facts: KeyValueItem[] = [];
  facts.push({
    label: card.address.label,
    value: card.address.value === null ? <span className="hf-small">{card.address.note}</span> : <Address value={card.address.value} what={`${card.name.toLowerCase()} address`} />,
  });
  facts.push({
    label: card.actsOn.label,
    value:
      card.actsOn.value === null ? (
        <span className="hf-small">{card.actsOn.missing}</span>
      ) : (
        <span className="sf-key__acct">
          <Address value={card.actsOn.value} what={card.id === 'viewing' ? 'treasury address' : 'account address'} head={card.id === 'viewing' ? 10 : 8} tail={card.id === 'viewing' ? 8 : 6} />
          {mainnet && (card.id === 'agent' || card.id === 'attester') && (
            <OutLink href={hyperliquidAccountUrl(card.actsOn.value)} label="The team’s account on the Hyperliquid explorer">
              Explorer
            </OutLink>
          )}
        </span>
      ),
  });

  return (
    <article className="sf-key" id={`key-${card.id}`} aria-labelledby={`key-${card.id}-name`}>
      <div className="sf-key__who">
        <h3 className="sf-key__name hf-px" id={`key-${card.id}-name`}>
          {card.name}
        </h3>
        <p className="sf-key__job">
          <Tag>{card.chain}</Tag> It {card.job}.
        </p>
        <KeyValue stacked items={facts} />
      </div>

      <dl className="sf-key__law">
        <div>
          <dt className="hf-px">
            <Tick /> Can
          </dt>
          <dd>{card.can}</dd>
        </div>
        <div>
          <dt className="hf-px">
            <Swatch state="refused" /> Cannot
          </dt>
          <dd>{card.cannot}</dd>
        </div>
        <div>
          <dt className="hf-px">Enforced by</dt>
          <dd>{card.enforcedBy}</dd>
        </div>
      </dl>

      <div className="sf-key__now">
        <p className="sf-key__nowhead hf-px">Its scope now</p>
        <Scope scope={card.scope} now={now} />
        <p className="sf-key__rec hf-small">
          {card.refusals > 0 ? (
            <>
              <Link href={`#refused-${card.id}`}>
                {card.refusals} {card.refusals === 1 ? 'refusal' : 'refusals'} on record
              </Link>{' '}
              for this key.
            </>
          ) : (
            (NO_ATTEMPT[card.id] ?? (
              <>
                No refusal of this key is on record here.
                {audience === 'owner' && (
                  <>
                    {' '}
                    <Link href="#probes">Make it try</Link>, and the answer is kept on this page.
                  </>
                )}
                {card.id === 'agent' && audience === 'demo' && (
                  <>
                    {' '}
                    The mainnet attempt, with the exchange’s answer, is written up in{' '}
                    <Link href={`${PROOF_URL}#3-hyperliquid-the-lock-and-the-agent-key-failing-to-withdraw`} external>
                      the proof, section 3
                    </Link>
                    .
                  </>
                )}
              </>
            ))
          )}
        </p>
      </div>
    </article>
  );
}

function Slip({ refusal, name, anchor, seed, now }: { refusal: RefusalCard; name: string | null; anchor: string | undefined; seed: number; now: number }) {
  const long = refusal.outcome.length > 40;
  return (
    <article className="sf-slip" {...(anchor === undefined ? {} : { id: anchor })}>
      <Plate className="sf-slip__plate">
        {refusal.key === null ? (
          <ChainPlate variant={seed} label="A chain pulled taut" className="sf-slip__pic" />
        ) : refusal.key === 'attester' ? (
          <KeyPicture id="attester" name="Attester key" className="sf-slip__pic" />
        ) : (
          <KeyPicture id={refusal.key} name={name ?? 'key'} refused seed={seed} className="sf-slip__pic" />
        )}
      </Plate>
      <div className="sf-slip__text">
        <p className="sf-slip__head hf-px">
          <span>
            {refusal.chainName}
            {name === null ? '' : `, ${name.toLowerCase()}`}
          </span>
          <span>
            <Swatch state="refused" /> Refused
          </span>
        </p>
        <h3 className="sf-slip__title">{refusal.title}</h3>
        <p className="sf-slip__tried">Tried: {refusal.attempted}</p>
        <p className={long ? 'sf-slip__answer sf-slip__answer--long hf-px' : 'sf-slip__answer hf-px'}>
          {refusal.reading === null ? (
            <>
              “<Breakable text={refusal.outcome} />”
            </>
          ) : (
            refusal.reading.answer
          )}
        </p>
        {refusal.reading !== null && (
          <p className="sf-slip__raw">
            {refusal.reading.where} As the node returned it: <code className="hf-num">{refusal.outcome}</code>
          </p>
        )}
        <p className="sf-slip__how">{refusal.how}</p>
        <p className="sf-slip__proof">
          {refusal.tx === null ? (
            <StateTag state="limit" label="No transaction" />
          ) : (
            <ExternalTxLink chain={refusal.tx.chain} id={refusal.tx.id} href={refusal.tx.url} />
          )}
          <span className="sf-slip__when">
            On record since <Timestamp at={refusal.at} now={now} />
          </span>
        </p>
      </div>
    </article>
  );
}

function AttesterFacts({ facts, attester, audience }: { facts: SafetyData['facts']; attester: string | null; audience: SafetyViewProps['audience'] }) {
  const contractUrl = facts.attestor === null ? null : hyperEvmUrl(facts.attestor.chainId, 'address', facts.attestor.contract);
  return (
    <div className="sf-evm__body">
      {facts.attestor === null ? (
        <Unavailable reason="this deployment records no attestations: it names no HedgeAttestor contract" source="configuration" />
      ) : (
        <KeyValue
          stacked
          items={[
            {
              label: 'Contract',
              value: (
                <span className="sf-key__acct">
                  <Address value={facts.attestor.contract} what="contract address" />
                  {contractUrl !== null && (
                    <OutLink href={contractUrl} label="HedgeAttestor on the HyperEVM explorer">
                      Explorer
                    </OutLink>
                  )}
                </span>
              ),
            },
            { label: 'Chain', value: `HyperEVM, chain ${facts.attestor.chainId}` },
            { label: 'Attester key', value: attester === null ? <span className="hf-small">The organisation has no attester key.</span> : <Address value={attester} what="attester address" /> },
            { label: 'Records for', value: <Address value={facts.hyperliquidAccount} what="account address" /> },
          ]}
        />
      )}
      <p className="hf-small">
        This key can record snapshots for the account and cannot move anything. In a snapshot, the position, the prices and the HyperCore block are read by the contract itself; the journal root, the number of entries and the treasury commitment are the attester’s own statements, which the contract cannot check.
      </p>
      {audience === 'demo' && (
        <p className="hf-small sf-who">Naming the attester is one transaction from the team’s own account on HyperEVM. Only the owner’s wallet can send it; there is nothing to press here.</p>
      )}
    </div>
  );
}

/**
 * The Safety page: every key the service holds with what it can and cannot
 * do, who enforces that and its scope as read now; every refusal on record;
 * and the attester with the latest snapshot of the hedge. The same view
 * serves the public demo and the owner, who adds the two panels that act.
 */
export function SafetyView({ data, now, base, audience, probes, attester }: SafetyViewProps) {
  const cards = keyCards(data);
  const refusals = refusalCards(data);
  const nameOf = (id: RefusalCard['key']) => (id === null ? null : (cards.find((card) => card.id === id)?.name ?? null));
  const { facts, attestation } = data;
  const mainnet = facts.network === 'mainnet';
  const seen = new Set<string>();
  const byChain = ['Tempo', 'Solana', 'Hyperliquid'].map((chain) => ({ chain, count: refusals.filter((refusal) => refusal.chainName === chain).length }));
  const attesterCard = cards.find((card) => card.id === 'attester');
  // An owner whose account has not named the attester is shown the call that names it, which takes the width of the section.
  const acting = attester !== undefined && facts.attestor !== null && !(attesterCard?.scope.status === 'ok' && attesterCard.scope.state === 'locked');
  const snapshot = attestation.status === 'ok' ? attestation.value : null;

  return (
    <div className="hf-stack hf-stack--loose sf">
      <SectionHeading
        level={1}
        size="page"
        title="Safety"
        lead="Every key the service holds for this treasury, what bounds it and who enforces the bound. Then every time a key was made to exceed its authority, with the chain’s own answer."
      />

      <Panel
        framed
        title="The keys the service holds"
        level={2}
        aside={
          <span className="sx-asof">
            Scopes read <Timestamp at={Math.max(...cards.map((card) => card.scope.at))} now={now} />
          </span>
        }
      >
        <KeyRing cards={cards} />
        <p className="sf-ring__foot">
          Four keys act on the team’s accounts, and none of them can move the team’s money beyond a limit the chain itself enforces. A fifth records snapshots and moves no money. The root keys stay with the treasurer, and whatever needs one of them is prepared here and signed in the treasurer’s own wallet.
        </p>
      </Panel>

      <section aria-labelledby="sf-keys">
        <SectionHeading
          id="sf-keys"
          title="Each key and its bound"
          lead="Each scope is read from its chain or venue when this page is opened. One that cannot be read says so; it is never filled in from memory."
        />
        <div className="sf-keys">
          {cards.map((card) => (
            <KeyEntry key={card.id} card={card} now={now} audience={audience} mainnet={mainnet} />
          ))}
        </div>
      </section>

      <section aria-labelledby="sf-refusals" id="refusals">
        <SectionHeading
          id="sf-refusals"
          title="What the keys were refused"
          lead="Each entry is a key of the service pointed at something it must never do, and what came back. An attempt on Tempo or Solana is a transaction the chain included and failed."
        />
        <div className="sf-rec">
          <Plate framed className="sf-rec__plate">
            <ChainPlate
              flat={refusals.length === 0}
              variant={refusals.length === 0 ? 2 : 0}
              label={refusals.length === 0 ? 'A level chain: nothing has pulled on it yet' : 'A chain pulled taut, at the moment of a refusal'}
              className="sf-rec__pic"
            />
          </Plate>
          <div className="sf-rec__text">
            <Stat
              size="large"
              label="Refusals on record"
              figure={formatNumber(refusals.length)}
              state={refusals.length === 0 ? 'unlocked' : 'refused'}
              note={
                refusals.length === 0
                  ? 'No key of this treasury has been made to try anything yet.'
                  : 'Kept as the chain or the venue returned them. Nothing here is a summary written afterwards.'
              }
            />
            <ul className="sf-rec__by">
              {byChain.map(({ chain, count }) => (
                <li key={chain}>
                  <span className="hf-px">{chain}</span>
                  <span className="hf-num">{count}</span>
                </li>
              ))}
            </ul>
            <p className="hf-small sf-rec__note">
              A refusal on Hyperliquid is the exchange’s answer to a signed request and leaves no transaction. On Zcash there is nothing to attempt: a viewing key has nothing to sign with.
            </p>
          </div>
        </div>

        <div className="sf-probes" id="probes">
          {probes ?? (
            <Notice kind="info" title="Who can make a key try">
              The owner of a treasury runs these attempts from this page, signed in with the wallet of the team’s Hyperliquid account: a withdrawal by the agent key, a payment over the Tempo limit, a call outside the Tempo key’s scope and a Solana transfer over the allowance. Each sends something the chain or venue must refuse and adds its answer to this record. The demo is read only, so there is nothing to press here.
            </Notice>
          )}
        </div>

        {refusals.length > 0 && (
          <div className="sf-slips">
            {refusals.slice(0, SLIPS).map((refusal, index) => {
              // The first slip of each key carries the anchor the key's own entry links to.
              const anchor = refusal.key !== null && !seen.has(refusal.key) ? `refused-${refusal.key}` : undefined;
              if (refusal.key !== null) seen.add(refusal.key);
              return <Slip key={refusal.id} refusal={refusal} name={nameOf(refusal.key)} anchor={anchor} seed={index * 13} now={now} />;
            })}
          </div>
        )}
        {refusals.length > SLIPS && (
          <Panel title="Earlier refusals" level={3} flush className="sf-earlier">
            <ul className="sf-earlier__list">
              {refusals.slice(SLIPS).map((refusal) => (
                <li key={refusal.id}>
                  <p className="hf-px">
                    {refusal.chainName}: {refusal.title}
                  </p>
                  <p className="hf-small">
                    {refusal.reading?.answer ?? `“${refusal.outcome}”`}. On record since <Timestamp at={refusal.at} now={now} />
                  </p>
                  <p>{refusal.tx === null ? <StateTag state="limit" label="No transaction" /> : <ExternalTxLink chain={refusal.tx.chain} id={refusal.tx.id} href={refusal.tx.url} />}</p>
                </li>
              ))}
            </ul>
          </Panel>
        )}
      </section>

      <section aria-labelledby="sf-snapshot" id="snapshot">
        <SectionHeading
          id="sf-snapshot"
          title="The hedge on HyperEVM"
          lead="HedgeAttestor stores what HyperCore reports for the team’s account beside the root of the controller’s journal. No snapshot can be changed or removed."
        />
        <div className={acting ? 'sf-evm sf-evm--act' : 'sf-evm'}>
          <Panel
            title="Attester"
            level={3}
            {...(attesterCard !== undefined && attesterCard.scope.status === 'ok' ? { state: attesterCard.scope.state, stateLabel: attesterCard.scope.headline } : { state: 'stale' as const, stateLabel: 'Unavailable' })}
          >
            <div className="sf-evm__attester">
              <AttesterFacts facts={facts} attester={attesterCard?.address.value ?? null} audience={audience} />
              {attester !== undefined && <div className="sf-evm__action">{attester}</div>}
            </div>
          </Panel>

          <Panel title="Latest snapshot" level={3} {...(snapshot !== null ? { aside: <Tag variant="solid">{`Series ${snapshot.series}, no. ${snapshot.number}`}</Tag> } : {})}>
            <div className="sf-evm__body">
              {attestation.status !== 'ok' ? (
                <Unavailable reason={attestation.reason} source={sourceName(attestation.source)} at={attestation.readAt} now={now} />
              ) : snapshot === null ? (
                <p>
                  The current series holds no snapshot yet. One is recorded after a tick{facts.attestor === null ? '' : `, no more often than every ${facts.attestor.everyMinutes} minutes`}, once the team’s account has named the attester.
                </p>
              ) : (
                <>
                  <div className="sf-snap">
                    <Stat size="small" label="Short" figure={formatNumber(snapshot.shortZec, 2)} unit="ZEC" note="As HyperCore reported it to the contract." />
                    <Stat size="small" label="Oracle price" figure={formatUsd(snapshot.oraclePx)} note="Read by the contract in the same transaction." />
                    <Stat size="small" label="Journal entries" figure={formatNumber(Number(snapshot.journalCount))} note="Under the root, as the attester stated." />
                  </div>
                  <KeyValue
                    stacked
                    items={[
                      { label: 'Recorded', value: <Timestamp at={snapshot.at} now={now} /> },
                      { label: 'Journal root', value: <Address value={snapshot.journalRoot} what="journal root" head={10} tail={8} /> },
                      {
                        label: 'Transaction',
                        value:
                          snapshot.tx === null ? (
                            <span className="hf-small">The service has no record of the transaction that recorded this snapshot.</span>
                          ) : hyperEvmUrl(snapshot.chainId, 'tx', snapshot.tx) === null ? (
                            <Address value={snapshot.tx} what="transaction hash" />
                          ) : (
                            <OutLink href={hyperEvmUrl(snapshot.chainId, 'tx', snapshot.tx) ?? ''} label={`HyperEVM transaction ${shorten(snapshot.tx)} on the explorer`} title={snapshot.tx}>
                              HyperEVM {shorten(snapshot.tx)}
                            </OutLink>
                          ),
                      },
                    ]}
                  />
                  <AsOf source={attestation.source} at={attestation.readAt} now={now} />
                </>
              )}
              <p className="sf-evm__more">
                <Link href={`${base}/lock`} variant="emphasis">
                  Check a journal entry against a snapshot’s root on the Lock page
                </Link>
              </p>
            </div>
          </Panel>
        </div>
      </section>

      <section aria-labelledby="sf-own" className="sf-own">
        <Plate className="sf-own__plate">
          <KeyPlate kind="spend" label="The outline of a key the service does not hold" className="sf-own__pic" />
        </Plate>
        <div>
          <h2 className="sf-own__title hf-px" id="sf-own">
            What the service does not hold
          </h2>
          <p>
            The Zcash spending key, the Hyperliquid owner wallet, the root of the Tempo account and the Solana wallet stay with the treasurer. A payment request, an agent approval, a key authorization, a delegate approval and a revocation are each prepared by the service and signed in the treasurer’s own wallet. Pasting a spending key or a seed phrase where a viewing key belongs is refused by its shape.
          </p>
        </div>
      </section>
    </div>
  );
}
