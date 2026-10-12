import type { ReactNode } from 'react';

export interface KeyValueItem {
  /** The name of the value, in a few words. */
  label: ReactNode;
  value: ReactNode;
  /** Stable key when labels repeat or are not strings. */
  id?: string;
}

export interface KeyValueProps {
  items: readonly KeyValueItem[];
  /** Put each value under its label instead of beside it. */
  stacked?: boolean;
  className?: string;
}

/** A list of named values, each on a dotted rule: the facts of one thing. */
export function KeyValue({ items, stacked = false, className }: KeyValueProps) {
  return (
    <dl className={['hf-kv', stacked ? 'hf-kv--stack' : '', className ?? ''].filter(Boolean).join(' ')}>
      {items.map((item, index) => (
        <div key={item.id ?? (typeof item.label === 'string' ? item.label : index)}>
          <dt>{item.label}</dt>
          <dd>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}
