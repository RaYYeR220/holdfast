import type { ReactNode } from 'react';
import { Notice, Skeleton } from '@/ui';
import type { Told } from './flow';

/**
 * An answer of the server, a wallet or a chain, set apart from the page: the
 * word that names it, what happened, and the reason as it was given. What
 * went through and what the product did as it should are notes; what is not
 * settled is a warning; what was turned down is a refusal.
 */
export function ToldNotice({ told, children }: { told: Told; children?: ReactNode }) {
  const kind = told.kind === 'refusal' ? 'refusal' : told.kind === 'warning' ? 'warning' : 'info';
  return (
    <Notice kind={kind} word={told.word} title={told.title} announce className="po-told">
      {told.body
        .filter((line) => line !== '')
        .map((line) => (
          <p key={line}>{line}</p>
        ))}
      {children}
    </Notice>
  );
}

/** A step that is under way, in words: what the page is waiting for, and for whom. */
export function Waiting({ children }: { children: ReactNode }) {
  return (
    <div className="po-waiting" role="status">
      <Skeleton width={24} height={24} label="Under way" />
      <p>{children}</p>
    </div>
  );
}
