import type { ReactNode } from 'react';
import type { SolanaRailShown, TempoRailShown } from '@/server/pages/payouts';
import { KeyPlate, KeyValue, type KeyValueItem, Panel, Plate, Stat, type State, Timestamp } from '@/ui';
import { sentence } from './flow';
import { addressUrl, chainName, formatSol, tokenAmount } from './format';
import type { Loaded } from './load';
import { Address, AsOf, Fact, GapNote, Moment, sourceName } from './parts';

/** A rail's state in words where there is no figure to show: what is true, and what follows from it. */
function Verdict({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="po-verdict">
      <p className="po-verdict__title hf-px">{title}</p>
      <div className="po-verdict__body">{children}</div>
    </div>
  );
}

/** The top of a rail's panel: the key drawn on its plate, and under it the first thing to read. */
function RailTop({ kind, label, children }: { kind: 'access' | 'delegate'; label: string; children: ReactNode }) {
  return (
    <>
      <Plate className="po-rail__plate">
        <KeyPlate kind={kind} label={label} className="po-rail__key" />
      </Plate>
      <div className="po-rail__lead">{children}</div>
    </>
  );
}

const TEMPO_TAG: Record<TempoRailShown['key']['state'], { state: State; label: string }> = {
  authorized: { state: 'locked', label: 'Key authorized' },
  not_authorized: { state: 'unlocked', label: 'Not authorized' },
  no_account: { state: 'unlocked', label: 'No account yet' },
  revoked: { state: 'refused', label: 'Key revoked' },
  expired: { state: 'limit', label: 'Key expired' },
  broader: { state: 'refused', label: 'Not a payout key' },
  unavailable: { state: 'stale', label: 'Unavailable' },
};

export interface RailPanelProps<T> {
  rail: Loaded<T>;
  /** The server's clock at render. */
  now: number;
  /** What stands under the facts: the owner's actions, or who can take them. */
  children?: ReactNode;
}

/**
 * The Tempo rail: the team's account, the service's access key, and what the
 * Account Keychain says that key may do now. Nothing here comes from the
 * database but the two addresses.
 */
