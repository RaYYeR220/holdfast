import { type PublishedStatement, stringifyExact } from '@holdfast/books';

export type StepStatus = 'PASS' | 'FAIL' | 'SKIPPED';

export type StepId = 'journal' | 'zcash' | 'hyperliquid' | 'reconciliation' | 'arithmetic';

export interface StepResult {
  id: StepId;
  status: StepStatus;
  /** One line saying what was checked, or why it was not. */
  reason: string;
  /** What exactly differs or was noted, one item a line. */
  details: string[];
}

const TITLES: Record<StepId, string> = {
  journal: 'journal chain',
  zcash: 'zcash',
  hyperliquid: 'hyperliquid',
  reconciliation: 'reconciliation',
  arithmetic: 'arithmetic',
};

export const pass = (id: StepId, reason: string, details: string[] = []): StepResult => ({ id, status: 'PASS', reason, details });
export const fail = (id: StepId, reason: string, details: string[] = []): StepResult => ({ id, status: 'FAIL', reason, details });
export const skipped = (id: StepId, reason: string): StepResult => ({ id, status: 'SKIPPED', reason, details: [] });

export const describeError = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** A long list is cut after its first items; the count of the rest keeps the cut visible. */
export function firstFew(items: readonly string[], limit = 10): string[] {
  return items.length <= limit ? [...items] : [...items.slice(0, limit), `and ${items.length - limit} more`];
}

const count = (steps: readonly StepResult[], status: StepStatus) => steps.filter((s) => s.status === status).length;

export function verdict(steps: readonly StepResult[]): string {
  const failed = count(steps, 'FAIL');
  const skippedCount = count(steps, 'SKIPPED');
  const unchecked = skippedCount === 0 ? '' : `; ${skippedCount} step${skippedCount === 1 ? ' was' : 's were'} skipped and proved nothing`;
  if (failed > 0) return `NOT VERIFIED: ${failed} step${failed === 1 ? '' : 's'} failed${unchecked}.`;
  return `Verified: ${count(steps, 'PASS')} of ${steps.length} steps passed${unchecked}.`;
}

export function renderText(file: string, published: PublishedStatement, steps: readonly StepResult[]): string[] {
  const lines = [
    `Statement ${file}`,
    `  ${published.org.name} (${published.org.id}), as of ${new Date(published.statement.asOf).toISOString()}`,
    '',
  ];
  for (const step of steps) {
    lines.push(`  ${step.status.padEnd(8)}${TITLES[step.id].padEnd(16)}${step.reason}`);
    for (const detail of step.details) lines.push(`${' '.repeat(26)}- ${detail}`);
  }
  lines.push('', verdict(steps));
  return lines;
}

export function renderJson(file: string, published: PublishedStatement, steps: readonly StepResult[]): string {
  return stringifyExact(
    {
      ok: count(steps, 'FAIL') === 0,
      file,
      org: { id: published.org.id, name: published.org.name },
      asOf: published.statement.asOf,
      steps: steps.map((step) => ({ ...step, title: TITLES[step.id] })),
    },
    2,
  );
}
