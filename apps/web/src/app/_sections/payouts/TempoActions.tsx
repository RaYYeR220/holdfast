'use client';

import { useRouter } from 'next/navigation';
import { type ReactNode, useState } from 'react';
import { type TempoAuthorizationRequest, api } from '@/client/api';
import { useAsyncAction, useTempoAccount } from '@/client/hooks';
import { type TempoRoot, authorizeTempoAccessKey, passkeysSupported, revokeTempoAccessKey } from '@/client/tempo';
import { Button, Checkbox, Dialog, ExternalTxLink, Input, KeyValue, Notice, Select, Skeleton, Textarea, formatUtc } from '@/ui';
import { type Terms, type TermsDraft, checkTerms, failureTold, limitWords } from './flow';
import { addressUrl } from './format';
import { Address } from './parts';
import { ToldNotice, Waiting } from './Told';
import { watched } from './watch';

type KeyState = 'no_account' | 'unavailable' | 'not_authorized' | 'revoked' | 'expired' | 'broader' | 'authorized';

export interface TempoActionsProps {
  org: { id: string; name: string; tempoAccount: string | null };
  /** The rail as the page above shows it; null when it could not be read. */
  rail: {
    chainId: number;
    token: { address: string; symbol: string; decimals: number };
    accessKey: string | null;
    keyState: KeyState;
    links: { before: string; after: string };
  } | null;
}

type Rail = NonNullable<TempoActionsProps['rail']>;

const PERIODS = [
  { value: '30', label: 'Every 30 days' },
  { value: '7', label: 'Every 7 days' },
  { value: '1', label: 'Every day' },
  { value: '90', label: 'Every 90 days' },
  { value: '0', label: 'Once, with no refill' },
];

const EXPIRIES = [
  { value: '90', label: 'In 90 days' },
  { value: '30', label: 'In 30 days' },
  { value: '180', label: 'In 180 days' },
  { value: '365', label: 'In 365 days' },
];

/** A step of a flow that is signed with the passkey and sent by the server. */
type Phase = 'checking' | 'signing' | 'submitting';

const PHASE_WORDS: Record<Phase, string> = {
  checking: 'Reading the rail and asking the server what there is to sign.',
  signing: 'Waiting for your passkey: confirm in the prompt your device shows.',
  submitting: 'Signed. The server is sending it to Tempo and waiting for the chain to include it.',
};

function TxLine({ tx, txUrl }: { tx: unknown; txUrl: unknown }) {
  if (typeof tx !== 'string' || tx === '') return null;
  return (
    <p>
      <ExternalTxLink chain="tempo" id={tx} {...(typeof txUrl === 'string' ? { href: txUrl } : {})} />
    </p>
  );
}

