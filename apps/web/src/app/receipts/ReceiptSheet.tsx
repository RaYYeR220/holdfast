import NextLink from 'next/link';
import type { ReactNode } from 'react';
import './receipt.css';

/**
 * The sheet a receipt is printed on: paper on the ink ground, standing alone
 * with no navigation, its lower edge stepping down to the ink through the
 * four tones. The receipt and the page that says there is none are both set
 * on it.
 */
export function ReceiptSheet({ children, foot }: { children: ReactNode; foot: ReactNode }) {
  return (
    <main className="rc hf-ink">
      <div className="rc__column">
        <p className="rc__mark">
          <NextLink href="/" prefetch={false}>
            Holdfast
          </NextLink>
        </p>
        <article className="rc__sheet hf-paper">{children}</article>
        <div className="rc__edge" aria-hidden="true">
          <i className="hf-t75" />
          <i className="hf-t50" />
          <i className="hf-t25" />
          <i className="hf-t12" />
        </div>
        <p className="rc__foot">{foot}</p>
      </div>
    </main>
  );
}
