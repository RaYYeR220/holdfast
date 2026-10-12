import type { ReactNode } from 'react';
import { INK_HEX } from '../onebit/raster';

export interface QrFrameProps {
  /** The code as rows of modules, true for a dark one. Encoding the payload is the caller's work. */
  matrix: readonly (readonly boolean[])[];
  /** What the code holds, for a reader who cannot scan it: "Payment request for 0.5 ZEC". */
  label: string;
  /** Edge of one module in CSS pixels. A multiple of 4 keeps it on the grid. */
  moduleSize?: number;
  /** Light modules left clear round the code. Four is what scanners expect. */
  quiet?: number;
  /** A line under the code, in the serif. */
  caption?: ReactNode;
  className?: string;
}

/**
 * A boolean matrix drawn as one-bit modules in a double frame. The plate is
 * always paper with ink modules, on either ground, because a scanner needs
 * dark on light. Give it the matrix of a QR code or of any other 2D code.
 */
export function QrFrame({ matrix, label, moduleSize = 4, quiet = 4, caption, className }: QrFrameProps) {
  const rows = matrix.length;
  const columns = matrix[0]?.length ?? 0;
  const size = Math.max(rows, columns) + quiet * 2;
  let path = '';
  matrix.forEach((row, y) => {
    let run = 0;
    for (let x = 0; x <= row.length; x++) {
      if (x < row.length && row[x] === true) run += 1;
      else if (run > 0) {
        path += `M${x - run + quiet} ${y + quiet}h${run}v1h${-run}z`;
        run = 0;
      }
    }
  });
  return (
    <figure className={`hf-qr${className === undefined ? '' : ` ${className}`}`}>
      <div className="hf-qr__plate">
        <svg width={size * moduleSize} height={size * moduleSize} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={label}>
          <path d={path} fill={INK_HEX} shapeRendering="crispEdges" />
        </svg>
      </div>
      {caption !== undefined && <figcaption className="hf-qr__caption">{caption}</figcaption>}
    </figure>
  );
}
