import type { ReactNode } from 'react';
import type { SettingsFacts } from '@/server/pages/settings';
import { KeyValue, Link, Panel, SectionHeading, StateTag, Tag, Timestamp, Unavailable, formatNumber, formatUsd, hyperliquidAccountUrl } from '@/ui';
import { sourceName } from '../safety/links';
import { Address, OutLink } from '../safety/parts';
import { keyKind } from './model';
import './settings.css';

export interface SettingsViewProps {
  facts: SettingsFacts;
  /** The server's clock at render. */
  now: number;
  /** Where this workspace lives: "/demo" or "/app". */
  base: string;
  audience: 'demo' | 'owner';
  /** The owner's form for the name and the monthly burn. The demo passes none and says who can change them. */
  profile?: ReactNode;
  /** The owner's session, with the way out of it. */
  session?: ReactNode;
}

function Account({ chain, title, children }: { chain: string; title: string; children: ReactNode }) {
  return (
    <article className="st-acct">
      <header className="st-acct__head">
        <h3 className="hf-px">{title}</h3>
        <Tag>{chain}</Tag>
      </header>
      <div className="st-acct__body">{children}</div>
    </article>
  );
}

const NETWORK_NAME: Record<string, string> = { mainnet: 'Mainnet', testnet: 'Testnet' };

/**
 * The Settings page: what the organisation is called and what it spends,
 * the accounts it is tied to, the keys the service has made for it, and what
 * cannot be changed from here. The same view serves the public demo, which
 * changes nothing, and the owner.
 */
