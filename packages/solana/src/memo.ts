/**
 * Longest memo the rail will put on chain. At 64 bytes a memo and its three
 * bytes of instruction framing cost at most 67 bytes of the 1232 a
 * transaction has, so a run whose every memo is at the cap still carries
 * five payees that each need a new token account.
 */
export const MAX_MEMO_LENGTH = 64;

const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;

/**
 * Why a memo cannot be used, or `null` when it can. Memos are restricted to
 * printable ASCII so one character is one byte and what the books store is
 * exactly what an explorer shows.
 */
export function validateMemo(memo: string): string | null {
  if (memo.length === 0) return 'memo is empty';
  if (memo.length > MAX_MEMO_LENGTH) return `memo is longer than ${MAX_MEMO_LENGTH} characters`;
  if (!PRINTABLE_ASCII.test(memo)) return 'memo must be printable ASCII';
  if (memo !== memo.trim()) return 'memo must not start or end with a space';
  return null;
}

const OPEN_BRACKET = 0x5b;
const CLOSE_BRACKET = 0x5d;
const SPACE = 0x20;

/**
 * Split the `memo` field of a `getSignaturesForAddress` entry into the memos
 * of that transaction, in instruction order.
 *
 * The RPC node flattens every memo of a transaction into one string, each
 * prefixed with its byte length and joined with "; ":
 * `[15] HF-2026-10-0001; [8] INV-1041`. Only the length prefix delimits
 * reliably, because a memo may itself contain "; [".
 */
export function parseSignatureMemos(field: string | null): string[] {
  if (field === null) return [];
  const bytes = new TextEncoder().encode(field);
  const decoder = new TextDecoder();
  const memos: string[] = [];
  let at = 0;
  while (at < bytes.length) {
    const close = bytes.indexOf(CLOSE_BRACKET, at);
    if (bytes[at] !== OPEN_BRACKET || close === -1 || bytes[close + 1] !== SPACE) break;
    const digits = decoder.decode(bytes.subarray(at + 1, close));
    const start = close + 2;
    const end = start + Number(digits);
    if (!/^\d+$/.test(digits) || end > bytes.length) break;
    memos.push(decoder.decode(bytes.subarray(start, end)));
    at = end + 2;
  }
  return memos;
}
