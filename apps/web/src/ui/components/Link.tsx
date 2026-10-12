import NextLink from 'next/link';
import type { ReactNode } from 'react';

export interface LinkProps {
  href: string;
  /** `text` sits in a sentence; `emphasis` is the italic link of a call to action; `nav` is a pixel label on a plate. */
  variant?: 'text' | 'emphasis' | 'nav';
  /** Leaves the application: opens in a new tab and carries the arrow that says so. */
  external?: boolean;
  /** Marks the page the reader is on, for `nav` links. */
  current?: boolean;
  className?: string;
  'aria-label'?: string;
  children: ReactNode;
}

/** The arrow of a link that leaves the application, as pixels. */
export function OutArrow() {
  return (
    <svg className="hf-link__out" viewBox="0 0 5 5" aria-hidden="true">
      <path shapeRendering="crispEdges" d="M1 0h4v4h-1v-2h-1v1h-1v1h-1v1h-1v-1h1v-1h1v-1h1v-1h-2z" />
    </svg>
  );
}

/**
 * A link in the dotted underline of the ledger. Paths inside the application
 * are followed without a page load, and nothing is fetched ahead of the
 * click: the pages read live sources when they render.
 */
export function Link({ href, variant = 'text', external = false, current = false, className, children, ...rest }: LinkProps) {
  const name = ['hf-link', variant === 'text' ? '' : `hf-link--${variant}`, className ?? ''].filter(Boolean).join(' ');
  const shared = { className: name, 'aria-label': rest['aria-label'], ...(current ? { 'aria-current': 'page' as const } : {}) };
  if (external) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" {...shared}>
        {children}
        <OutArrow />
        <span className="hf-sr"> (opens in a new tab)</span>
      </a>
    );
  }
  if (!href.startsWith('/')) {
    return (
      <a href={href} {...shared}>
        {children}
      </a>
    );
  }
  return (
    <NextLink href={href} prefetch={false} {...shared}>
      {children}
    </NextLink>
  );
}