/** The team's Tempo account: the passkey that is its root, as this browser can or cannot use it. */
function AccountPart({ org, account, onChanged }: { org: TempoActionsProps['org']; account: ReturnType<typeof useTempoAccount>; onChanged: () => void }) {
  const [label, setLabel] = useState(`${org.name} payouts`);
  const create = useAsyncAction(async () => {
    await account.create(label.trim() === '' ? `${org.name} payouts` : label.trim());
    onChanged();
  });
  const link = useAsyncAction(async () => {
    await account.link();
    onChanged();
  });
  const recover = useAsyncAction(async () => {
    await account.recover();
    onChanged();
  });

  if (account.status === 'loading') return <Waiting>Looking in this browser for the passkey of the account.</Waiting>;

  if (account.status === 'ready') {
    return (
      <p>
        This browser holds the public key of the account&apos;s passkey, so it can ask your device to sign for the account. Each signature below is one passkey prompt. The passkey itself stays on your device; the service never holds it.
      </p>
    );
  }

  if (account.status === 'pending') {
    return (
      <>
        <Notice kind="warning" title="A passkey was made here, and its account is not recorded yet">
          <p>
            The passkey exists on your device, and its account is <Address value={account.address} what="Tempo account" />. Recording that address in the organisation&apos;s profile failed or was interrupted. Record it now; nothing is signed by this.
          </p>
        </Notice>
        <div className="po-row">
          <Button variant="primary" busy={link.status === 'pending'} onClick={() => void link.run()}>
            Record this account
          </Button>
        </div>
        {link.status === 'pending' && <Waiting>Recording the address of the account in the organisation&apos;s profile.</Waiting>}
        {link.status === 'failed' && <ToldNotice told={failureTold(link.error)} />}
      </>
    );
  }

  if (account.status === 'elsewhere') {
    return (
      <>
        <Notice kind="info" title="This browser cannot sign for the account">
          <p>
            The account <Address value={account.address} what="Tempo account" /> was made in another browser, or this one has lost what it kept of the passkey. Open this page in the browser that made it. Or find the passkey again here: your device offers the passkeys it holds for this site, and the one you pick is recognised by its signature.
          </p>
          <p>Finding it is one passkey prompt. It signs a random challenge and authorizes nothing.</p>
        </Notice>
        <div className="po-row">
          <Button variant="secondary" busy={recover.status === 'pending'} onClick={() => void recover.run()}>
            Find the passkey
          </Button>
        </div>
        {recover.status === 'pending' && <Waiting>Waiting for your device: pick the passkey of this account in the prompt it shows.</Waiting>}
        {recover.status === 'failed' && <ToldNotice told={failureTold(recover.error)} />}
      </>
    );
  }

  return (
    <>
      <p>
        The Tempo account is a passkey account. Its root key is a passkey your device makes and keeps: it never leaves the device, and the service never holds it. The address of the account is derived from the passkey. Everything that gives the service authority on this account, or takes it back, is signed with it.
      </p>
      {!passkeysSupported() ? (
        <Notice kind="warning" title="This browser cannot make a passkey">
          <p>Open this page in a browser with passkey support, on the device that should hold the root of the account.</p>
        </Notice>
      ) : (
        <>
          <Input label="Name of the passkey" hint="The name your device shows for it. It is not sent to the service." value={label} maxLength={64} onChange={(event) => setLabel(event.target.value)} disabled={create.status === 'pending'} />
          <p className="hf-small">Your device will ask you to create a passkey. That makes the account&apos;s root key and records the account&apos;s address in the organisation&apos;s profile. It authorizes nothing and pays nothing.</p>
          <div className="po-row">
            <Button variant="primary" busy={create.status === 'pending'} onClick={() => void create.run()}>
              Create the account with a passkey
            </Button>
          </div>
        </>
      )}
      {create.status === 'pending' && <Waiting>Waiting for your device to create the passkey. The address of the account is recorded as soon as it has.</Waiting>}
      {create.status === 'failed' && <ToldNotice told={failureTold(create.error)} />}
    </>
  );
}

interface KeyPartProps {
  org: TempoActionsProps['org'];
  rail: Rail;
  root: TempoRoot;
  /** Called with what to say once a step went through; the page is read again from the server after it. */
  onDone: (outcome: ReactNode) => void;
}

