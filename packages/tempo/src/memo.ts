import type { Hex } from 'viem';

/**
 * A TIP-20 memo is a bytes32 the token emits, indexed, with every
 * `transferWithMemo`. Holdfast writes a readable reference into it: printable
 * ASCII, left-aligned, padded with zero bytes on the right, which is the
 * layout explorers and accounting tools read back as text.
 */
export const MEMO_BYTES = 32;

/** The most calls one Tempo transaction may carry; the transaction pool rejects a 33rd. */
export const MAX_LINES_PER_RUN = 32;

const FIRST_PRINTABLE = 0x20;
const LAST_PRINTABLE = 0x7e;
const RUN_ID = /^[!-.0-~]+$/;
const RUN_ID_MAX = MEMO_BYTES - `/${MAX_LINES_PER_RUN}`.length;

/** Why `text` cannot be a memo, or null when it can. */
export function memoProblem(text: string): string | null {
  if (text.length === 0) return 'memo is empty';
  if (text.length > MEMO_BYTES) return `memo "${text}" is ${text.length} bytes, the limit is ${MEMO_BYTES}`;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < FIRST_PRINTABLE || code > LAST_PRINTABLE) return `memo "${text}" has a non-printable or non-ASCII character at position ${i + 1}`;
  }
  return null;
}

/** Encode a readable reference as the bytes32 a transfer carries. */
export function memoBytes(text: string): Hex {
  const problem = memoProblem(text);
  if (problem) throw new RangeError(problem);
  let hex = '';
  for (let i = 0; i < text.length; i++) hex += text.charCodeAt(i).toString(16).padStart(2, '0');
  return `0x${hex.padEnd(MEMO_BYTES * 2, '0')}`;
}

/** Decode a bytes32 memo written by `memoBytes`; anything else is rejected. */
export function memoText(memo: string): string {
  if (!/^0x[0-9a-fA-F]{64}$/.test(memo)) throw new RangeError(`"${memo}" is not a bytes32 value`);
  let text = '';
  let padding = false;
  for (let i = 0; i < MEMO_BYTES; i++) {
    const code = Number.parseInt(memo.slice(2 + i * 2, 4 + i * 2), 16);
    if (code === 0) {
      padding = true;
    } else if (padding || code < FIRST_PRINTABLE || code > LAST_PRINTABLE) {
      throw new RangeError(`memo ${memo} is not right-padded printable ASCII`);
    } else {
      text += String.fromCharCode(code);
    }
  }
  if (text.length === 0) throw new RangeError('memo is empty');
  return text;
}

/**
 * Why `runId` cannot identify a payout run, or null when it can. A run id has
 * no spaces and no slash, and leaves room for the `/<line>` suffix of every
 * line a transaction can carry.
 */
export function runIdProblem(runId: string): string | null {
  if (runId.length === 0) return 'run id is empty';
  if (!RUN_ID.test(runId)) return `run id "${runId}" may only use printable ASCII without spaces or "/"`;
  if (runId.length > RUN_ID_MAX) return `run id "${runId}" is ${runId.length} bytes, the limit is ${RUN_ID_MAX} so that every line memo fits ${MEMO_BYTES} bytes`;
  return null;
}

/** The memo of line `line` (counted from 1) of a run: `HF-2026-10-0001/3`. */
export function lineMemo(runId: string, line: number): string {
  const problem = runIdProblem(runId);
  if (problem) throw new RangeError(problem);
  if (!Number.isInteger(line) || line < 1 || line > MAX_LINES_PER_RUN) throw new RangeError(`line ${line} is outside 1..${MAX_LINES_PER_RUN}`);
  return `${runId}/${line}`;
}

/**
 * The line number a memo carries for a run, or null when the memo is not
 * exactly `<runId>/<line>` with a line from 1 to 32. Holding every memo to
 * this one shape is what lets a run be found from its id alone: there are
 * only 32 memos it can have, and the token indexes each of them.
 */
export function lineOfMemo(memo: string, runId: string): number | null {
  if (!memo.startsWith(`${runId}/`)) return null;
  const suffix = memo.slice(runId.length + 1);
  if (!/^[1-9]\d?$/.test(suffix)) return null;
  const line = Number(suffix);
  return line <= MAX_LINES_PER_RUN ? line : null;
}

/** Every memo a run can carry. */
export function runMemos(runId: string): string[] {
  return Array.from({ length: MAX_LINES_PER_RUN }, (_, i) => lineMemo(runId, i + 1));
}
