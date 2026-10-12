import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { CopyButton, ExternalTxLink, KeyValue, type KeyValueItem, Link, StateTag, Timestamp, Unavailable, formatUtc, shorten } from '@/ui';
import { addressUrl, chainName, tokenAmount, tokenText } from '../../_sections/payouts/format';
import { loadReceipt } from '../../_sections/payouts/load';
import { ReceiptSheet } from '../ReceiptSheet';

// A receipt link is a key to what it shows: it is not for search engines, and it is not passed on to other sites.
export const metadata: Metadata = { title: 'Receipt', robots: { index: false, follow: false }, referrer: 'no-referrer' };

export const dynamic = 'force-dynamic';

/**
 * What a payee opens: one payment, with who paid it, how much, when, under
 * which reference and in which transaction. It needs no account and shows
 * nothing else of the organisation that paid.
 */
export default async function ReceiptPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const read = await loadReceipt(token);
  const now = Date.now();

  if (read.status !== 'ok') {
    return (
      <ReceiptSheet foot="Nothing about the payment has changed. The record of it is on its chain, whether or not this page can be shown.">
        <header className="rc__head">
          <p className="rc__kicker">Receipt</p>
          <StateTag state="stale" label="Unavailable" boxed />
        </header>
        <h1 className="rc__none">The receipt cannot be shown just now</h1>
        <Unavailable reason={read.reason} source={read.source === 'database' ? 'the database' : read.source} at={read.at} now={now} />
        <p>Open the link again in a little while.</p>
      </ReceiptSheet>
    );
  }
  if (read.value === null) notFound();

  const receipt = read.value;
  const amount = tokenAmount(receipt.amount, receipt.token);
  const chain = chainName(receipt.chain, receipt.network);
  const paid = tokenText(receipt.amount, receipt.token);

  const facts: KeyValueItem[] = [
    { label: 'Paid by', value: receipt.organisation },
    {
      label: 'Paid to',
      value: (
        <span className="rc__copy">
          <Link href={addressUrl(receipt.links, receipt.to)} external aria-label={`The address ${shorten(receipt.to, 6, 6)} on the explorer`}>
            <span className="rc__whole">{receipt.to}</span>
          </Link>
          <CopyButton value={receipt.to} what="address that was paid" />
        </span>
      ),
    },
    ...(receipt.reference === '' || receipt.reference === receipt.memo ? [] : [{ label: 'Reference', value: receipt.reference }]),
    ...(receipt.memo === '' ? [] : [{ label: receipt.reference === receipt.memo ? 'Reference' : 'Memo on chain', value: <span className="rc__whole">{receipt.memo}</span> }]),
    {
      label: 'Token',
      value: (
        <span className="rc__copy">
          {receipt.token.symbol ?? 'Not recorded'}
          <Link href={addressUrl(receipt.links, receipt.token.address)} external aria-label={`The token ${shorten(receipt.token.address, 6, 6)} on the explorer`}>
            <span className="rc__whole">{shorten(receipt.token.address, 6, 6)}</span>
          </Link>
        </span>
      ),
    },
    ...(receipt.paidAt === null ? [] : [{ label: 'Paid', value: <Timestamp at={receipt.paidAt} now={now} seconds /> }]),
    { label: 'Transaction', value: <ExternalTxLink chain={receipt.chain} id={receipt.tx} href={receipt.txUrl} showChain={false} /> },
  ];

  return (
    <ReceiptSheet foot={`This page shows one payment and nothing else of ${receipt.organisation}. Whoever holds its link can open it; no account is needed.`}>
      <header className="rc__head">
        <p className="rc__kicker">Receipt</p>
        <StateTag state="locked" label="Paid" boxed />
      </header>

      <h1 className="rc__title">
        <span className="rc__payer">
          <b>{receipt.organisation}</b> paid
        </span>
        <span className="rc__amount">
          {amount.figure}
          <span className="rc__unit">{amount.unit}</span>
        </span>
        <span className="rc__where">
          on {chain}
          {receipt.paidAt !== null && `, ${formatUtc(receipt.paidAt)}`}
        </span>
      </h1>

      <KeyValue items={facts} className="rc__facts" />

      <section className="rc__check" aria-labelledby="rc-check">
        <h2 id="rc-check">Check it yourself</h2>
        <p>
          Open the transaction on the explorer of {chain}. It shows the transfer of {paid} to {receipt.chain === 'solana' ? 'the token account of the address above' : 'the address above'}
          {receipt.chain === 'tempo' && receipt.memo !== '' && (
            <>
              , carrying the memo <span className="rc__whole">{receipt.memo}</span>
            </>
          )}
          . That record is the chain&apos;s own: it does not depend on this page or on Holdfast.
        </p>
      </section>
    </ReceiptSheet>
  );
}
