import { Notice } from '@/ui';
import './entry.css';
import { type Failed, failureShown } from './failure';

export interface FailureNoticeProps {
  /** What was thrown: a `ClientError`, or anything of its shape. */
  error: Failed;
  /** What was attempted, as a title, and what is true now that it failed. */
  doing: { title: string; nothing: string };
}

/** A failed step as a notice: what was refused or could not be done, the reason as it was given, and what to do next. */
export function FailureNotice({ error, doing }: FailureNoticeProps) {
  const shown = failureShown(error, doing);
  return (
    <Notice kind={shown.kind} word={shown.word} title={shown.title}>
      <p className="en-break">{shown.reason}</p>
      <p className="hf-small">{shown.next}</p>
    </Notice>
  );
}