/** The bounds of the key as the treasurer sets them, the same bounds as the server will check them, and the signature. */
function AuthorizePart({ org, rail, root, onDone }: KeyPartProps) {
  const [draft, setDraft] = useState<TermsDraft>({ limit: '', periodDays: 30, expiryDays: 90, anyRecipient: false, recipients: '' });
  const [errors, setErrors] = useState<{ limit?: string; recipients?: string }>({});
  const [review, setReview] = useState<{ terms: Terms; expected: TempoAuthorizationRequest['expected'] } | null>(null);
  const [phase, setPhase] = useState<Phase>('checking');
  const { token } = rail;

  const prepare = useAsyncAction(async () => {
    const check = checkTerms(draft, token.decimals, Math.floor(Date.now() / 1000));
    if (!check.ok) {
      setErrors(check.errors);
      return;
    }
    setErrors({});
    const request = await api.tempoAuthorization(org.id, check.terms);
    setReview({ terms: check.terms, expected: request.expected });
  });

  const authorize = useAsyncAction(async (terms: Terms) => {
    setPhase('checking');
    const answer = await authorizeTempoAccessKey(
      watched(root, 'sign', () => setPhase('signing'), () => setPhase('submitting')),
      org.id,
      terms,
    );
    onDone(
      <ToldNotice
        told={
          answer.sent
            ? { kind: 'done', word: 'Authorized', title: 'The key is authorized on the terms you signed', body: ['The chain included the authorization. What the key may do now is read from the chain, above.'] }
            : { kind: 'info', word: 'Already held', title: 'The key already held exactly these terms; nothing was sent', body: ['The Account Keychain shows the key authorized on the bounds you signed.'] }
        }
      >
        <TxLine tx={answer.tx} txUrl={answer.txUrl} />
      </ToldNotice>,
    );
  });

  const busy = prepare.status === 'pending' || authorize.status === 'pending';
  const expected = review?.expected ?? null;

  return (
    <>
      <p>Choose the bounds. The chain holds the key to them on every transaction it signs, and the service cannot widen them. They are not changed afterwards: to change them you revoke the key and authorize a new one.</p>
      <div className="po-form">
        <Input
          label={`Spending limit in ${token.symbol}`}
          hint="The most the key can pay out in one period."
          numeric
          inputMode="decimal"
         
          value={draft.limit}
          onChange={(event) => setDraft({ ...draft, limit: event.target.value })}
          disabled={busy}
          {...(errors.limit === undefined ? {} : { error: errors.limit })}
        />
        <Select label="The limit refills" hint="When a period ends, what is left starts again at the limit." options={PERIODS} value={String(draft.periodDays)} onChange={(event) => setDraft({ ...draft, periodDays: Number(event.target.value) })} disabled={busy} />
        <Select label="The key expires" hint="After that the chain refuses everything it signs." options={EXPIRIES} value={String(draft.expiryDays)} onChange={(event) => setDraft({ ...draft, expiryDays: Number(event.target.value) })} disabled={busy} />
        <Textarea
          className="po-form__wide"
          label="Recipients the key may pay"
          hint="Tempo addresses, one to a line, at most 25. A payment to any other address is refused by the chain."
          rows={3}
          spellCheck={false}
          value={draft.recipients}
          onChange={(event) => setDraft({ ...draft, recipients: event.target.value })}
          disabled={busy || draft.anyRecipient}
          {...(errors.recipients === undefined ? {} : { error: errors.recipients })}
        />
        <Checkbox
          className="po-form__wide"
          label="Let the key pay any address"
          hint="The key then lists no recipients. The limit, the token and the expiry still hold."
          checked={draft.anyRecipient}
          onChange={(event) => setDraft({ ...draft, anyRecipient: event.target.checked })}
          disabled={busy}
        />
      </div>
      <div className="po-row">
        <Button variant="primary" busy={prepare.status === 'pending'} disabled={authorize.status === 'pending'} onClick={() => void prepare.run()}>
          Review the terms
        </Button>
        <span className="hf-small">Nothing is signed yet. The next step shows the terms as the server will check them.</span>
      </div>
      {prepare.status === 'pending' && <Waiting>Asking the server for the authorization these bounds describe.</Waiting>}
      {prepare.status === 'failed' && <ToldNotice told={failureTold(prepare.error)} />}
      {authorize.status === 'pending' && <Waiting>{PHASE_WORDS[phase]}</Waiting>}
      {authorize.status === 'failed' && (
        <ToldNotice told={failureTold(authorize.error)}>
          <TxLine tx={authorize.error.details.tx} txUrl={authorize.error.details.txUrl} />
          <p>The key is as the chain shows it above: nothing was authorized.</p>
        </ToldNotice>
      )}

      <Dialog
        open={review !== null}
        onClose={() => setReview(null)}
        title="What you are about to sign"
        closeLabel="Cancel"
        actions={
          <>
            <Button variant="quiet" onClick={() => setReview(null)}>
              Sign nothing
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                const terms = review?.terms;
                setReview(null);
                if (terms !== undefined) void authorize.run(terms);
              }}
            >
              Sign with the passkey
            </Button>
          </>
        }
      >
        {expected !== null && (
          <>
            <p>One authorization for the service&apos;s access key. These are its terms as the server will check them before it submits anything:</p>
            <KeyValue
              className="po-facts"
              items={[
                { label: 'Key let in', value: <Address value={expected.accessKeyAddress} href={addressUrl(rail.links, expected.accessKeyAddress)} what="access key" /> },
                { label: 'On account', value: <Address value={expected.rootAddress} href={addressUrl(rail.links, expected.rootAddress)} what="Tempo account" /> },
                {
                  label: 'May call',
                  value: (
                    <>
                      <code className="po-code">transferWithMemo</code> on {token.symbol} <Address value={expected.token} href={addressUrl(rail.links, expected.token)} what="token" />, and nothing else
                    </>
                  ),
                },
                { label: 'May spend', value: limitWords({ limit: BigInt(expected.limit), periodSeconds: expected.periodSeconds }, token) },
                {
                  label: 'May pay',
                  value:
                    expected.recipients === undefined || expected.recipients.length === 0 ? (
                      'Any address'
                    ) : (
                      <span className="po-list">
                        {expected.recipients.map((recipient) => (
                          <Address key={recipient} value={recipient} href={addressUrl(rail.links, recipient)} what="recipient" />
                        ))}
                      </span>
                    ),
                },
                { label: 'Stops working', value: formatUtc(expected.expiry * 1000) },
                { label: 'Valid on', value: `Tempo, chain ${expected.chainId}` },
              ]}
            />
            <p>
              <b className="po-strong">What the key will still be unable to do.</b> Spend more than the limit, call any other function or any other token, pay after the expiry or after you revoke it. The chain checks each of these on every transaction the key signs.
            </p>
            <p>
              <b className="po-strong">What happens when you sign.</b> Your passkey signs this authorization and nothing else. The service submits it in a transaction its own sponsor account pays for. That transaction also carries one transfer of zero through the new key, which the chain needs to take the key in. Nothing leaves your account.
            </p>
          </>
        )}
      </Dialog>
    </>
  );
}

