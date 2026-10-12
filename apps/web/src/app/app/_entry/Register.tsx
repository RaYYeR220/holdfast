'use client';

import { type FormEvent, useEffect, useState } from 'react';
import { type Organisation, type ZcashTip, api } from '@/client/api';
import { type ClientError, toClientError } from '@/client/errors';
import { useAsyncAction } from '@/client/hooks';
import { Button, Input, Notice, Panel, Skeleton, Textarea, Timestamp, Unavailable, formatNumber } from '@/ui';
import { FailureNotice } from '../../_sections/entry/FailureNotice';
import { BIRTHDAY_MARGIN, type RegistrationErrors, SECRET_REFUSAL, isBirthdayRefusal, isKeyRefusal, readRegistration, suggestedBirthday } from '../../_sections/entry/register';

export interface RegisterProps {
  /** The address that is signed in, which will own the organisation. */
  address: string;
  /** Which Zcash the deployment reads, for what a viewing key of it looks like. */
  network: 'mainnet' | 'testnet';
}

type Tip = { status: 'loading' } | { status: 'ok'; tip: ZcashTip } | { status: 'failed'; error: ClientError };

/**
 * Registering an organisation for the address that is signed in: a name, the
 * treasury's viewing key, the height its scan starts at, and optionally what
 * the team spends a month. A spending key or a seed phrase pasted where the
 * viewing key belongs is stopped here, cleared, and sent nowhere.
 */
