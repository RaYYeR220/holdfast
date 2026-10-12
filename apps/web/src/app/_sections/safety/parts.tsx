import type { ReactNode } from 'react';
import { CopyButton, KeyPlate, type KeyKind, OutArrow, Timestamp, shorten } from '@/ui';
import { SealPlate } from './SealPlate';
import { sourceName } from './links';
import type { KeyId } from './model';
import './parts.css';

/**
 * Small pieces the Books, Safety and Settings pages share: an address with
 * its copy button, the line that says where and when a figure was read, a
 * link that leaves for an explorer, and the picture of each key.
 */

export interface AddressProps {
  value: string;
  /** What is copied, for the button's name: "address", "treasury address". */
  what?: string;
  /** How much of each end is shown. Long addresses of Zcash take more. */
  head?: number;
  tail?: number;
}

/** An address or a hash with its two ends shown and the whole of it to copy. */
export function Address({ value, what = 'address', head = 8, tail = 6 }: AddressProps) {
  return (
    <CopyButton value={value} what={what}>
      <span title={value}>{shorten(value, head, tail)}</span>
    </CopyButton>
  );
}

/** Where a figure was read and when: "Read from Tempo, 2026-10-12 16:11 UTC, 8 s ago". */
export function AsOf({ source, at, now, verb = 'Read from' }: { source: string; at: number; now: number; verb?: string }) {
  return (
    <p className="sx-asof">
      {verb} {sourceName(source)}, <Timestamp at={at} now={now} />
    </p>
  );
}

/** A link that leaves the application for an explorer, in the form of a transaction link. */
export function OutLink({ href, label, title, children }: { href: string; label: string; title?: string; children: ReactNode }) {
  return (
    <a className="hf-txlink" href={href} target="_blank" rel="noopener noreferrer" aria-label={`${label} (opens in a new tab)`} {...(title === undefined ? {} : { title })}>
      <span className="hf-txlink__id">{children}</span>
      <OutArrow />
    </a>
  );
}

const PICTURE: Record<Exclude<KeyId, 'attester'>, KeyKind> = { viewing: 'view', agent: 'agent', access: 'access', delegate: 'delegate' };

/** The picture of a key: one of the four drawn keys, or the seal of the attester, which opens nothing. */
export function KeyPicture({ id, name, refused = false, seed = 0, className }: { id: KeyId; name: string; refused?: boolean; seed?: number; className?: string }) {
  const sized = className === undefined ? {} : { className };
  if (id === 'attester') return <SealPlate label={`${name}, drawn as a seal`} {...sized} />;
  return <KeyPlate kind={PICTURE[id]} refused={refused} seed={seed} label={refused ? `The ${name.toLowerCase()} stopped against a wall` : `${name}, drawn as a key`} {...sized} />;
}
