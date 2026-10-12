'use client';

import { type KeyboardEvent, type ReactNode, useId, useRef, useState } from 'react';

export interface TabItem {
  id: string;
  label: ReactNode;
  content: ReactNode;
}

export interface TabsProps {
  /** Names the set of tabs for assistive technology. */
  label: string;
  items: readonly TabItem[];
  /** Controlled selection. Leave it out and the tabs keep their own, starting at `defaultId` or the first. */
  selectedId?: string;
  defaultId?: string;
  onSelect?: (id: string) => void;
  className?: string;
}

/**
 * Views of one thing, one shown at a time. The selected tab is the solid one.
 * Arrow keys move between tabs, Home and End jump to the ends, and Tab moves
 * from the tab into its panel.
 */
export function Tabs({ label, items, selectedId, defaultId, onSelect, className }: TabsProps) {
  const base = useId();
  const [own, setOwn] = useState(defaultId ?? items[0]?.id);
  const current = selectedId ?? own;
  const tabs = useRef<Map<string, HTMLButtonElement>>(new Map());

  const select = (id: string) => {
    if (selectedId === undefined) setOwn(id);
    onSelect?.(id);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const at = items.findIndex((item) => item.id === current);
    let to = -1;
    if (event.key === 'ArrowRight') to = (at + 1) % items.length;
    else if (event.key === 'ArrowLeft') to = (at - 1 + items.length) % items.length;
    else if (event.key === 'Home') to = 0;
    else if (event.key === 'End') to = items.length - 1;
    const next = items[to];
    if (next === undefined) return;
    event.preventDefault();
    select(next.id);
    tabs.current.get(next.id)?.focus();
  };

  return (
    <div className={`hf-tabs${className === undefined ? '' : ` ${className}`}`}>
      <div className="hf-tabs__list" role="tablist" aria-label={label} onKeyDown={onKeyDown}>
        {items.map((item) => (
          <button
            key={item.id}
            ref={(element) => {
              if (element === null) tabs.current.delete(item.id);
              else tabs.current.set(item.id, element);
            }}
            type="button"
            role="tab"
            id={`${base}-tab-${item.id}`}
            aria-selected={item.id === current}
            aria-controls={`${base}-panel-${item.id}`}
            tabIndex={item.id === current ? 0 : -1}
            className="hf-tabs__tab"
            onClick={() => select(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>
      {items.map((item) => (
        <div key={item.id} role="tabpanel" id={`${base}-panel-${item.id}`} aria-labelledby={`${base}-tab-${item.id}`} className="hf-tabs__panel" tabIndex={0} hidden={item.id !== current}>
          {item.id === current && item.content}
        </div>
      ))}
    </div>
  );
}
