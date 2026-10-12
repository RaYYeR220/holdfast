'use client';

import { useRouter } from 'next/navigation';
import { type ReactNode, useState } from 'react';
import { api } from '@/client/api';
import { useAsyncAction, useSolanaWallet } from '@/client/hooks';
import { type SolanaConnection, type SolanaSubmission, approveSolanaDelegate, revokeSolanaDelegate, waitForSolanaAllowance } from '@/client/solana';
import { Button, Dialog, ExternalTxLink, Input, KeyValue, Notice } from '@/ui';
import { failureTold } from './flow';
import { addressUrl, formatUnits, parseAmount } from './format';
import { Address } from './parts';
import { ToldNotice, Waiting } from './Told';
import { watched } from './watch';

export interface SolanaActionsProps {
  org: { id: string; solanaOwner: string | null };
  /** The rail as the page above shows it; null when it could not be read. */
  rail: {
    cluster: string;
    token: { address: string; symbol: string; decimals: number };
    tokenAccount: string | null;
    delegate: string | null;
    /** What the delegate may still move, in base units; null when it may move nothing or the chain could not be read. */
    remaining: string | null;
    allowanceState: 'no_wallet' | 'unavailable' | 'nothing' | 'approved';
    links: { before: string; after: string };
  } | null;
}

type Rail = NonNullable<SolanaActionsProps['rail']>;

/** A step of a flow the wallet signs and sends, and the chain then has to show. */
type Phase = 'preparing' | 'signing' | 'confirming';

function SentLine({ sent }: { sent: SolanaSubmission | null }) {
  if (sent === null) return null;
  return (
    <p>
      <ExternalTxLink chain="solana" id={sent.signature} href={sent.txUrl} />
    </p>
  );
}

function phaseWords(phase: Phase, what: string): string {
  if (phase === 'preparing') return `The server is preparing the ${what}, and the page is checking that it is what was asked for and nothing else.`;
  if (phase === 'signing') return `Waiting for the wallet: it shows the ${what} for you to approve, then sends it itself.`;
  return `The wallet has sent the ${what}. Waiting for the chain to show it; the page asks every few seconds, for up to a minute.`;
}

/** The team's wallet: found in the browser, connected, and held against the wallet the organisation names. */
function WalletPart({ org, wallet, onChanged }: { org: SolanaActionsProps['org']; wallet: ReturnType<typeof useSolanaWallet>; onChanged: () => void }) {
  const record = useAsyncAction(async (address: string) => {
    await api.updateOrg(org.id, { solanaOwner: address });
    onChanged();
  });
  const connecting = wallet.status === 'connecting';

  const connected = wallet.status === 'connected' && wallet.address !== null && wallet.wallet !== null ? { address: wallet.address, name: wallet.wallet.name } : null;

  return (
    <>
      {org.solanaOwner === null && (
        <p>
          Payouts on Solana leave from a token account of the team&apos;s own wallet. Connect that wallet and record its address. Its key stays in the wallet: the service is only ever approved as a delegate, for an amount you set.
        </p>
      )}

      {connected === null ? (
        <>
          {wallet.wallets.length === 0 ? (
            <Notice kind="info" title="No Solana wallet was found in this browser">
              <p>
                The {org.solanaOwner === null ? 'wallet has to be connected to be recorded, and later to sign the approval' : 'approval and the revocation are signed in the team’s wallet'}. Open this page in the browser that has the wallet&apos;s extension, or install one that supports the Wallet Standard, and it will be listed here.
              </p>
            </Notice>
          ) : (
            <div className="po-row">
              {wallet.wallets.map((found) => (
                <Button key={found.id} variant="secondary" busy={connecting && wallet.wallet?.id === found.id} disabled={connecting && wallet.wallet?.id !== found.id} onClick={() => void wallet.connect(found, org.solanaOwner ?? undefined).catch(() => undefined)}>
                  Connect {found.name}
                </Button>
              ))}
              <span className="hf-small">Connecting shares the wallet&apos;s address with this page. It signs nothing.</span>
            </div>
          )}
          {connecting && <Waiting>Waiting for the wallet to share its account.</Waiting>}
          {wallet.error !== null && !connecting && <ToldNotice told={failureTold(wallet.error)} />}
        </>
      ) : (
        <>
          <p>
            Connected: {connected.name} shares <Address value={connected.address} what="connected wallet" />.{' '}
            {org.solanaOwner === null ? 'It is not recorded as the team’s wallet yet.' : connected.address === org.solanaOwner ? 'This is the team’s wallet, so it can sign the approval and the revocation below.' : ''}
          </p>
          {org.solanaOwner !== null && connected.address !== org.solanaOwner && (
            <Notice kind="warning" title="The connected wallet is not the team’s wallet">
              <p>
                The organisation names <Address value={org.solanaOwner} what="team wallet" />. Switch to that account in the wallet, or connect the wallet that holds it. Only that wallet can approve or revoke the delegate on its token account.
              </p>
              <p>If the organisation should pay from the connected wallet instead, record it in its place. Runs that are already drafted keep the wallet they were drafted for.</p>
            </Notice>
          )}
          <div className="po-row">
            {org.solanaOwner !== connected.address && (
              <Button variant={org.solanaOwner === null ? 'primary' : 'secondary'} busy={record.status === 'pending'} onClick={() => void record.run(connected.address)}>
                {org.solanaOwner === null ? 'Record this wallet as the team’s' : 'Record the connected wallet instead'}
              </Button>
            )}
            <Button variant="quiet" onClick={() => void wallet.disconnect()}>
              Disconnect
            </Button>
            {org.solanaOwner !== connected.address && <span className="hf-small">Recording writes the address into the organisation&apos;s profile. It signs nothing and approves nothing.</span>}
          </div>
          {record.status === 'pending' && <Waiting>Recording the wallet&apos;s address in the organisation&apos;s profile.</Waiting>}
          {record.status === 'failed' && <ToldNotice told={failureTold(record.error)} />}
        </>
      )}
    </>
  );
}

