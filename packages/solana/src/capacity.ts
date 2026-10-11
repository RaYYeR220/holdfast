/**
 * Legacy and v0 transactions must fit one UDP packet at the IPv6 minimum MTU:
 * 1280 bytes less 48 bytes of headers.
 */
export const TRANSACTION_SIZE_LIMIT = 1232;

const SIGNATURE_BYTES = 64;
const ADDRESS_BYTES = 32;
const BLOCKHASH_BYTES = 32;
const VERSION_PREFIX_BYTES = 1;
const MESSAGE_HEADER_BYTES = 3;

/** delegate, source token account, mint, run marker, Token program, Memo program, System program */
const FIXED_ACCOUNTS = 7;
/** The Associated Token program, needed once any token account is created. */
const CREATION_ACCOUNTS = 1;

const TRANSFER_CHECKED = { accounts: 4, data: 10 };
const CREATE_TOKEN_ACCOUNT = { accounts: 6, data: 1 };
/** The two instructions that set the run marker: a transfer and an AllocateWithSeed with a 32 byte seed. */
const FUND_MARKER = { accounts: 2, data: 12 };
const ALLOCATE_MARKER = { accounts: 2, data: 116 };
const MARKER_INSTRUCTIONS = 2;

export interface PayoutLineShape {
  /** Bytes of the line's memo, 0 when it carries none. */
  memoBytes: number;
  /** Whether the payee's token account is created in the same transaction. */
  createsTokenAccount: boolean;
}

export interface PayoutShape {
  runIdBytes: number;
  lines: readonly PayoutLineShape[];
}

/** Bytes of a compact-u16 length prefix. */
function lengthPrefix(length: number): number {
  return length < 0x80 ? 1 : length < 0x4000 ? 2 : 3;
}

function instructionBytes(accounts: number, data: number): number {
  return 1 + lengthPrefix(accounts) + accounts + lengthPrefix(data) + data;
}

/**
 * Exact wire size of a payout transaction of this shape, provided every
 * payee is a distinct address. A payee paid twice in one run shares its
 * account keys, so the real transaction can only be smaller.
 */
export function payoutTransactionSize(shape: PayoutShape): number {
  const created = shape.lines.filter(line => line.createsTokenAccount).length;
  const memos = shape.lines.filter(line => line.memoBytes > 0);
  const accounts = FIXED_ACCOUNTS + shape.lines.length + created + (created > 0 ? CREATION_ACCOUNTS : 0);
  const instructions = 1 + MARKER_INSTRUCTIONS + shape.lines.length + created + memos.length;
  const instructionData =
    instructionBytes(0, shape.runIdBytes) +
    instructionBytes(FUND_MARKER.accounts, FUND_MARKER.data) +
    instructionBytes(ALLOCATE_MARKER.accounts, ALLOCATE_MARKER.data) +
    shape.lines.length * instructionBytes(TRANSFER_CHECKED.accounts, TRANSFER_CHECKED.data) +
    created * instructionBytes(CREATE_TOKEN_ACCOUNT.accounts, CREATE_TOKEN_ACCOUNT.data) +
    memos.reduce((bytes, line) => bytes + instructionBytes(0, line.memoBytes), 0);
  return (
    lengthPrefix(1) +
    SIGNATURE_BYTES +
    VERSION_PREFIX_BYTES +
    MESSAGE_HEADER_BYTES +
    lengthPrefix(accounts) +
    accounts * ADDRESS_BYTES +
    BLOCKHASH_BYTES +
    lengthPrefix(instructions) +
    instructionData +
    lengthPrefix(0)
  );
}

export interface PayoutFitQuery {
  lines: number;
  runIdBytes: number;
  /** Bytes of each line's memo; 0, the default, for a run that carries only its run memo. */
  lineMemoBytes?: number;
  /** Payees that still need a token account. Defaults to all of them, the worst case. */
  newTokenAccounts?: number;
}

export interface PayoutFit {
  size: number;
  limit: number;
  fits: boolean;
}

/** Whether a run of `lines` payees fits in one transaction, and how large it would be. */
export function estimatePayoutFit(query: PayoutFitQuery): PayoutFit {
  const created = Math.min(query.newTokenAccounts ?? query.lines, query.lines);
  const lines = Array.from({ length: query.lines }, (_, index) => ({
    memoBytes: query.lineMemoBytes ?? 0,
    createsTokenAccount: index < created,
  }));
  const size = payoutTransactionSize({ runIdBytes: query.runIdBytes, lines });
  return { size, limit: TRANSACTION_SIZE_LIMIT, fits: size <= TRANSACTION_SIZE_LIMIT };
}

export interface PayoutCapacityQuery {
  runIdBytes: number;
  lineMemoBytes?: number;
  /** Whether the payees still need token accounts. Defaults to true, the worst case. */
  newTokenAccounts?: boolean;
}

/** The largest run of identical-looking lines that fits one transaction. */
export function maxPayoutLines(query: PayoutCapacityQuery): number {
  const fits = (lines: number): boolean =>
    estimatePayoutFit({
      lines,
      runIdBytes: query.runIdBytes,
      lineMemoBytes: query.lineMemoBytes ?? 0,
      newTokenAccounts: query.newTokenAccounts === false ? 0 : lines,
    }).fits;
  let lines = 0;
  while (fits(lines + 1)) lines++;
  return lines;
}
