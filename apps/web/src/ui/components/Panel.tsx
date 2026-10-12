import type { ReactNode } from 'react';
import type { State } from '../onebit/patterns';
import { StateTag } from './Tag';

export interface PanelProps {
  /** The panel's name, set in the pixel face in its head. */
  title?: ReactNode;
  /** Heading level of the title. Three when omitted. */
  level?: 2 | 3 | 4;
  /** A state shown at the right of the head, as its pattern and its word. */
  state?: State;
  /** Overrides the word of `state`. */
  stateLabel?: string;
  /** Anything else for the right of the head: an action, a timestamp. */
  aside?: ReactNode;
  foot?: ReactNode;
  /** A double frame, for the one panel a view is about. */
  framed?: boolean;
  /** Drawn on the other ground. */
  inverse?: boolean;
  /** No padding round the body: for a table or a picture that runs edge to edge. */
  flush?: boolean;
  className?: string;
  children?: ReactNode;
}

/** A framed region of a screen. Product pages are built from these. */
export function Panel({ title, level = 3, state, stateLabel, aside, foot, framed = false, inverse = false, flush = false, className, children }: PanelProps) {
  const Heading = `h${level}` as 'h2' | 'h3' | 'h4';
  const name = ['hf-panel', framed ? 'hf-panel--framed' : '', inverse ? 'hf-panel--inverse' : '', className ?? ''].filter(Boolean).join(' ');
  const head = title !== undefined || state !== undefined || aside !== undefined;
  return (
    <section className={name}>
      {head && (
        <header className="hf-panel__head">
          {title !== undefined && <Heading className="hf-panel__title">{title}</Heading>}
          {(state !== undefined || aside !== undefined) && (
            <div className="hf-panel__aside">
              {aside}
              {state !== undefined && <StateTag state={state} {...(stateLabel === undefined ? {} : { label: stateLabel })} />}
            </div>
          )}
        </header>
      )}
      <div className={flush ? 'hf-panel__body hf-panel__body--flush' : 'hf-panel__body'}>{children}</div>
      {foot !== undefined && <footer className="hf-panel__foot">{foot}</footer>}
    </section>
  );
}

export interface PlateProps {
  framed?: boolean;
  className?: string;
  children?: ReactNode;
}

/** The ink plate a picture is printed on. Pictures are ink plates on either ground. */
export function Plate({ framed = false, className, children }: PlateProps) {
  return <div className={['hf-plate', framed ? 'hf-plate--framed' : '', className ?? ''].filter(Boolean).join(' ')}>{children}</div>;
}