interface DelegatePartProps {
  org: SolanaActionsProps['org'];
  rail: Rail;
  connection: SolanaConnection;
  onDone: (outcome: ReactNode) => void;
}

/** Approving the service key as delegate for an amount the treasurer types. */
function ApprovePart({ org, rail, connection, onDone }: DelegatePartProps) {
  const { token } = rail;
  const [typed, setTyped] = useState('');
  const [error, setError] = useState<string | undefined>(undefined);
  const [amount, setAmount] = useState<bigint | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [phase, setPhase] = useState<Phase>('preparing');
  const [sent, setSent] = useState<SolanaSubmission | null>(null);
  const figure = amount === null ? '' : `${formatUnits(amount, token.decimals)} ${token.symbol}`;

  const said = (units: bigint, submission: SolanaSubmission) => (
    <ToldNotice told={{ kind: 'done', word: 'Approved', title: `The chain shows an allowance of ${formatUnits(units, token.decimals)} ${token.symbol}`, body: ['The service key can pay out up to that amount from the team’s token account, and nothing after you revoke.'] }}>
      <SentLine sent={submission} />
    </ToldNotice>
  );

  const approve = useAsyncAction(async (units: bigint) => {
    setSent(null);
    setPhase('preparing');
    const submission = await approveSolanaDelegate(watched(connection, 'signAndSend', () => setPhase('signing'), () => setPhase('confirming')), org.id, units);
    setSent(submission);
    await waitForSolanaAllowance(org.id, units);
    onDone(said(units, submission));
  });
  /** Ask the chain again for an approval that was sent and not seen yet. */
  const confirm = useAsyncAction(async (units: bigint, submission: SolanaSubmission) => {
    await waitForSolanaAllowance(org.id, units, { attempts: 5 });
    onDone(said(units, submission));
  });

  const review = () => {
    const parsed = parseAmount(typed, token.decimals);
    if (!parsed.ok) {
      setError(parsed.reason);
      return;
    }
    setError(undefined);
    setAmount(parsed.units);
    setReviewing(true);
  };
  const busy = approve.status === 'pending' || confirm.status === 'pending';

  return (
    <>
      <p>
        {rail.allowanceState === 'approved'
          ? 'An approval replaces the one before it: the allowance becomes the amount you enter, it is not added to what is left.'
          : 'Approve the service key as delegate of the team’s token account, for a fixed amount. It can then pay out up to that amount and no more.'}
      </p>
      <div className="po-form po-form--one">
        <Input
          label={`Allowance in ${token.symbol}`}
          hint="The most the service key may move out of the token account, in total, until you approve a new amount or revoke."
          numeric
          inputMode="decimal"
         
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
          disabled={busy}
          {...(error === undefined ? {} : { error })}
        />
      </div>
      <div className="po-row">
        <Button variant="primary" busy={approve.status === 'pending'} disabled={confirm.status === 'pending'} onClick={review}>
          Review the approval
        </Button>
        <span className="hf-small">Nothing is signed yet.</span>
      </div>
      {approve.status === 'pending' && (
        <Waiting>
          {phaseWords(phase, 'approval')} <SentInline sent={sent} />
        </Waiting>
      )}
      {approve.status === 'failed' && (
        <ToldNotice told={failureTold(approve.error)}>
          <SentLine sent={sent} />
          {approve.error.code === 'not_confirmed' && sent !== null && amount !== null ? (
            <div className="po-row">
              <Button variant="secondary" small busy={confirm.status === 'pending'} onClick={() => void confirm.run(amount, sent)}>
                Read the chain again
              </Button>
            </div>
          ) : (
            sent === null && <p>The allowance is as the chain shows it above: nothing was approved.</p>
          )}
        </ToldNotice>
      )}
      {confirm.status === 'pending' && <Waiting>Asking the chain again whether it shows the allowance.</Waiting>}
      {confirm.status === 'failed' && approve.status !== 'pending' && <ToldNotice told={failureTold(confirm.error)} />}

      <Dialog
        open={reviewing && amount !== null}
        onClose={() => setReviewing(false)}
        title="What you are about to approve"
        closeLabel="Cancel"
        actions={
          <>
            <Button variant="quiet" onClick={() => setReviewing(false)}>
              Approve nothing
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                setReviewing(false);
                confirm.reset();
                if (amount !== null) void approve.run(amount);
              }}
            >
              Approve in the wallet
            </Button>
          </>
        }
      >
        <p className="po-pledge">
          The service can pay out up to {figure} from this account, and nothing after you revoke.
        </p>
        <KeyValue
          className="po-facts"
          items={[
            { label: 'From', value: rail.tokenAccount === null ? 'The wallet’s token account' : <Address value={rail.tokenAccount} href={addressUrl(rail.links, rail.tokenAccount)} what="token account" /> },
            { label: 'Delegate', value: rail.delegate === null ? 'None' : <Address value={rail.delegate} href={addressUrl(rail.links, rail.delegate)} what="delegate" /> },
            { label: 'Token', value: <>{token.symbol} <Address value={token.address} href={addressUrl(rail.links, token.address)} what="token" /></> },
            { label: 'Up to', value: figure },
          ]}
        />
        <p>
          <b className="po-strong">What the delegate will still be unable to do.</b> Move more than this amount, touch any other token or account of the wallet, or move anything once you revoke. The Token program enforces each of these.
        </p>
        <p>
          <b className="po-strong">What happens when you approve.</b> Your wallet signs and sends one transaction with one instruction, <code className="po-code">ApproveChecked</code> on the Token program, and pays its fee in SOL. It replaces any earlier approval of this delegate. Nothing leaves the account.
        </p>
      </Dialog>
    </>
  );
}