export function Register({ address, network }: RegisterProps) {
  const [name, setName] = useState('');
  const [key, setKey] = useState('');
  const [birthday, setBirthday] = useState('');
  const [monthlyBurn, setMonthlyBurn] = useState('');
  const [errors, setErrors] = useState<RegistrationErrors>({});
  /** The server's reason for refusing the viewing key; it names no key. */
  const [keyRefusal, setKeyRefusal] = useState<string | null>(null);
  const [tip, setTip] = useState<Tip>({ status: 'loading' });

  useEffect(() => {
    let wanted = true;
    api.zcashTip().then(
      (read) => {
        if (wanted) setTip({ status: 'ok', tip: read });
      },
      (error: unknown) => {
        if (wanted) setTip({ status: 'failed', error: toClientError(error, 'network') });
      },
    );
    return () => {
      wanted = false;
    };
  }, []);

  const creating = useAsyncAction(async (body: Parameters<typeof api.createOrg>[0]): Promise<Organisation> => api.createOrg(body));

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setKeyRefusal(null);
    const read = readRegistration({ name, birthday, monthlyBurn }, key);
    if (!read.ok) {
      setErrors(read.errors);
      // A secret is not kept on the page for a moment longer than it takes to refuse it.
      if (read.secret) setKey('');
      return;
    }
    setErrors({});
    const made = await creating.run(read.body);
    if (made === undefined) return;
    setKey('');
  };

  // A refusal that is about one field is shown at that field, and a refused key is never left in it.
  const failure = creating.status === 'failed' ? creating.error : null;
  const refusedKey = failure !== null && isKeyRefusal(failure);
  const refusedBirthday = failure !== null && isBirthdayRefusal(failure);
  useEffect(() => {
    if (!refusedKey || failure === null) return;
    setKeyRefusal(failure.message);
    setKey('');
  }, [refusedKey, failure]);

  // The organisation exists now. What is true of it is the server's to show: the page is loaded again, shell and all.
  const registered = creating.status === 'done';
  useEffect(() => {
    if (registered) window.location.assign('/app?registered=1');
  }, [registered]);

  if (registered) {
    return (
      <Panel framed title="The organisation is registered" level={2}>
        <div className="en-flow">
          <p className="en-lead" role="status">
            <strong>{creating.result.name}</strong> is registered. Reading its overview from the server.
          </p>
          <Skeleton label="Reading the overview" height={56} />
        </div>
      </Panel>
    );
  }

  const prefix = network === 'mainnet' ? 'uview1' : 'uviewtest1';
  return (
    <div className="en-register">
      <Panel framed title="Register the treasury" level={2}>
        <form className="en-flow" onSubmit={(event) => void submit(event)} noValidate>
          <p>
            Signed in as <span className="hf-num en-break">{address}</span>. The organisation will be owned by this address, which is also taken to be the team&rsquo;s Hyperliquid account.
          </p>

          <Input label="Name" hint="How the organisation is shown to you, and to a contractor on a receipt." name="name" value={name} onChange={(event) => setName(event.target.value)} maxLength={120} autoComplete="organization" {...(errors.name === undefined ? {} : { error: errors.name })} />

          <Textarea
            label="Unified full viewing key of the treasury"
            hint={`One word that starts with ${prefix}. It is sent to the server, stored encrypted, and never shown again.`}
            name="ufvk"
            value={key}
            onChange={(event) => {
              setKey(event.target.value);
              setKeyRefusal(null);
            }}
            rows={4}
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            {...(errors.ufvk !== undefined ? { error: errors.ufvk } : keyRefusal !== null ? { error: `The server refused it: ${keyRefusal}. The field has been cleared.` } : {})}
          />
          {(errors.ufvk === SECRET_REFUSAL || keyRefusal !== null) && (
            <Notice kind="refusal" title="Not a viewing key" announce={false}>
              <p>This is the product working: the only Zcash key Holdfast takes is one that cannot spend. Nothing that was pasted is kept on this page.</p>
            </Notice>
          )}

          <div className="en-birthday">
            <Input
              label="Birthday height"
              hint="The first block that can hold funds of this treasury. The scan starts there: an earlier payment is never seen, and a height that is too early only makes the first scan longer."
              name="birthday"
              inputMode="numeric"
              numeric
              value={birthday}
              onChange={(event) => setBirthday(event.target.value)}
              {...(errors.birthday !== undefined ? { error: errors.birthday } : refusedBirthday && failure !== null ? { error: `The server refused it: ${failure.message}.` } : {})}
            />
            <div className="en-tip">
              {tip.status === 'loading' && (
                <>
                  <Skeleton label="Reading the height of the chain" width={160} />
                  <p className="hf-small">Reading the height of the chain.</p>
                </>
              )}
              {tip.status === 'failed' && <Unavailable reason={`${tip.error.message}; no height can be suggested, so take the birthday from the treasury’s wallet`} source="Zcash" />}
              {tip.status === 'ok' && (
                <>
                  <p className="hf-small">
                    The chain is at block <span className="hf-num">{formatNumber(tip.tip.height)}</span>, read <Timestamp at={tip.tip.readAt} show="relative" />. A wallet shows the birthday of an existing treasury with its backup. For a treasury that has received nothing yet, the height now less {BIRTHDAY_MARGIN} blocks is early enough.
                  </p>
                  <Button variant="secondary" small onClick={() => setBirthday(String(suggestedBirthday(tip.tip.height)))}>
                    Use {formatNumber(suggestedBirthday(tip.tip.height))}
                  </Button>
                </>
              )}
            </div>
          </div>

          <Input
            label="Monthly burn in dollars (optional)"
            hint="What the team spends a month. It is used only to state runway in the books."
            name="monthlyBurn"
            inputMode="decimal"
            numeric
            value={monthlyBurn}
            onChange={(event) => setMonthlyBurn(event.target.value)}
            {...(errors.monthlyBurn === undefined ? {} : { error: errors.monthlyBurn })}
          />

          {failure !== null && !refusedKey && !refusedBirthday && <FailureNotice error={failure} doing={{ title: 'The registration', nothing: 'No organisation was created.' }} />}

          <div className="en-actions">
            <Button type="submit" busy={creating.status === 'pending'}>
              Register the organisation
            </Button>
            {creating.status === 'pending' && (
              <p className="hf-small" role="status">
                The server is checking the key and making the service&rsquo;s keys.
              </p>
            )}
          </div>
        </form>
      </Panel>

      <aside className="en-aside">
        <h2 className="hf-px">The viewing key</h2>
        <ul className="en-lines">
          <li>A viewing key lets its holder read every payment into the treasury, with its amount and memo, the balance, and what the treasury itself sent. It cannot spend and cannot sign anything.</li>
          <li>Ywallet shows it on its Backup screen as the unified viewing key. In Zashi, and in any other wallet, it is the key the wallet exports for viewing, and never the recovery phrase.</li>
          <li>Whoever holds it sees the treasury. The service holds it, so whoever operates this server does; hosting the service yourself is the answer to that.</li>
        </ul>
        <h2 className="hf-px">What registering does</h2>
        <ul className="en-lines">
          <li>It stores the viewing key and makes four keys of the service&rsquo;s own. None of them can act until you authorise it on its chain.</li>
          <li>It switches nothing on. The lock stays off until you switch it on.</li>
        </ul>
      </aside>
    </div>
  );
}
