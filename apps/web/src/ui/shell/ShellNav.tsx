'use client';

import NextLink from 'next/link';
import { usePathname } from 'next/navigation';

export interface ShellNavProps {
  items: readonly { label: string; href: string }[];
  /** The path of the area, which is also the address of its overview. */
  base: string;
  /** Names the navigation for assistive technology. */
  label: string;
}

/** The rail's links. The section being read is the solid one and carries `aria-current`. */
export function ShellNav({ items, base, label }: ShellNavProps) {
  const path = usePathname();
  const isCurrent = (href: string) => (href === base ? path === base : path === href || path.startsWith(`${href}/`));
  return (
    <nav className="hf-shell__nav" aria-label={label}>
      <ul>
        {items.map((item) => (
          <li key={item.href}>
            <NextLink href={item.href} className="hf-shell__link" {...(isCurrent(item.href) ? { 'aria-current': 'page' as const } : {})} prefetch={false}>
              {item.label}
            </NextLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}