function SentInline({ sent }: { sent: SolanaSubmission | null }) {
  if (sent === null) return null;
  return <ExternalTxLink chain="solana" id={sent.signature} href={sent.txUrl} />;
}

/** Taking the delegation back. */
function RevokePart({ org, rail, connection, onDone }: DelegatePartProps) {
  const [confirming, setConfirming] = useState(false);
  const [phase, setPhase] = useState<Phase>('preparing');
  const [sent, setSent] = useState<SolanaSubmission | null>(null);

  const said = (submission: SolanaSubmission) => (
    <ToldNotice told={{ kind: 'done', word: 'Revoked', title: 'The chain shows no allowance for the service key', body: ['The service key can move nothing from the team’s token account any more.'] }}>
      <SentLine sent={submission} />
    </ToldNotice>
  );
  const revoke = useAsyncAction(async () => {
    setSent(null);
    setPhase('preparing');
    const submission = await revokeSolanaDelegate(watched(connection, 'signAndSend', () => setPhase('signing'), () => setPhase('confirming')), org.id);
    setSent(submission);
    await waitForSolanaAllowance(org.id, 0n);
    onDone(said(submission));
  });
  const confirm = useAsyncAction(async (submission: SolanaSubmission) => {
    await waitForSolanaAllowance(org.id, 0n, { attempts: 5 });
    onDone(said(submission));
  });

  return (
    <>
      <p>You can take the delegation back at any moment. From then on the Token program refuses every transfer the service key signs on this account.</p>
      <div className="po-row">
        <Button variant="destructive" busy={revoke.status === 'pending'} disabled={confirm.status === 'pending'} onClick={() => setConfirming(true)}>
          Revoke the delegate
        </Button>
      </div>
      {revoke.status === 'pending' && (
        <Waiting>
          {phaseWords(phase, 'revocation')} <SentInline sent={sent} />
        </Waiting>
      )}
      {revoke.status === 'failed' && (
        <ToldNotice told={failureTold(revoke.error)}>
          <SentLine sent={sent} />
          {revoke.error.code === 'not_confirmed' && sent !== null ? (
            <div className="po-row">
              <Button variant="secondary" small busy={confirm.status === 'pending'} onClick={() => void confirm.run(sent)}>
                Read the chain again
              </Button>
            </div>
          ) : (
            sent === null && <p>The allowance is as the chain shows it above: nothing was revoked.</p>
          )}
        </ToldNotice>
      )}
      {confirm.status === 'pending' && <Waiting>Asking the chain again whether the allowance is gone.</Waiting>}
      {confirm.status === 'failed' && revoke.status !== 'pending' && <ToldNotice told={failureTold(confirm.error)} />}

      <Dialog
        open={confirming}
        onClose={() => setConfirming(false)}
        title="Revoke the delegate"
        closeLabel="Cancel"
        actions={
          <>
            <Button variant="quiet" onClick={() => setConfirming(false)}>
              Keep the delegate
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                setConfirming(false);
                void revoke.run();
              }}
            >
              Revoke in the wallet
            </Button>
          </>
        }
      >
        <p>
          <b className="po-strong">What you sign.</b> One transaction with one instruction, <code className="po-code">Revoke</code> on the Token program, for the team&apos;s token account
          {rail.tokenAccount !== null && (
            <>
              {' '}
              <Address value={rail.tokenAccount} href={addressUrl(rail.links, rail.tokenAccount)} what="token account" />
            </>
          )}
          . Your wallet sends it and pays its fee in SOL.
        </p>
        <p>
          <b className="po-strong">What it does.</b> The allowance of the service key becomes nothing. Payout runs on Solana are refused until you approve an amount again, which you can do at any time.
        </p>
      </Dialog>
    </>
  );
}