/** Taking the key back: one call signed by the account's root, paid for by the service's sponsor. */
function RevokePart({ org, rail, root, onDone }: KeyPartProps) {
  const [confirming, setConfirming] = useState(false);
  const [phase, setPhase] = useState<Phase>('checking');

  const revoke = useAsyncAction(async () => {
    setPhase('checking');
    const answer = await revokeTempoAccessKey(
      watched(root, 'signTransaction', () => setPhase('signing'), () => setPhase('submitting')),
      org.id,
    );
    onDone(
      <ToldNotice told={{ kind: 'done', word: 'Revoked', title: 'The key is revoked', body: ['The chain shows the key revoked on this account. It can sign nothing here any more.'] }}>
        <TxLine tx={answer.tx} txUrl={answer.txUrl} />
      </ToldNotice>,
    );
  });

  return (
    <>
      <p>You can take the key back at any moment. From then on the chain refuses everything the service signs with it on this account. To change the key&apos;s bounds, revoke it and authorize a new key on the new bounds.</p>
      <div className="po-row">
        <Button variant="destructive" busy={revoke.status === 'pending'} onClick={() => setConfirming(true)}>
          Revoke the access key
        </Button>
      </div>
      {revoke.status === 'pending' && (
        <Waiting>{phase === 'submitting' ? 'Signed. The server is sending the revocation and waiting until the chain shows the key revoked. That usually takes seconds, and at worst about two and a half minutes.' : PHASE_WORDS[phase]}</Waiting>
      )}
      {revoke.status === 'failed' && (
        <ToldNotice told={failureTold(revoke.error)}>
          <TxLine tx={revoke.error.details.tx} txUrl={revoke.error.details.txUrl} />
          <p>The key is as the chain shows it above. A prepared revocation is good for two minutes; starting again prepares a new one.</p>
        </ToldNotice>
      )}

      <Dialog
        open={confirming}
        onClose={() => setConfirming(false)}
        title="Revoke the access key"
        closeLabel="Cancel"
        actions={
          <>
            <Button variant="quiet" onClick={() => setConfirming(false)}>
              Keep the key
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                setConfirming(false);
                void revoke.run();
              }}
            >
              Revoke with the passkey
            </Button>
          </>
        }
      >
        <p>
          <b className="po-strong">What you sign.</b> One call from your Tempo account: <code className="po-code">revokeKey</code> on the Account Keychain, for the service&apos;s access key
          {rail.accessKey !== null && (
            <>
              {' '}
              <Address value={rail.accessKey} href={addressUrl(rail.links, rail.accessKey)} what="access key" />
            </>
          )}
          . One passkey prompt.
        </p>
        <p>
          <b className="po-strong">What it does.</b> The chain refuses everything that key signs on this account from then on. Payout runs on Tempo stop.
        </p>
        <p>
          <b className="po-strong">It cannot be undone.</b> A revoked key can never be authorized again. To pay through Tempo afterwards, the service makes the organisation a new key and you authorize that one.
        </p>
        <p>
          <b className="po-strong">What it costs you.</b> Nothing. The fee is paid by the service&apos;s sponsor account; your account pays nothing and needs to hold nothing.
        </p>
        <p className="hf-small">The revocation is prepared for the chain as it stands now and is good for two minutes. A prompt left open longer has to be started again.</p>
      </Dialog>
    </>
  );
}

