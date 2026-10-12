import type { ReactNode } from 'react';
import { type State, STATE_LABEL } from '../onebit/patterns';
import { Swatch } from './Tag';

export interface Column<K extends string = string> {
  key: K;
  header: ReactNode;
  /** Right-aligned in the numeric face, for amounts and counts. */
  numeric?: boolean;
  /** The cell of this column names the row: it is rendered as a row header. */
  rowHeader?: boolean;
  /** Any CSS width for the column. */
  width?: string;
}

export interface Row<K extends string = string> {
  /** Stable key of the row. */
  id: string;
  cells: Record<K, ReactNode>;
  /** A state the whole row carries. It adds a leading cell with the pattern and the word. */
  state?: State;
  /** Overrides the word of `state` for this row. */
  stateLabel?: string;
}

export interface DataTableProps<K extends string = string> {
  columns: readonly Column<K>[];
  rows: readonly Row<K>[];
  /** Names the table. Shown above it unless `captionHidden`. */
  caption: string;
  captionHidden?: boolean;
  /** Tighter rows, for long lists. */
  dense?: boolean;
  /** Shown in place of the body when there are no rows. Say what is absent. */
  empty?: ReactNode;
  className?: string;
}

/**
 * A dense table. Text cells are set in the serif and figures in the numeric
 * face, right-aligned on tabular digits. A row may carry one of the five
 * states: it then starts with the state's pattern and word, and a refused row
 * is also struck along its lower edge. On a narrow screen the table scrolls
 * sideways inside its own region rather than squeezing its columns.
 */
export function DataTable<K extends string = string>({ columns, rows, caption, captionHidden = false, dense = false, empty, className }: DataTableProps<K>) {
  const stateful = rows.some((row) => row.state !== undefined);
  const span = columns.length + (stateful ? 1 : 0);
  return (
    <div className={`hf-table-wrap${className === undefined ? '' : ` ${className}`}`} role="region" aria-label={caption} tabIndex={0}>
      <table className={dense ? 'hf-table hf-table--dense' : 'hf-table'}>
        <caption className={captionHidden ? 'hf-sr' : undefined}>{caption}</caption>
        <thead>
          <tr>
            {stateful && (
              <th scope="col" className="hf-table__state">
                State
              </th>
            )}
            {columns.map((column) => (
              <th key={column.key} scope="col" className={column.numeric === true ? 'hf-table__num' : undefined} style={column.width === undefined ? undefined : { width: column.width }}>
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colSpan={span} className="hf-table__empty">
                {empty ?? 'Nothing here yet.'}
              </td>
            </tr>
          )}
          {rows.map((row) => (
            <tr key={row.id} {...(row.state === undefined ? {} : { 'data-state': row.state })}>
              {stateful && (
                <td className="hf-table__state">
                  {row.state !== undefined && (
                    <span className="hf-tag">
                      <Swatch state={row.state} />
                      {row.stateLabel ?? STATE_LABEL[row.state]}
                    </span>
                  )}
                </td>
              )}
              {columns.map((column) =>
                column.rowHeader === true ? (
                  <th key={column.key} scope="row">
                    {row.cells[column.key]}
                  </th>
                ) : (
                  <td key={column.key} className={column.numeric === true ? 'hf-table__num' : undefined}>
                    {row.cells[column.key]}
                  </td>
                ),
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
