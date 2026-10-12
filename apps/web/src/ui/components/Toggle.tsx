'use client';

import { type ReactNode, useId, useState } from 'react';

export interface ToggleProps {
  /** What the lever switches, in the pixel face beside it. */
  label: ReactNode;
  /** Controlled value. Leave it out and pass `defaultChecked` to let the lever keep its own. */
  checked?: boolean;
  defaultChecked?: boolean;
  onChange?: (checked: boolean) => void;
  /** The words on the two positions. "Off" and "On" when omitted. */
  offLabel?: string;
  onLabel?: string;
  /** Submit the value with a form under this name: "on" when checked, absent when not. */
  name?: string;
  disabled?: boolean;
  small?: boolean;
  /** Hide the label visually; it still names the switch. */
  labelHidden?: boolean;
  className?: string;
}

/**
 * A two-position lever with both positions written on it. The position in
 * force is the solid half; "on" carries the solid swatch of a locked thing
 * and "off" the checker of an unlocked one, so the two differ in word, in
 * pattern and in place.
 */
export function Toggle({ label, checked, defaultChecked = false, onChange, offLabel = 'Off', onLabel = 'On', name, disabled = false, small = false, labelHidden = false, className }: ToggleProps) {
  const labelId = useId();
  const [own, setOwn] = useState(defaultChecked);
  const on = checked ?? own;
  const flip = () => {
    if (checked === undefined) setOwn(!on);
    onChange?.(!on);
  };
  return (
    <span className={`hf-toggle${className === undefined ? '' : ` ${className}`}`}>
      <span className={labelHidden ? 'hf-sr' : 'hf-toggle__label'} id={labelId}>
        {label}
      </span>
      <button type="button" role="switch" aria-checked={on} aria-labelledby={labelId} className={small ? 'hf-lever hf-lever--small' : 'hf-lever'} disabled={disabled} onClick={flip}>
        <span className="hf-lever__opt hf-lever__off">
          <i className="hf-swatch" aria-hidden="true" />
          {offLabel}
        </span>
        <span className="hf-lever__opt hf-lever__on">
          <i className="hf-swatch" aria-hidden="true" />
          {onLabel}
        </span>
      </button>
      {name !== undefined && on && <input type="hidden" name={name} value="on" />}
    </span>
  );
}
