import NextLink from 'next/link';
import type { ButtonHTMLAttributes, ReactNode } from 'react';

export type ButtonVariant = 'primary' | 'secondary' | 'quiet' | 'destructive';

interface Common {
  variant?: ButtonVariant;
  /** A shorter plate, for a row of a table or the head of a panel. */
  small?: boolean;
  /** The action is under way: the plate fills with a moving checker and cannot be pressed again. */
  busy?: boolean;
  disabled?: boolean;
  className?: string;
  children: ReactNode;
}

export interface ButtonProps extends Common, Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className' | 'children' | 'disabled'> {
  href?: undefined;
}

export interface ButtonLinkProps extends Common {
  /** Where the button goes. A path inside the application is followed without a page load. */
  href: string;
  /** Open in a new tab; set for anything outside the application. */
  external?: boolean;
  'aria-label'?: string;
}

function classes(p: Common): string {
  return ['hf-btn', `hf-btn--${p.variant ?? 'primary'}`, p.small === true ? 'hf-btn--small' : '', p.className ?? ''].filter(Boolean).join(' ');
}

/**
 * The one button. Four kinds: `primary` for the single main action of a view,
 * `secondary` for the others, `quiet` for an action inside running text or a
 * dense row, `destructive` for what cannot be undone. With `href` it is a
 * link that looks like a button. Such a link fetches nothing until it is
 * followed: the pages it leads to read chains and venues when they render.
 */
export function Button(props: ButtonProps | ButtonLinkProps) {
  const label = <span className="hf-btn__label">{props.children}</span>;
  if (props.href !== undefined) {
    const { href, external, busy, disabled } = props;
    const off = disabled === true || busy === true;
    const shared = {
      className: classes(props),
      'aria-label': props['aria-label'],
      ...(busy === true ? { 'aria-busy': true } : {}),
      ...(disabled === true ? { 'aria-disabled': true, tabIndex: -1 } : {}),
    };
    if (external === true || !href.startsWith('/')) {
      return (
        <a href={off ? undefined : href} {...shared} {...(external === true ? { target: '_blank', rel: 'noopener noreferrer' } : {})}>
          {label}
        </a>
      );
    }
    return off ? (
      <a {...shared}>{label}</a>
    ) : (
      <NextLink href={href} prefetch={false} {...shared}>
        {label}
      </NextLink>
    );
  }
  const { variant: _variant, small: _small, busy, disabled, className: _className, children: _children, type, onClick, ...rest } = props;
  // A busy button stays focusable, so a screen reader hears that it is busy, but a second press does nothing.
  return (
    <button type={type ?? 'button'} className={classes(props)} disabled={disabled === true} {...rest} {...(busy === true ? { 'aria-busy': true } : { onClick })}>
      {label}
    </button>
  );
}