/**
 * What the owner does on the Solana rail: connect the team's wallet and
 * record it, approve the service key as delegate for an amount, and revoke
 * it. The wallet signs and sends; whether it took effect is read from the
 * chain, never taken from the wallet.
 */
export function SolanaActions({ org, rail }: SolanaActionsProps) {
  const router = useRouter();
  const wallet = useSolanaWallet();
  // What the last step that went through said. It outlives the form it came from, which the fresh reading replaces.
  const [outcome, setOutcome] = useState<ReactNode>(null);
  const refresh = () => router.refresh();
  const done = (said: ReactNode) => {
    setOutcome(said);
    router.refresh();
  };
  const connection = wallet.status === 'connected' && wallet.address === org.solanaOwner ? wallet.connection : null;

  return (
    <div className="po-actions">
      <section className="po-action" aria-labelledby="po-solana-wallet">
        <h3 id="po-solana-wallet" className="po-action__title">
          {org.solanaOwner === null ? 'Connect the team’s Solana wallet' : 'The team’s wallet in this browser'}
        </h3>
        <WalletPart org={org} wallet={wallet} onChanged={refresh} />
      </section>

      {org.solanaOwner !== null && (
        <section className="po-action" aria-labelledby="po-solana-approve">
          <h3 id="po-solana-approve" className="po-action__title">
            {rail?.allowanceState === 'approved' ? 'Change the allowance' : 'Approve the delegate'}
          </h3>
          {outcome}
          {rail === null || rail.allowanceState === 'unavailable' ? (
            <>
              <p>The allowance could not be read from Solana, so nothing is offered here until it can. Nothing has changed on chain.</p>
              <div className="po-row">
                <Button variant="secondary" onClick={refresh}>
                  Read the chain again
                </Button>
              </div>
            </>
          ) : connection === null ? (
            <p>Approving and revoking are signed in the team&apos;s wallet. Connect it above first.</p>
          ) : (
            <ApprovePart org={org} rail={rail} connection={connection} onDone={done} />
          )}
        </section>
      )}

      {org.solanaOwner !== null && rail !== null && rail.allowanceState === 'approved' && connection !== null && (
        <section className="po-action" aria-labelledby="po-solana-revoke">
          <h3 id="po-solana-revoke" className="po-action__title">
            Revoke the delegate
          </h3>
          <RevokePart org={org} rail={rail} connection={connection} onDone={done} />
        </section>
      )}
    </div>
  );
}
