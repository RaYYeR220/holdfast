'use client';

import { type ReactNode, useEffect, useRef, useState } from 'react';

export interface CopyButtonProps {
  /** The exact text put on the clipboard. */
  value: string;
  /** What is shown beside the button, usually a shortened form of `value` in the numeric face. Nothing when omitted. */
  children?: ReactNode;
  /** What is being copied, for the button's accessible name: "address", "transaction id". */
  what?: string;
  className?: string;
}

/** Copies a value to the clipboard and says that it did. For addresses, hashes and payment requests. */
export function CopyButton({ value, children, what = 'value', className }: CopyButtonProps) {
  const [state, setState] = useState<'idle' | 'done' | 'failed'>('idle');
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setState('done');
    } catch {
      setState('failed');
    }
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setState('idle'), 1800);
  };

  return (
    <span className={`hf-copy${className === undefined ? '' : ` ${className}`}`}>
      {children !== undefined && <span className="hf-copy__value hf-num">{children}</span>}
      <button type="button" className="hf-copy__btn" onClick={copy} data-done={state === 'done'} aria-label={`Copy ${what}`}>
        {state === 'done' ? 'Copied' : state === 'failed' ? 'Not copied' : 'Copy'}
      </button>
      <span className="hf-sr" role="status">
        {state === 'done' ? `The ${what} was copied.` : state === 'failed' ? `The ${what} could not be copied.` : ''}
      </span>
    </span>
  );
}
