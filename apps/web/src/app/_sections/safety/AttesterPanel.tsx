'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { type SentCall, registerAttester, waitForAttester } from '@/client/attestor';
import { sameAddress } from '@/client/evm';
import { useAsyncAction, useEvmWallet } from '@/client/hooks';
import { Button, KeyValue, Notice, StateTag, shorten } from '@/ui';
import { FailureNotice } from '../books/FailureNotice';
import { failureCopy } from '../books/failures';
import { hyperEvmUrl } from './links';
import { Address, OutLink } from './parts';

export interface AttesterPanelProps {
  orgId: string;
  /** The organisation's account, which has to send the transaction. */
  account: string;
  /** The service key to be named; null when the organisation has none. */
  attester: string | null;
  /** The HedgeAttestor contract and its chain; null where the deployment records no attestations. */
  contract: string | null;
  chainId: number | null;
  /** What the chain shows now: named, not named, or null when it could not be read. */
  registered: boolean | null;
}

/**
 * Naming the attester: one transaction from the organisation's own account
 * on HyperEVM, sent by the owner's wallet. The page states the call before
 * the wallet is asked, shows the transaction once it is sent, and waits for
 * the chain to show the key as named.
 */
export function AttesterPanel({ orgId, account, attester, contract, chainId, registered }: AttesterPanelProps) {
  const router = useRouter();
  const wallet = useEvmWallet();
  const [sent, setSent] = useState<SentCall | null>(null);

  const waiting = useAsyncAction(async () => {
    const shown = await waitForAttester(orgId);
    router.refresh();
    return shown;
  });
  const sending = useAsyncAction(async () => {
    if (wallet.connection === null) throw new Error('connect the wallet first');
    const call = await registerAttester(wallet.connection, orgId);
    setSent(call);
    void waiting.run();
    return call;
  });
  const connecting = useAsyncAction(wallet.connect);

  if (contract === null || chainId === null) return null;
  if (registered === true && sent === null) {
    return (
      <p className="hf-small sf-who">
        <StateTag state="locked" label="Nothing to do" /> The account has named this key. It stays named until the account names another.
      </p>
    );
  }
  if (attester === null) {
    return (
      <Notice kind="warning" title="There is no key to name">
        <p>The organisation has no attester key, so there is nothing for the account to name.</p>
      </Notice>
    );
  }

  const rightAccount = wallet.status === 'connected' && sameAddress(wallet.address, account);
  const failed = sending.status === 'failed' ? failureCopy(sending.error) : null;
  const unconfirmed = waiting.status === 'failed' ? failureCopy(waiting.error) : null;
  const txUrl = sent === null ? null : hyperEvmUrl(sent.chainId, 'tx', sent.hash);

  return (
    <div className="sf-steps">
      <h4 className="sf-act__name">Name the attester</h4>
      {registered === null && (
        <p className="hf-small">Whether the account has already named this key could not be read just now. Sending the call again when it has is harmless: it names the same key.</p>
      )}
      <p>
        This key can record snapshots for your account and cannot move anything. Naming it is one transaction from the account itself; the service cannot send it for you.
      </p>
      <KeyValue
        stacked
        items={[
          { label: 'Call', value: <span className="hf-num">setAttester({shorten(attester, 8, 6)})</span> },
          { label: 'To', value: <Address value={contract} what="contract address" /> },
          { label: 'On', value: `HyperEVM, chain ${chainId}. The wallet is asked to move to it first.` },
          { label: 'From', value: <Address value={account} what="account address" /> },
          { label: 'Cost', value: 'The gas of one transaction, in HYPE, paid by that account.' },
        ]}
      />

      {sent === null && wallet.wallets.length === 0 && (
        <Notice kind="info" title="No wallet was found in this browser">
          <p>The transaction has to come from the wallet of the team’s Hyperliquid account, the one that signed in. Open this page in the browser that has it.</p>
        </Notice>
      )}

      {sent === null && wallet.status !== 'connected' && wallet.wallets.length > 0 && (
        <div>
          <div className="sf-wallets">
            {wallet.wallets.map((found) => (
              <Button key={found.id} variant="secondary" busy={wallet.status === 'connecting' && wallet.wallet?.id === found.id} onClick={() => void connecting.run(found)}>
                Connect {found.name}
              </Button>
            ))}
          </div>
          {wallet.status === 'connecting' && (
            <p className="sf-act__said" role="status">
              Waiting for the wallet to share its account.
            </p>
          )}
          {wallet.error !== null && wallet.status !== 'connecting' && <FailureNotice failed={failureCopy(wallet.error)} className="sf-act__result" />}
        </div>
      )}

      {sent === null && wallet.status === 'connected' && !rightAccount && (
        <Notice kind="refusal" title="Another account is selected in the wallet" word="Stopped">
          <p>
            The wallet holds <span className="hf-num">{wallet.address === null ? 'no account' : shorten(wallet.address, 8, 6)}</span>. Only <span className="hf-num">{shorten(account, 8, 6)}</span>, the account of the organisation, can name its attester. Select that account in the wallet.
          </p>
        </Notice>
      )}

      {sent === null && rightAccount && (
        <div>
          <Button variant="primary" busy={sending.status === 'pending'} onClick={() => void sending.run()}>
            {sending.status === 'pending' ? 'Waiting for the wallet' : 'Name the attester'}
          </Button>
          {sending.status === 'pending' && (
            <p className="sf-act__said" role="status">
              The wallet is open. It asks to move to HyperEVM if it is on another chain, then to send the one call above. Check the contract address there against this page.
            </p>
          )}
        </div>
      )}

      {failed !== null && sent === null && <FailureNotice failed={failed} />}

      {sent !== null && (
        <div className="sf-act__result" role="status">
          <KeyValue
            stacked
            items={[
              {
                label: 'Sent',
                value:
                  txUrl === null ? (
                    <Address value={sent.hash} what="transaction hash" />
                  ) : (
                    <OutLink href={txUrl} label={`HyperEVM transaction ${shorten(sent.hash)} on the explorer`} title={sent.hash}>
                      HyperEVM {shorten(sent.hash)}
                    </OutLink>
                  ),
              },
            ]}
          />
          {waiting.status === 'pending' && <p className="sf-act__said">The wallet has sent it. Asking the chain every few seconds whether it shows the key as named; this can take up to a minute.</p>}
          {waiting.status === 'done' && (
            <Notice kind="info" title="The chain shows the key as named" word="Done" announce>
              <p>From the next tick that is due, the service can record snapshots for this account.</p>
            </Notice>
          )}
          {unconfirmed !== null && (
            <FailureNotice failed={unconfirmed}>
              <p>
                <Button variant="secondary" small busy={waiting.status === 'pending'} onClick={() => void waiting.run()}>
                  Ask the chain again
                </Button>
              </p>
            </FailureNotice>
          )}
        </div>
      )}
    </div>
  );
}
