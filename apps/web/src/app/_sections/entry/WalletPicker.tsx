'use client';

import { type ReactNode, useEffect, useState } from 'react';
import type { EvmConnection } from '@/client/evm';
import { useEvmWallet } from '@/client/hooks';
import { Button, Notice, Skeleton, shorten } from '@/ui';
import './entry.css';
import { FailureNotice } from './FailureNotice';

export interface WalletPickerProps {
  /** Why the wallet is needed here, as a sentence shown above the wallets found. */
  purpose: ReactNode;
  /** What is shown once a wallet is connected: the step that needs it. */
  children: (connection: EvmConnection, address: string) => ReactNode;
}

/**
 * The treasurer's EVM wallet for a step that needs it: the wallets this
 * browser has, connecting to one, and the account it shares. A browser with
 * no wallet is a state of its own, with what to install and why. A wallet
 * connected on an earlier visit is connected again without a prompt.
 */
export function WalletPicker({ purpose, children }: WalletPickerProps) {
  const wallet = useEvmWallet();
  // Wallets announce themselves once the page runs; until then nothing is known about them.
  const [looked, setLooked] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setLooked(true), 400);
    return () => window.clearTimeout(timer);
  }, []);

  if (wallet.status === 'connected' && wallet.connection !== null && wallet.address !== null) {
    return (
      <div className="en-wallet">
        <p className="en-wallet__line">
          <span className="hf-px">Wallet</span>
          <span>
            {wallet.wallet?.name ?? 'Browser wallet'}, account{' '}
            <span className="hf-num" title={wallet.address}>
              {shorten(wallet.address, 8, 6)}
            </span>
          </span>
          <Button variant="quiet" small onClick={() => void wallet.disconnect()}>
            Use another
          </Button>
        </p>
        {wallet.error !== null && <FailureNotice error={wallet.error} doing={{ title: 'Connecting', nothing: 'The wallet connected before is still the one in use.' }} />}
        {children(wallet.connection, wallet.address)}
      </div>
    );
  }

  if (!looked && wallet.wallets.length === 0) {
    return (
      <div className="en-wallet">
        <p>{purpose}</p>
        <Skeleton label="Looking for wallets in this browser" height={56} />
        <p className="hf-small">Looking for wallets in this browser.</p>
      </div>
    );
  }

  if (wallet.wallets.length === 0) {
    return (
      <div className="en-wallet">
        <p>{purpose}</p>
        <Notice kind="info" title="No wallet was found in this browser">
          <p>
            Signing here takes an EVM wallet, because the address that owns an organisation is the address of the team&rsquo;s Hyperliquid account. Install a wallet extension that holds that account&rsquo;s key, such as MetaMask or Rabby, or open this page in the browser of a wallet app, then reload.
          </p>
          <p className="hf-small">A hardware wallet works through such a wallet. The key never leaves it: this page only ever asks for signatures.</p>
        </Notice>
      </div>
    );
  }

  const connecting = wallet.status === 'connecting';
  return (
    <div className="en-wallet">
      <p>{purpose}</p>
      <ul className="en-wallet__list">
        {wallet.wallets.map((found) => (
          <li key={found.id}>
            <Button
              variant="secondary"
              busy={connecting && wallet.wallet?.id === found.id}
              disabled={connecting && wallet.wallet?.id !== found.id}
              onClick={() => {
                // The reason of a failure is kept in the wallet's state and shown below.
                wallet.connect(found).catch(() => undefined);
              }}
            >
              {/* The icon is the wallet's own data URI: drawn as an image, never as markup. */}
              {found.icon !== null && <img className="en-wallet__icon" src={found.icon} alt="" width={20} height={20} />}
              Connect {found.name}
            </Button>
          </li>
        ))}
      </ul>
      {connecting && (
        <p className="hf-small" role="status">
          Waiting for {wallet.wallet?.name ?? 'the wallet'}: approve the connection there. It shares the address of the account and nothing else.
        </p>
      )}
      {wallet.error !== null && !connecting && <FailureNotice error={wallet.error} doing={{ title: 'Connecting', nothing: 'No account was shared with this page.' }} />}
    </div>
  );
}