/** After a revocation or an expiry: a fresh access key of the service's, for the treasurer to authorize. */
function NewKeyPart({ org, why, onDone }: { org: TempoActionsProps['org']; why: 'revoked' | 'expired'; onDone: (outcome: ReactNode) => void }) {
  const make = useAsyncAction(async () => {
    await api.newTempoAccessKey(org.id);
    onDone(<ToldNotice told={{ kind: 'done', word: 'New key', title: 'The organisation has a new access key', body: ['Its address is shown above. It can do nothing until you authorize it on the account.'] }} />);
  });
  return (
    <>
      <p>
        {why === 'revoked' ? 'The key was revoked, and a revoked key can never be authorized again.' : 'The key has expired and can sign nothing.'} To pay through Tempo again, have the service make the organisation a new access key. A new key can do nothing until you authorize it on this account, on the bounds you choose.
      </p>
      <div className="po-row">
        <Button variant="primary" busy={make.status === 'pending'} onClick={() => void make.run()}>
          Make a new key
        </Button>
        <span className="hf-small">Nothing is signed by this, and nothing changes on chain.</span>
      </div>
      {make.status === 'pending' && <Waiting>The service is making a new access key for the organisation.</Waiting>}
      {make.status === 'failed' && <ToldNotice told={failureTold(make.error)} />}
    </>
  );
}

/**
 * What the owner does on the Tempo rail: make the account with a passkey,
 * authorize the service's access key on bounds of their choosing, take it
 * back, and have a new key made after that. Each signature is the passkey's;
 * the page shows what is signed before it asks.
 */
export function TempoActions({ org, rail }: TempoActionsProps) {
  const router = useRouter();
  const account = useTempoAccount(org);
  // What the last step that went through said. It outlives the form it came from, which the fresh reading replaces.
  const [outcome, setOutcome] = useState<ReactNode>(null);
  const refresh = () => router.refresh();
  const done = (said: ReactNode) => {
    setOutcome(said);
    router.refresh();
  };
  const keyState = rail?.keyState ?? 'unavailable';
  const live = keyState === 'authorized' || keyState === 'broader';

  return (
    <div className="po-actions">
      <section className="po-action" aria-labelledby="po-tempo-account">
        <h3 id="po-tempo-account" className="po-action__title">
          {org.tempoAccount === null ? 'Create the Tempo account' : 'The passkey of the account'}
        </h3>
        <AccountPart org={org} account={account} onChanged={refresh} />
      </section>

      {keyState !== 'no_account' && (
        <section className="po-action" aria-labelledby="po-tempo-key">
          <h3 id="po-tempo-key" className="po-action__title">
            {rail === null || keyState === 'unavailable' ? 'The access key' : keyState === 'revoked' || keyState === 'expired' ? 'Make a new access key' : live ? 'Revoke the access key' : 'Authorize the access key'}
          </h3>
          {outcome}
          {rail === null || keyState === 'unavailable' ? (
            <>
              <p>The state of the key could not be read from Tempo, so nothing is offered here until it can. Nothing has changed on chain.</p>
              <div className="po-row">
                <Button variant="secondary" onClick={refresh}>
                  Read the chain again
                </Button>
              </div>
            </>
          ) : keyState === 'revoked' || keyState === 'expired' ? (
            <NewKeyPart org={org} why={keyState} onDone={done} />
          ) : account.status === 'loading' ? (
            <Skeleton label="Looking for the passkey" />
          ) : account.root === null ? (
            <p>{live ? 'Revoking' : 'Authorizing'} the key is signed with the passkey of the account, which this browser cannot use yet. See above.</p>
          ) : live ? (
            <RevokePart org={org} rail={rail} root={account.root} onDone={done} />
          ) : (
            <AuthorizePart org={org} rail={rail} root={account.root} onDone={done} />
          )}
        </section>
      )}
    </div>
  );
}