export function TempoRailPanel({ rail, now, children }: RailPanelProps<TempoRailShown>) {
  if (rail.status !== 'ok') {
    return (
      <Panel title="Tempo rail" level={2} state="stale" stateLabel="Unavailable" className="po-rail">
        <RailTop kind="access" label="The Tempo access key, drawn as a key with a square bow">
          <GapNote gap={rail} now={now} />
        </RailTop>
        <div className="po-rail__rest">{children}</div>
      </Panel>
    );
  }
  const { key, token, account, accessKey, sponsor, links } = rail.value;
  const tag = TEMPO_TAG[key.state];

  const facts: KeyValueItem[] = [
    {
      label: 'Team account',
      value: account === null ? 'None yet.' : <Fact note="The account payouts leave from. Its root key stays with the treasurer.">{<Address value={account} href={addressUrl(links, account)} what="Tempo account" />}</Fact>,
    },
    {
      label: 'Access key',
      value:
        accessKey === null ? (
          'The organisation has none.'
        ) : (
          <Fact note="Held by the service. It signs the payouts; the chain checks each one against the bounds on this page.">
            <Address value={accessKey} href={addressUrl(links, accessKey)} what="access key" />
          </Fact>
        ),
    },
  ];
  if (key.state === 'authorized') {
    facts.push(
      {
        label: 'May call',
        value: (
          <Fact note="Any other function, and any other token, is refused by the chain.">
            <code className="po-code">transferWithMemo</code> on {token.symbol} <Address value={token.address} href={addressUrl(links, token.address)} what="token" />
          </Fact>
        ),
      },
      {
        label: 'May pay',
        value:
          key.recipients === null ? (
            'Any recipient. The key lists none.'
          ) : key.recipients.length === 0 ? (
            'Nobody. The key lists no recipient.'
          ) : (
            <Fact note={`${key.recipients.length === 1 ? 'The one address' : `The ${key.recipients.length} addresses`} the key lists. A payment to any other is refused by the chain.`}>
              <span className="po-list">
                {key.recipients.map((recipient) => (
                  <Address key={recipient} value={recipient} href={addressUrl(links, recipient)} what="recipient" />
                ))}
              </span>
            </Fact>
          ),
      },
      {
        label: 'Period ends',
        value: key.periodEnd === null ? 'There is no period: the limit was given once and does not refill.' : <Fact note="What is left then starts again at the full limit.">{<Moment at={key.periodEnd} now={now} />}</Fact>,
      },
      { label: 'Key expires', value: key.expiresAt === null ? 'It has no expiry.' : <Fact note="After that the chain refuses everything the key signs.">{<Moment at={key.expiresAt} now={now} />}</Fact> },
    );
  }
  if (key.state === 'broader') facts.push({ label: 'Key expires', value: key.expiresAt === null ? 'It has no expiry.' : <Moment at={key.expiresAt} now={now} /> });
  facts.push(
    {
      label: 'Fees',
      value: (
        <Fact note="The fee of every payout is paid by this account of the service. It is never taken from the key's limit.">
          {sponsor === null ? 'Paid by the sponsor account of the service.' : sponsor.status === 'ok' ? <Address value={sponsor.value} href={addressUrl(links, sponsor.value)} what="sponsor account" /> : <GapNote gap={{ source: sponsor.source, reason: sponsor.reason, at: sponsor.readAt }} now={now} inline />}
        </Fact>
      ),
    },
    { label: 'Network', value: `${chainName('tempo', rail.value.network)}, chain ${rail.value.chainId}` },
  );

  const left = key.state === 'authorized' ? tokenAmount(key.remaining, token) : null;
  return (
    <Panel title="Tempo rail" level={2} state={tag.state} stateLabel={tag.label} className="po-rail">
      <RailTop kind="access" label="The Tempo access key, drawn as a key with a square bow">
        {key.state === 'authorized' && left !== null && (
          <Stat
            key={key.readAt}
            size="large"
            state="locked"
            label={key.periodEnd === null ? 'Left of the limit' : 'Left in this period'}
            figure={left.figure}
            unit={left.unit}
            note="The most the service can still pay out through this key. The Account Keychain reports what is left, not the limit the key was given."
            asOf={key.readAt}
            now={now}
            source={sourceName('tempo')}
          />
        )}
        {key.state === 'no_account' && (
          <Verdict title="No Tempo account yet">
            <p>The organisation has not named a Tempo account. The access key below was made when the organisation was registered; it can pay nothing until an account authorizes it.</p>
          </Verdict>
        )}
        {key.state === 'not_authorized' && (
          <Verdict title="The key can pay nothing">
            <p>The Account Keychain of this account does not know the service&apos;s access key. Until the root of the account authorizes it, the chain refuses any payout the key signs.</p>
            <AsOf at={key.readAt} now={now} source="tempo" />
          </Verdict>
        )}
        {key.state === 'revoked' && (
          <Verdict title="The key was revoked">
            <p>The root of the account took the key back. The chain refuses everything it signs, and a revoked key cannot be authorized again.</p>
            <AsOf at={key.readAt} now={now} source="tempo" />
          </Verdict>
        )}
        {key.state === 'expired' && (
          <Verdict title="The key has expired">
            <p>
              Its authorization ran out <Timestamp key={key.expiredAt} at={key.expiredAt} now={now} />. The chain refuses everything it signs until the root of the account authorizes it again.
            </p>
            <AsOf at={key.readAt} now={now} source="tempo" />
          </Verdict>
        )}
        {key.state === 'broader' && (
          <Verdict title="Not a bounded payout key">
            <p>The key is live on this account, but it is not bounded the way a payout key is, so the service does not pay with it:</p>
            <ul className="po-bullets">
              {key.problems.map((problem) => (
                <li key={problem}>{sentence(problem)}</li>
              ))}
            </ul>
            <AsOf at={key.readAt} now={now} source="tempo" />
          </Verdict>
        )}
        {key.state === 'unavailable' && <Stat key={key.readAt} label="Left in this period" now={now} unavailable={{ reason: key.reason, source: sourceName(key.source), at: key.readAt }} />}
      </RailTop>
      <div className="po-rail__rest">
        <KeyValue items={facts} className="po-facts" />
        {children}
      </div>
    </Panel>
  );
}

const SOLANA_TAG: Record<SolanaRailShown['allowance']['state'], { state: State; label: string }> = {
  approved: { state: 'locked', label: 'Delegate approved' },
  nothing: { state: 'unlocked', label: 'Nothing approved' },
  no_wallet: { state: 'unlocked', label: 'No wallet yet' },
  unavailable: { state: 'stale', label: 'Unavailable' },
};

/**
 * The Solana rail: the team's wallet and its token account, the service key
 * approved as delegate on it, and what the Token program says that key may
 * still move.
 */
