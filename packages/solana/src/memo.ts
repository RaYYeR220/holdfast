/**
 * Longest memo the rail will put on chain. At 64 bytes a memo and its three
 * bytes of instruction framing cost at most 67 bytes of the 1232 a
 * transaction has, so a run whose every memo is at the cap still carries
 * four payees that each need a new token account.
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
const SEMICOLON = 0x3b;
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
  return field === null ? [] : scanSignatureMemos(field).memos;
}

/**
 * The first memo of a transaction as far as a `getSignaturesForAddress`
 * entry can be taken at its word, or null when it cannot.
 *
 * A null field does not mean the transaction has no memo: a node that does
 * not index the Memo program in use reports null for every transaction. The
 * same goes for a field in some other format. Only a field that parses from
 * end to end says anything, and then it says which memo comes first.
 */
export function leadingSignatureMemo(field: string | null | undefined): string | null {
  if (field === null || field === undefined) return null;
  const { memos, complete } = scanSignatureMemos(field);
  return complete ? (memos[0] ?? null) : null;
}

function scanSignatureMemos(field: string): { memos: string[]; complete: boolean } {
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
    at = end;
    if (at === bytes.length) return { memos, complete: true };
    if (bytes[at] !== SEMICOLON || bytes[at + 1] !== SPACE) break;
    at += 2;
  }
  return { memos, complete: false };
}
