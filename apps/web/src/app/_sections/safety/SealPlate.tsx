'use client';

import { useCallback } from 'react';
import { DitherCanvas, type DitherGrid } from '@/ui';
import { drawSealPlate } from './seal';

/** The attester's seal on its plate. It fills the box its `className` gives it, as a `KeyPlate` does. */
export function SealPlate({ label, className }: { label: string; className?: string }) {
  const draw = useCallback(({ w, h }: DitherGrid) => drawSealPlate(w, h), []);
  return <DitherCanvas draw={draw} label={label} {...(className === undefined ? {} : { className })} />;
}
