import type { ReactNode } from 'react';
import { Notice } from '@/ui';
import type { Failed } from './failures';
import '../safety/parts.css';

export interface FailureNoticeProps {
  failed: Failed;
  className?: string;
  /** What the failure left as it was: "Nothing was added to the record." */
  children?: ReactNode;
}

/**
 * A failed action, said where it happened: what kind of failure, the
 * server's or the wallet's own words, and behind a fold the whole of a
 * message that ran too long to read as a sentence.
 */
export function FailureNotice({ failed, className, children }: FailureNoticeProps) {
  return (
    <Notice kind={failed.kind} title={failed.title} {...(className === undefined ? {} : { className })}>
      <p className="sx-said">{failed.body}</p>
      {children}
      {failed.detail !== null && (
        <details className="sx-full">
          <summary>The message in full</summary>
          <p className="hf-num">{failed.detail}</p>
        </details>
      )}
    </Notice>
  );
}
