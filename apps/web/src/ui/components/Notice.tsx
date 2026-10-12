import type { ReactNode } from 'react';

export type NoticeKind = 'info' | 'warning' | 'refusal';

const WORD: Record<NoticeKind, string> = { info: 'Note', warning: 'Warning', refusal: 'Refused' };
const BAND: Record<NoticeKind, string> = { info: 'hf-t25', warning: '', refusal: 'hf-pat-refused' };

export interface NoticeProps {
  kind?: NoticeKind;
  /** What happened, in a few words, in the pixel face. */
  title?: ReactNode;
  /** Overrides the word that names the kind: "Note", "Warning", "Refused". */
  word?: string;
  /** Announce it to assistive technology when it appears. On by default for warnings and refusals. */
  announce?: boolean;
  className?: string;
  children?: ReactNode;
}

/**
 * A message set apart from the page. Three kinds, told apart by the band down
 * the left edge and by the word in the title: `info` (dots, "Note"),
 * `warning` (a checker inside a dotted fence, "Warning") and `refusal` (the
 * stair hatch, "Refused"), which is for anything a chain, a venue or the
 * policy would not do.
 */
export function Notice({ kind = 'info', title, word, announce, className, children }: NoticeProps) {
  const live = announce ?? kind !== 'info';
  return (
    <div className={['hf-notice', `hf-notice--${kind}`, className ?? ''].filter(Boolean).join(' ')} {...(live ? { role: kind === 'refusal' ? 'alert' : 'status' } : {})}>
      <div className={`hf-notice__band ${BAND[kind]}`} aria-hidden="true" />
      <div className="hf-notice__main">
        <p className="hf-notice__title">
          <span className="hf-notice__kind">{word ?? WORD[kind]}</span>
          {title}
        </p>
        {children !== undefined && <div className="hf-notice__body">{children}</div>}
      </div>
    </div>
  );
}