export function SolanaRailPanel({ rail, now, children }: RailPanelProps<SolanaRailShown>) {
  if (rail.status !== 'ok') {
    return (
      <Panel title="Solana rail" level={2} state="stale" stateLabel="Unavailable" className="po-rail">
        <RailTop kind="delegate" label="The Solana delegate, drawn as a key with a diamond bow">
          <GapNote gap={rail} now={now} />
        </RailTop>
        <div className="po-rail__rest">{children}</div>
      </Panel>
    );
  }
  const { allowance, token, owner, tokenAccount, delegate, delegateLamports, links } = rail.value;
  const tag = SOLANA_TAG[allowance.state];

  const facts: KeyValueItem[] = [
    {
      label: 'Team wallet',
      value: owner === null ? 'None yet.' : <Fact note="It owns the token account and approves the delegate. Its key stays with the treasurer.">{<Address value={owner} href={addressUrl(links, owner)} what="Solana wallet" />}</Fact>,
    },
    {
      label: `${token.symbol} account`,
      value:
        tokenAccount === null ? (
          'None to show without a wallet.'
        ) : (
          <Fact note={`The wallet's token account for ${token.symbol}. Payouts leave from here and from nowhere else.`}>
            <Address value={tokenAccount} href={addressUrl(links, tokenAccount)} what="token account" />
          </Fact>
        ),
    },
    {
      label: 'Delegate',
      value:
        delegate === null ? (
          'The organisation has none.'
        ) : (
          <Fact note="Held by the service. It moves at most the allowance, out of that one token account.">
            <Address value={delegate} href={addressUrl(links, delegate)} what="delegate" />
          </Fact>
        ),
    },
    {
      label: 'Delegate’s SOL',
      value:
        delegateLamports === null ? (
          'No key to hold any.'
        ) : delegateLamports.status !== 'ok' ? (
          <GapNote gap={{ source: delegateLamports.source, reason: delegateLamports.reason, at: delegateLamports.readAt }} now={now} />
        ) : (
          <Fact
            note={`${delegateLamports.value === 0n ? 'The key holds no SOL now, so it could not pay for a run. ' : ''}The service gives the key its SOL. It pays the fee of each run, the rent of the run marker and the rent of at most three new payee token accounts per run. The key holds no ${token.symbol}.`}
          >
            <span className="hf-num">{formatSol(delegateLamports.value)}</span> SOL <span className="po-fact__asof">as of <Timestamp key={delegateLamports.readAt} at={delegateLamports.readAt} now={now} show="relative" /></span>
          </Fact>
        ),
    },
    {
      label: 'Run marker',
      value: 'Each run sets a marker: a one-byte System account at an address derived from the delegate and the run. The System program allocates an account once, so the chain itself refuses a second payment of the same run.',
    },
    { label: 'Network', value: chainName('solana', rail.value.cluster) },
  ];

  const left = allowance.state === 'approved' ? tokenAmount(allowance.remaining, token) : null;
  return (
    <Panel title="Solana rail" level={2} state={tag.state} stateLabel={tag.label} className="po-rail">
      <RailTop kind="delegate" label="The Solana delegate, drawn as a key with a diamond bow">
        {allowance.state === 'approved' && left !== null && (
          <Stat
            key={allowance.readAt}
            size="large"
            state="locked"
            label="Allowance left"
            figure={left.figure}
            unit={left.unit}
            note="The most the service can still pay out through this key. It is a fixed amount, not a period: it only falls, until the wallet approves a new amount or revokes."
            asOf={allowance.readAt}
            now={now}
            source={sourceName('solana')}
          />
        )}
        {allowance.state === 'no_wallet' && (
          <Verdict title="No Solana wallet yet">
            <p>The organisation has not named a Solana wallet. The delegate key below was made when the organisation was registered; it can move nothing until a wallet approves it.</p>
          </Verdict>
        )}
        {allowance.state === 'nothing' && (
          <Verdict title="The key can pay nothing">
            <p>The Token program shows no allowance for the service key on this token account. No approval was given, or it was revoked, or it is spent. A transfer signed by the key is refused by the chain.</p>
            <AsOf at={allowance.readAt} now={now} source="solana" />
          </Verdict>
        )}
        {allowance.state === 'unavailable' && <Stat key={allowance.readAt} label="Allowance left" now={now} unavailable={{ reason: allowance.reason, source: sourceName(allowance.source), at: allowance.readAt }} />}
      </RailTop>
      <div className="po-rail__rest">
        <KeyValue items={facts} className="po-facts" />
        {children}
      </div>
    </Panel>
  );
}
