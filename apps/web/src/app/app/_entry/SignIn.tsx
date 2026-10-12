'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import type { EvmConnection } from '@/client/evm';
import { useAsyncAction } from '@/client/hooks';
import { signIn } from '@/client/session';
import { Button, KeyValue, Link, Notice, Panel } from '@/ui';
import { FailureNotice } from '../../_sections/entry/FailureNotice';
import { WalletPicker } from '../../_sections/entry/WalletPicker';

/**
 * Signing in: connect the wallet of the team's Hyperliquid account, see the
 * address that is about to sign and what the message is for, and sign it.
 * The server answers the signed message with a session cookie, and the page
 * is then read again from the server.
 */
export function SignIn() {
  const router = useRouter();
  // Who is signed in is the server's to say, and it has said nobody is: the session is not asked for again here.
  const signing = useAsyncAction((connection: EvmConnection) => signIn(connection));
  const [host, setHost] = useState<string | null>(null);
  useEffect(() => setHost(window.location.host), []);

  // Once the server has opened the session, what this address may see is the server's to render.
  const done = signing.status === 'done';
  const refreshed = useRef(false);
  useEffect(() => {
    if (!done || refreshed.current) return;
    refreshed.current = true;
    router.refresh();
  }, [done, router]);

  return (
    <div className="en-signin">
      <Panel framed title="The treasurer’s wallet" level={2}>
        <div className="en-flow">
          <WalletPicker purpose="Connect the wallet that holds the team’s Hyperliquid account. That address owns the organisation: whoever signs in with it is the treasurer.">
            {(connection, address) => (
              <>
                <div className="en-terms">
                  <p className="hf-px">What you are about to sign</p>
                  <KeyValue
                    items={[
                      { label: 'Signs', value: <span className="hf-num en-break">{address}</span> },
                      { label: 'Message', value: 'A sign-in message for this site (EIP-4361), with a one-time challenge from the server that waits ten minutes.' },
                      { label: 'For', value: host === null ? 'this site' : <span className="hf-num">{host}</span> },
                      { label: 'It allows', value: 'A session of twelve hours in this browser, as the owner of the organisation registered to this address.' },
                      { label: 'It does not', value: 'Move funds, approve a key or send anything to a chain. It is a signature over text.' },
                    ]}
                  />
                </div>

                {signing.status === 'failed' && <FailureNotice error={signing.error} doing={{ title: 'Signing in', nothing: 'You are not signed in.' }} />}

                {done ? (
                  <Notice kind="info" word="Done" title="Signed in" announce>
                    <p>The session is open. The page is being read again for this address.</p>
                  </Notice>
                ) : (
                  <div className="en-actions">
                    <Button busy={signing.status === 'pending'} onClick={() => void signing.run(connection)}>
                      Sign in with this address
                    </Button>
                    {signing.status === 'pending' && (
                      <p className="hf-small" role="status">
                        The wallet is asking you to sign. Check that the message names {host ?? 'this site'} before you approve it.
                      </p>
                    )}
                  </div>
                )}
              </>
            )}
          </WalletPicker>
        </div>
      </Panel>

      <aside className="en-aside">
        <h2 className="hf-px">Before you sign in</h2>
        <ul className="en-lines">
          <li>Holdfast never asks for a spending key, a seed phrase or the key of this wallet. Everything that needs a root key is prepared here and signed in your own wallet.</li>
          <li>Signing in creates nothing. An address with no organisation is asked to register one: a name and the treasury&rsquo;s viewing key.</li>
          <li>
            The <Link href="/demo">public demo treasury</Link> shows every page of the application on a real mainnet treasury, without signing in.
          </li>
        </ul>
      </aside>
    </div>
  );
}
