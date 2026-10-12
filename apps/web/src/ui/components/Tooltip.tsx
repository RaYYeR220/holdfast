import { type ReactNode, useId } from 'react';

export interface TooltipProps {
  /** The explanation: one or two short sentences. */
  tip: ReactNode;
  /** Where the note opens. Above and aligned to the start when omitted. */
  placement?: 'above' | 'below';
  align?: 'start' | 'end';
  /** Underline the term with fine dots so it is seen to carry a note. On by default. */
  marked?: boolean;
  className?: string;
  /** The term or figure being explained. */
  children: ReactNode;
}

/**
 * A short explanation of a term, shown on hover and on keyboard focus. The
 * term is focusable and names the note as its description. It needs no
 * script. Never put anything in a tooltip that a reader must see to act.
 */
export function Tooltip({ tip, placement = 'above', align = 'start', marked = true, className, children }: TooltipProps) {
  const id = useId();
  const name = ['hf-tip', marked ? 'hf-tip--marked' : '', placement === 'below' ? 'hf-tip--below' : '', align === 'end' ? 'hf-tip--end' : '', className ?? ''].filter(Boolean).join(' ');
  return (
    <span className={name} tabIndex={0} aria-describedby={id}>
      {children}
      <span className="hf-tip__bubble" role="tooltip" id={id}>
        {tip}
      </span>
    </span>
  );
}