export function SettingsView({ facts, now, base, audience, profile, session }: SettingsViewProps) {
  const mainnet = facts.network === 'mainnet';
  const rails = [facts.rails.tempo === null ? null : `Tempo ${facts.rails.tempo}`, facts.rails.solana === null ? null : `Solana ${facts.rails.solana}`].filter((rail): rail is string => rail !== null);
  const active = facts.keys.filter((key) => key.status === 'active');
  const earlier = facts.keys.filter((key) => key.status !== 'active');
  const setOnPayouts = (what: string) =>
    audience === 'owner' ? (
      <>
        {what} <Link href={`${base}/payouts`}>Set it up on Payouts</Link>.
      </>
    ) : (
      <>{what}</>
    );

  return (
    <div className="hf-stack hf-stack--loose st">
      <SectionHeading level={1} size="page" title="Settings" lead="What this organisation is called, what it is tied to, and the keys the service holds for it. Most of it is fixed when the treasury is registered." />

      <Panel framed title="Organisation" level={2} aside={<Tag variant="solid">{NETWORK_NAME[facts.network] ?? facts.network}</Tag>}>
        <div className="st-org">
          <div className="st-org__now">
            <p className="st-org__name hf-px">{facts.name}</p>
            <KeyValue
              items={[
                { label: 'Monthly burn', value: facts.monthlyBurnUsd === null ? 'None set. The Books state no runway without one.' : <span className="hf-num">{`${formatUsd(facts.monthlyBurnUsd, Number.isInteger(facts.monthlyBurnUsd) ? 0 : 2)} a month`}</span> },
                { label: 'Registered', value: <Timestamp at={facts.createdAt} now={now} /> },
                {
                  label: 'Network',
                  value: `${NETWORK_NAME[facts.network] ?? facts.network}: the treasury is on Zcash ${facts.network} and the hedge on Hyperliquid ${facts.network}.${rails.length === 0 ? '' : ` Payouts go out on ${rails.join(' and ')}.`}`,
                },
                { label: 'Public demo', value: facts.publicDemo ? 'Yes. Anyone can read this organisation’s pages without signing in.' : 'No. Only the signed-in owner reads these pages.' },
              ]}
            />
          </div>
          <div className="st-org__edit">
            {profile ?? (
              <p className="st-who">
                The name and the monthly burn are changed by the owner of a treasury, signed in with the wallet of the team’s Hyperliquid account. The demo is read only, so there is nothing to edit here.
              </p>
            )}
          </div>
        </div>
      </Panel>

      <section aria-labelledby="st-accounts">
        <SectionHeading id="st-accounts" title="What it is tied to" lead="Four accounts of the team’s own. The service holds the root key of none of them." />
        <div className="st-accounts">
          <Account chain="Zcash" title="Treasury">
            {facts.treasury.status === 'ok' ? (
              <Address value={facts.treasury.value.address} what="treasury address" head={12} tail={8} />
            ) : (
              <Unavailable reason={facts.treasury.reason} source={sourceName(facts.treasury.source)} at={facts.treasury.readAt} now={now} />
            )}
            <p className="hf-small">
              The unified address the registered viewing key receives on. The key itself is never shown. Scanning starts at block <span className="hf-num">{formatNumber(facts.birthday)}</span>, the birthday given at registration
              {facts.scannedTo === null ? (
                ', and no tick has scanned the chain for this treasury yet.'
              ) : (
                <>
                  , and has reached block <span className="hf-num">{formatNumber(facts.scannedTo)}</span>.
                </>
              )}
            </p>
          </Account>
          <Account chain="Hyperliquid" title="Hedge account">
            <span className="st-acct__row">
              <Address value={facts.owner} what="Hyperliquid account address" />
              {mainnet && (
                <OutLink href={hyperliquidAccountUrl(facts.owner)} label="The account on the Hyperliquid explorer">
                  Explorer
                </OutLink>
              )}
            </span>
            <p className="hf-small">The team’s own account: it holds the margin and the short. It is also the address that owns this organisation and signs in to it.</p>
          </Account>
          <Account chain="Tempo" title="Payout account">
            {facts.tempoAccount === null ? <p>{setOnPayouts('None named yet.')}</p> : <Address value={facts.tempoAccount} what="Tempo account address" />}
            <p className="hf-small">The account stablecoin payouts on Tempo are paid from. Its root is a passkey on the treasurer’s device; the service holds an access key with a limit, once the account authorizes one.</p>
          </Account>
          <Account chain="Solana" title="Payout wallet">
            {facts.solanaOwner === null ? <p>{setOnPayouts('None named yet.')}</p> : <Address value={facts.solanaOwner} what="Solana wallet address" />}
            <p className="hf-small">The team’s wallet whose token account payouts on Solana are paid from. The service holds a delegate with a fixed allowance, once the wallet approves one.</p>
          </Account>
        </div>
      </section>

      <section aria-labelledby="st-keys">
        <SectionHeading
          id="st-keys"
          title="The service’s keys"
          lead="Made by the service for this organisation. Only addresses are shown: the secret half of each is stored encrypted and never leaves the server."
        />
        <Panel flush>
          {active.length === 0 ? (
            <p className="st-keys__empty">The service holds no key for this organisation.</p>
          ) : (
            <ul className="st-keys">
              {[...active, ...earlier].map((key) => {
                const copy = keyKind(key.kind);
                return (
                  <li key={`${key.kind}:${key.address}`} className="st-key">
                    <div className="st-key__what">
                      <p className="st-key__name hf-px">
                        {copy.name}
                        {copy.chain !== '' && <Tag>{copy.chain}</Tag>}
                      </p>
                      {copy.does !== '' && <p className="hf-small">{copy.does}</p>}
                    </div>
                    <div className="st-key__addr">
                      <Address value={key.address} what={`${copy.name.toLowerCase()} address`} />
                    </div>
                    <div className="st-key__when">
                      <StateTag state={key.status === 'active' ? 'locked' : 'unlocked'} label={key.status === 'active' ? 'In use' : 'Replaced'} />
                      <p className="hf-small">
                        On record since <Timestamp at={key.createdAt} show="absolute" />
                        {key.revokedAt !== null && (
                          <>
                            , replaced <Timestamp at={key.revokedAt} show="absolute" />
                          </>
                        )}
                      </p>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Panel>
        <p className="st-more">
          <Link href={`${base}/safety`} variant="emphasis">
            What each key can and cannot do, and what its chain says of it now, is on Safety
          </Link>
        </p>
      </section>

      <Panel inverse title="What cannot be changed here" level={2}>
        <dl className="st-fixed">
          <div>
            <dt className="hf-px">The owner</dt>
            <dd>
              The organisation belongs to the address of its Hyperliquid account, <span className="hf-num">{facts.owner}</span>. That address is who signs in, and the hedge trades on that account. Another account is another organisation: there is no transfer.
            </dd>
          </div>
          <div>
            <dt className="hf-px">The viewing key</dt>
            <dd>
              The viewing key is the treasury. It was checked when the organisation was registered, is stored encrypted, and is neither shown nor replaced afterwards. To watch another treasury, register another organisation with that treasury’s key.
            </dd>
          </div>
          <div>
            <dt className="hf-px">The network</dt>
            <dd>The network is a setting of the deployment, not of an organisation. Every organisation here is on {facts.network}.</dd>
          </div>
        </dl>
      </Panel>

      {session}
    </div>
  );
}
