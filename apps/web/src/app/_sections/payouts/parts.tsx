import type { CSSProperties, ReactNode } from 'react';
import { CopyButton, Link, Timestamp, Unavailable, shorten } from '@/ui';
import { formatAhead } from './format';

/** Names of the sources as a reader knows them. */
const SOURCE: Record<string, string> = {
  tempo: 'Tempo',
  solana: 'Solana',
  database: 'the database',
  configuration: 'the settings of this deployment',
};

export const sourceName = (source: string): string => SOURCE[source] ?? source;

export interface Gap {
  source: string;
  reason: string;
  at: number;
}

/**
 * A read that failed, in the place of what it would have shown.
 *
 * A timestamp keeps a clock of its own once it is on the page. When the page
 * is read again from the server it has to start from the server's clock
 * again, or a reading newer than its clock shows as lying in the future; so
 * every timestamp of the section is keyed on the moment it shows.
 */
export function GapNote({ gap, now, inline = false }: { gap: Gap; now: number; inline?: boolean }) {
  return <Unavailable key={gap.at} reason={gap.reason} source={sourceName(gap.source)} at={gap.at} now={now} inline={inline} />;
}

/** The line under a figure that says when it was read and where. */
export function AsOf({ at, now, source }: { at: number; now: number; source: string }) {
  return (
    <p className="hf-small po-asof">
      as of <Timestamp key={at} at={at} now={now} />, from {sourceName(source)}
    </p>
  );
}

/** A moment that may lie ahead, such as an expiry: the time itself and how far off it is, either way. */
export function Moment({ at, now }: { at: number; now: number }) {
  const ahead = formatAhead(at, now);
  if (ahead === null) return <Timestamp key={at} at={at} now={now} />;
  return (
    <span className="po-moment">
      <Timestamp at={at} now={now} show="absolute" />, {ahead}
    </span>
  );
}

/** When something happened, on two lines: the time, and under it what happened and how long ago. */
export function When({ at, now, what }: { at: number; now: number; what: string }) {
  return (
    <span className="po-when">
      <Timestamp at={at} now={now} show="absolute" />
      <span className="po-when__rel">
        {what} <Timestamp key={at} at={at} now={now} show="relative" />
      </span>
    </span>
  );
}

export interface AddressProps {
  value: string;
  /** The address on its chain's explorer. Without it the address is text only. */
  href?: string | null | undefined;
  /** What the address is, for the names of the link and the copy button: "Tempo account", "delegate". */
  what: string;
  /** Show the whole address instead of its two ends. */
  whole?: boolean;
}

/** An address: its two ends in the numeric face, linked to its explorer where there is one, with a button that copies all of it. */
export function Address({ value, href, what, whole = false }: AddressProps) {
  const text = (
    <span className="hf-num" title={value}>
      {whole ? value : shorten(value, 6, 6)}
    </span>
  );
  return (
    <span className={whole ? 'po-address po-address--whole' : 'po-address'}>
      {href === undefined || href === null ? (
        text
      ) : (
        <Link href={href} external aria-label={`The ${what} ${shorten(value, 6, 6)} on the explorer`}>
          {text}
        </Link>
      )}
      <CopyButton value={value} what={what} />
    </span>
  );
}

export interface LedgerColumn<K extends string = string> {
  key: K;
  header: string;
  /** Right-aligned in the numeric face. */
  numeric?: boolean;
  /** The cell of this column names the row. */
  rowHeader?: boolean;
  /** Takes a whole line of the row where the ledger is stacked: for a value that does not fit half of a narrow screen. */
  wide?: boolean;
}

export interface LedgerRow<K extends string = string> {
  id: string;
  cells: Record<K, ReactNode>;
}

export interface LedgerProps<K extends string = string> {
  /** Names the table for a reader who cannot see it. */
  caption: string;
  columns: readonly LedgerColumn<K>[];
  rows: readonly LedgerRow<K>[];
  /** The widths of the columns where the ledger is a table, as a grid template. */
  template: string;
  className?: string;
}

/**
 * A table of the section that does not scroll sideways on a narrow screen:
 * from a certain width down each row becomes a block in which every value
 * stands under the name of its column. It is a table to assistive technology
 * at every width.
 */
export function Ledger<K extends string = string>({ caption, columns, rows, template, className }: LedgerProps<K>) {
  const cellClass = (column: LedgerColumn<K>) =>
    ['po-ledger__cell', column.numeric === true ? 'po-ledger__num' : '', column.rowHeader === true ? 'po-ledger__name' : '', column.wide === true ? 'po-ledger__wide' : ''].filter(Boolean).join(' ');
  return (
    <div className={`po-ledger${className === undefined ? '' : ` ${className}`}`} role="table" aria-label={caption} style={{ '--po-columns': template } as CSSProperties}>
      <div role="rowgroup">
        <div className="po-ledger__head" role="row">
          {columns.map((column) => (
            <span key={column.key} role="columnheader" className={column.numeric === true ? 'po-ledger__num' : undefined}>
              {column.header}
            </span>
          ))}
        </div>
      </div>
      <div role="rowgroup">
        {rows.map((row) => (
          <div className="po-ledger__row" role="row" key={row.id}>
            {columns.map((column) => (
              <div key={column.key} role={column.rowHeader === true ? 'rowheader' : 'cell'} className={cellClass(column)}>
                <span className="po-ledger__label" aria-hidden="true">
                  {column.header}
                </span>
                <div className="po-ledger__value">{row.cells[column.key]}</div>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

/** A named fact of a rail or a run with, under it, the sentence that says what it means. */
export function Fact({ children, note }: { children: ReactNode; note?: ReactNode }) {
  return (
    <>
      {children}
      {note !== undefined && <span className="po-fact__note">{note}</span>}
    </>
  );
}
