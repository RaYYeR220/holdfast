'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef } from 'react';
import type { EvmConnection } from '@/client/evm';
import { useAsyncAction } from '@/client/hooks';
import { HYPERLIQUID_AGENT_NAME, approveHyperliquidAgent } from '@/client/hyperliquid';
import { Button, KeyValue, Notice } from '@/ui';
import { FailureNotice } from '../../_sections/entry/FailureNotice';
import { WalletPicker } from '../../_sections/entry/WalletPicker';

export interface AgentApprovalProps {
  orgId: string;
  /** The service's agent key for this organisation. */
  agentAddress: string;
  /** The organisation's Hyperliquid account, which has to sign. */
  account: string;
  /** Which Hyperliquid the deployment trades on. */
  network: 'mainnet' | 'testnet';
  /** Whether the venue showed the key approved as the page was made; null when that could not be read. */
  approved: boolean | null;
}

/**
 * Approving the agent key: what is about to be signed and what it allows,
 * the wallet of the account that has to sign it, and Hyperliquid's answer.
 * The typed data is rebuilt and checked on this side before the wallet is
 * opened; the server hands the signature to the venue.
 */
export function AgentApproval({ orgId, agentAddress, account, network, approved }: AgentApprovalProps) {
  const router = useRouter();
  const approving = useAsyncAction((connection: EvmConnection) => approveHyperliquidAgent(connection, orgId));

  // Once the venue has taken the approval, whether it lists the key is read again from the venue.
  const done = approving.status === 'done';
  const refreshed = useRef(false);
  useEffect(() => {
    if (!done || refreshed.current) return;
    refreshed.current = true;
    router.refresh();
  }, [done, router]);

  return (
    <div className="lk-flow">
      <div className="lk-terms">
        <p className="hf-px lk-sub">{approved === true ? 'Approving again' : 'What you are about to sign'}</p>
        <KeyValue
          items={[
            { label: 'Action', value: `An agent approval for Hyperliquid ${network}, as typed data in your wallet. It is not a transaction and costs nothing.` },
            { label: 'Agent', value: <span className="hf-num lk-break">{agentAddress}</span> },
            { label: 'Under the name', value: `“${HYPERLIQUID_AGENT_NAME}”. Approving a name replaces whichever agent held it.` },
            { label: 'Signed by', value: <span className="hf-num lk-break">{account}</span> },
            { label: 'It allows', value: 'The agent to place and cancel orders on this account and to switch its account mode.' },
            { label: 'It does not', value: 'Let the agent withdraw or transfer. Those act on the account of whoever signs them, and the agent’s own account is empty.' },
            { label: 'Expiry', value: 'None is asked for. The approval holds until the name is approved again for another agent.' },
          ]}
        />
      </div>

      {done ? (
        <Notice kind="info" word="Done" title="Hyperliquid accepted the approval" announce>
          <p>The venue is being asked again whether it lists the key.</p>
        </Notice>
      ) : (
        <WalletPicker purpose="Connect the wallet that holds the organisation’s Hyperliquid account. Hyperliquid applies an approval to whoever signed it, so nothing signed by another account is sent.">
          {(connection) => (
            <>
              {approving.status === 'failed' && <FailureNotice error={approving.error} doing={{ title: 'The approval', nothing: 'The agent is as it was: nothing was approved.' }} />}
              <div className="lk-action">
                <Button variant={approved === true ? 'secondary' : 'primary'} busy={approving.status === 'pending'} onClick={() => void approving.run(connection)}>
                  {approved === true ? 'Approve the agent again' : 'Approve the agent'}
                </Button>
                {approving.status === 'pending' && (
                  <p className="hf-small lk-action__text" role="status">
                    The wallet is showing the approval. Check the agent&rsquo;s address there against the one above before you sign.
                  </p>
                )}
              </div>
            </>
          )}
        </WalletPicker>
      )}
    </div>
  );
}
