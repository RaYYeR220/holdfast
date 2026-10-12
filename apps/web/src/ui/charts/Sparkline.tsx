export interface SparklineProps {
  values: readonly number[];
  /** What the line shows and where it ends, for a reader who cannot see it. */
  label: string;
  /** Size of the drawing in design pixels. */
  columns?: number;
  rows?: number;
  /** CSS pixels to a design pixel: 4 on the grid, 2 inside a table row. */
  unit?: number;
  /** Dot the area under the line at a quarter tone. */
  filled?: boolean;
  className?: string;
}

/**
 * A small one-bit line for a row of a table or the corner of a stat: the
 * shape of a series and nothing more. It is drawn on the server as a few
 * rectangles, in the ink of the text beside it.
 */
export function Sparkline({ values, label, columns = 40, rows = 8, unit = 4, filled = false, className }: SparklineProps) {
  const low = Math.min(...values);
  const high = Math.max(...values);
  const span = high - low || 1;
  let path = '';
  let before: number | null = null;
  for (let x = 0; x < columns && values.length > 0; x++) {
    const f = columns <= 1 ? 0 : (x / (columns - 1)) * (values.length - 1);
    const a = Math.floor(f);
    const va = values[a] as number;
    const vb = values[Math.min(values.length - 1, a + 1)] as number;
    const y = Math.round((1 - (va + (vb - va) * (f - a) - low) / span) * (rows - 1));
    const top = before === null ? y : Math.min(before, y);
    const bottom = before === null ? y : Math.max(before, y);
    path += `M${x} ${top}h1v${bottom - top + 1}h-1z`;
    if (filled) for (let j = bottom + 2; j < rows; j++) if ((x & 1) === 0 && (j & 1) === 0) path += `M${x} ${j}h1v1h-1z`;
    before = y;
  }
  return (
    <svg className={`hf-spark${className === undefined ? '' : ` ${className}`}`} width={columns * unit} height={rows * unit} viewBox={`0 0 ${columns} ${rows}`} role="img" aria-label={label}>
      <path d={path} shapeRendering="crispEdges" />
    </svg>
  );
}
