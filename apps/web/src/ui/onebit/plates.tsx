'use client';

import { useCallback } from 'react';
import { DitherCanvas, type DitherGrid } from './DitherCanvas';
import { type KeyKind, drawBooksPlate, drawChainPlate, drawKeyPlate } from './objects';

/**
 * The drawn objects as components. Each fills the box its `className` or
 * `style` gives it and redraws when that box changes size.
 */

export interface KeyPlateProps {
  kind: KeyKind;
  /** The key stopped against a hatched wall. */
  refused?: boolean;
  seed?: number;
  label: string;
  className?: string;
}

/** One of the keys on its plate. The spending key is an outline: it is the key that is not held. */
export function KeyPlate({ kind, refused = false, seed = 0, label, className }: KeyPlateProps) {
  const draw = useCallback(({ w, h }: DitherGrid) => drawKeyPlate(w, h, kind, { refused, seed }), [kind, refused, seed]);
  return <DitherCanvas draw={draw} label={label} {...(className === undefined ? {} : { className })} />;
}

export interface ChainPlateProps {
  variant?: number;
  /** A level chain with nothing thrown off it. */
  flat?: boolean;
  /** Height in design pixels the links are sized against. */
  designHeight?: number;
  designWidth?: number;
  label?: string;
  className?: string;
}

/** A chain pulled taut: the picture of a refusal. */
export function ChainPlate({ variant = 0, flat = false, designHeight = 104, designWidth = 150, label, className }: ChainPlateProps) {
  const draw = useCallback(
    ({ w, h }: DitherGrid) => drawChainPlate(w, h, { variant, flat, scale: Math.min(h / designHeight, w / designWidth) }),
    [variant, flat, designHeight, designWidth],
  );
  return <DitherCanvas draw={draw} {...(label === undefined ? {} : { label })} {...(className === undefined ? {} : { className })} />;
}

/** The books: a ruled page with every line ticked. */
export function BooksPlate({ label, className }: { label: string; className?: string }) {
  const draw = useCallback(({ w, h }: DitherGrid) => drawBooksPlate(w, h), []);
  return <DitherCanvas draw={draw} label={label} {...(className === undefined ? {} : { className })} />;
}
