'use client';

import { type ReactNode, useEffect, useId, useRef } from 'react';

export interface DialogProps {
  open: boolean;
  /** Called when the reader closes it: Escape, the backdrop, or the close button. */
  onClose: () => void;
  title: ReactNode;
  /** The buttons at the foot. Put the main action last. */
  actions?: ReactNode;
  /** The word on the close button in the head. "Close" when omitted. */
  closeLabel?: string;
  className?: string;
  children?: ReactNode;
}

/**
 * A modal sheet of paper over a page held at half tone. It is the browser's
 * own dialog element, so focus is kept inside it, Escape closes it and focus
 * returns to where it was. Always paper, on either ground, so that what it
 * asks is read apart from the screen behind it.
 */
export function Dialog({ open, onClose, title, actions, closeLabel = 'Close', className, children }: DialogProps) {
  const element = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = element.current;
    if (dialog === null) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={element}
      className={`hf-dialog${className === undefined ? '' : ` ${className}`}`}
      aria-labelledby={titleId}
      onClose={onClose}
      onClick={(event) => {
        // The dialog's own box is only its padding; a click there is a click on the backdrop.
        if (event.target === element.current) onClose();
      }}
    >
      <div className="hf-dialog__card">
        <header className="hf-dialog__head">
          <h2 className="hf-dialog__title" id={titleId}>
            {title}
          </h2>
          <button type="button" className="hf-btn hf-btn--quiet hf-btn--small" onClick={onClose}>
            <span className="hf-btn__label">{closeLabel}</span>
          </button>
        </header>
        <div className="hf-dialog__body">{children}</div>
        {actions !== undefined && <footer className="hf-dialog__foot">{actions}</footer>}
      </div>
    </dialog>
  );
}
