import type { Metadata } from 'next';
import { StateTag } from '@/ui';
import { ReceiptSheet } from '../ReceiptSheet';

export const metadata: Metadata = { title: 'No receipt here', robots: { index: false, follow: false } };

/** What a wrong link shows. It does not say whether the link was ever right. */
export default function NoReceipt() {
  return (
    <ReceiptSheet foot="A receipt link is long and has to be whole. Nothing is charged, sent or changed by opening one.">
      <header className="rc__head">
        <p className="rc__kicker">Receipt</p>
        <StateTag state="unlocked" label="Not found" boxed />
      </header>
      <h1 className="rc__none">There is no receipt at this address</h1>
      <p>The link does not lead to a payment. It may have been cut short when it was copied, or the payment it was made for was not completed.</p>
      <p>Ask whoever sent it to you for the link again.</p>
    </ReceiptSheet>
  );
}
