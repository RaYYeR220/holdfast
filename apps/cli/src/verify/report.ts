import { type PublishedStatement, stringifyExact } from '@holdfast/books';

export type StepStatus = 'PASS' | 'FAIL' | 'SKIPPED';

export type StepId = 'journal' | 'zcash' | 'hyperliquid' | 'reconciliation' | 'arithmetic';

export interface StepResult {
  id: StepId;
  status: StepStatus;
  /** One line saying what was checked, or why it was not. */
  reason: string;
  /** What exactly differs, and what a pass still rests on, one item a line. */
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

type CodeRange = readonly [first: number, last: number];

/** The ASCII control characters, line breaks among them. */
const ASCII_CONTROLS: readonly CodeRange[] = [[0x00, 0x1f]];

/**
 * The rest of what must not reach a terminal as it is: DEL and the second
 * block of control characters, the marks that reverse the direction of text,
 * and the two Unicode line breaks.
 */
const OTHER_UNPRINTABLE: readonly CodeRange[] = [
  [0x7f, 0x9f],
  [0x200e, 0x200f],
  [0x2028, 0x202e],
  [0x2066, 0x2069],
];

function escapeCodes(text: string, ranges: readonly CodeRange[]): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    const hit = ranges.some(([first, last]) => code >= first && code <= last);
    out += hit ? `\\u${code.toString(16).padStart(4, '0')}` : text.charAt(i);
  }
  return out;
}

/**
 * Text as it is safe to print. Names, memos and addresses come out of the
 * statement being checked, and a terminal obeys what it is sent: a line break
 * could forge a line of this report, and an escape sequence could move the
 * cursor and write PASS over a FAIL. Such characters are shown as the codes
 * they are.
 */
export function printable(text: string): string {
  return escapeCodes(text, [...ASCII_CONTROLS, ...OTHER_UNPRINTABLE]);
}

/**
 * Verified means every step ran and passed. A step that was not run proved
 * nothing, so a statement with one is not verified, however clean the rest.
 */
export type Verdict = 'verified' | 'not verified' | 'failed';

const titlesOf = (steps: readonly StepResult[], status: StepStatus) => steps.filter((s) => s.status === status).map((s) => TITLES[s.id]);

export function verdictOf(steps: readonly StepResult[]): Verdict {
  if (steps.some((s) => s.status === 'FAIL')) return 'failed';
  return steps.every((s) => s.status === 'PASS') ? 'verified' : 'not verified';
}

export function verdictLine(steps: readonly StepResult[]): string {
  const failed = titlesOf(steps, 'FAIL');
  const notRun = titlesOf(steps, 'SKIPPED');
  if (failed.length > 0) return `FAILED: ${failed.join(', ')}.${notRun.length === 0 ? '' : ` Not run: ${notRun.join(', ')}.`}`;
  if (notRun.length > 0) {
    const were = notRun.length === 1 ? 'was' : 'were';
    return `NOT VERIFIED: ${notRun.join(', ')} ${were} not run, and a statement is verified only when every step has passed. The steps that ran found nothing wrong.`;
  }
  return `VERIFIED: all ${steps.length} steps passed.`;
}

function age(ms: number): string {
  const minutes = Math.round(Math.abs(ms) / 60_000);
  if (minutes < 120) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.round(minutes / 60);
  return hours < 72 ? `${hours} hours` : `${Math.round(hours / 24)} days`;
}

/** When the statement says it was made, and how long ago that is by this machine's clock. */
function moment(asOf: number, now: number): string {
  const date = Math.abs(asOf) <= 8.64e15 ? new Date(asOf).toISOString() : 'a date no calendar holds';
  return now >= asOf ? `${date}, ${age(now - asOf)} ago` : `${date}, ${age(asOf - now)} from now`;
}

export function renderText(file: string, published: PublishedStatement, steps: readonly StepResult[], now: number): string[] {
  const lines = [`Statement ${file}`, `  ${published.org.name} (${published.org.id}), as of ${moment(published.statement.asOf, now)}`, ''];
  for (const step of steps) {
    lines.push(`  ${step.status.padEnd(8)}${TITLES[step.id].padEnd(16)}${step.reason}`);
    for (const detail of step.details) lines.push(`${' '.repeat(26)}- ${detail}`);
  }
  lines.push('', verdictLine(steps));
  return lines.map(printable);
}

export function renderJson(file: string, published: PublishedStatement, steps: readonly StepResult[], now: number): string {
  const verdict = verdictOf(steps);
  const json = stringifyExact(
    {
      ok: verdict === 'verified',
      verdict,
      file,
      org: { id: published.org.id, name: published.org.name },
      asOf: published.statement.asOf,
      ageMs: now - published.statement.asOf,
      steps: steps.map((step) => ({ ...step, title: TITLES[step.id] })),
    },
    2,
  );
  // JSON escapes the ASCII control characters itself, and its own line breaks are structure. The rest can only occur
  // inside its strings, where an escape stands for the same character.
  return escapeCodes(json, OTHER_UNPRINTABLE);
}
