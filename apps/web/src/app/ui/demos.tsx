'use client';

import { useCallback, useState } from 'react';
import { Button, Dialog, DitherCanvas, type DitherGrid, type DitherPicture, FORCE_PAPER, Raster, STATES, STATE_LABEL, fillState, hash } from '@/ui';

/** A button that opens the dialog, as a page would wire it. */
export function DialogDemo() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)}>
        Open the dialog
      </Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Turn the lock off"
        actions={
          <>
            <Button variant="quiet" onClick={() => setOpen(false)}>
              Keep it on
            </Button>
            <Button variant="destructive" onClick={() => setOpen(false)}>
              Turn the lock off
            </Button>
          </>
        }
      >
        <p>The controller will buy the short back and the treasury will follow the ZEC price again.</p>
        <p>Nothing moves on Zcash. The margin stays on your own Hyperliquid account.</p>
      </Dialog>
    </>
  );
}

/** A button that shows its busy state for two seconds when pressed. */
export function BusyDemo() {
  const [busy, setBusy] = useState(false);
  return (
    <Button
      variant="secondary"
      busy={busy}
      onClick={() => {
        setBusy(true);
        window.setTimeout(() => setBusy(false), 2000);
      }}
    >
      {busy ? 'Working' : 'Press to see busy'}
    </Button>
  );
}

/**
 * DitherCanvas with a drawing of its own: the five state fills as columns
 * whose heights breathe. It moves at eight frames a second while on screen
 * and is drawn once, level, when motion is reduced.
 */
export function CanvasDemo() {
  const draw = useCallback(({ w, h, frame, still }: DitherGrid): DitherPicture => {
    const raster = new Raster(w, h);
    const gap = 3;
    const width = Math.max(6, Math.floor((w - gap * (STATES.length + 1)) / STATES.length));
    const floor = h - 12;
    for (let x = 2; x < w - 2; x++) raster.set(x, floor + 1, FORCE_PAPER);
    const labels = STATES.map((state, index) => {
      const x = gap + index * (width + gap);
      const level = still ? 0.62 : 0.62 + 0.18 * Math.sin(frame * 0.22 + index * 1.3) + (hash(index, frame >> 3, 4) - 0.5) * 0.04;
      const height = Math.max(6, Math.round((floor - 6) * level));
      fillState(raster, state, x, floor - height, width, height);
      return { text: STATE_LABEL[state], x, y: floor + 4, plate: false };
    });
    return { bits: raster, labels };
  }, []);
  return <DitherCanvas draw={draw} fps={8} label="The five state fills as columns: solid, checker, stair hatch, dotted outline, sparse dots." className="ref-canvas" />;
}
