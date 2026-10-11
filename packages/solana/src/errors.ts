import {
  isSolanaError,
  SOLANA_ERROR__INSTRUCTION_ERROR__CUSTOM,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE,
  type Instruction,
  type TransactionError,
} from '@solana/kit';
import { SYSTEM_PROGRAM_ADDRESS } from '@solana-program/system';
import { TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';

/** `TokenError` variants of the Token program, indexed by their custom error code. */
const TOKEN_ERRORS = [
  'NotRentExempt',
  'InsufficientFunds',
  'InvalidMint',
  'MintMismatch',
  'OwnerMismatch',
  'FixedSupply',
  'AlreadyInUse',
  'InvalidNumberOfProvidedSigners',
  'InvalidNumberOfRequiredSigners',
  'UninitializedState',
  'NativeNotSupported',
  'NonNativeHasBalance',
  'InvalidInstruction',
  'InvalidState',
  'Overflow',
  'AuthorityTypeNotSupported',
  'MintCannotFreeze',
  'AccountFrozen',
  'MintDecimalsMismatch',
  'NonNativeNotSupported',
] as const;

/** `SystemError` variants of the System program, indexed by their custom error code. */
const SYSTEM_ERRORS = [
  'AccountAlreadyInUse',
  'ResultWithNegativeLamports',
  'InvalidProgramId',
  'InvalidAccountDataLength',
  'MaxSeedLengthExceeded',
  'AddressWithSeedMismatch',
  'NonceNoRecentBlockhashes',
  'NonceBlockhashNotExpired',
  'NonceUnexpectedBlockhashValue',
] as const;

/** A program's own error code, and the instruction of the transaction that returned it. */
export interface CustomError {
  index: number;
  code: number;
}

function describeCustomError({ index, code }: CustomError, instructions: readonly Instruction[]): string {
  const base = `instruction ${index} failed: custom program error 0x${code.toString(16)}`;
  const program = instructions[index]?.programAddress;
  if (program === TOKEN_PROGRAM_ADDRESS && TOKEN_ERRORS[code]) return `${base} (Token program: ${TOKEN_ERRORS[code]})`;
  if (program === SYSTEM_PROGRAM_ADDRESS && SYSTEM_ERRORS[code]) {
    return `${base} (System program: ${SYSTEM_ERRORS[code]})`;
  }
  return base;
}

/** The custom program error a processed transaction failed with, if that is how it failed. */
export function customErrorOf(err: TransactionError | null): CustomError | null {
  if (err === null || typeof err === 'string' || !('InstructionError' in err)) return null;
  const [index, detail] = err.InstructionError;
  return typeof detail === 'string' ? null : { index: Number(index), code: Number(detail.Custom) };
}

/** The custom program error a preflight simulation failed with, if that is why a send was refused. */
export function simulatedCustomError(error: unknown): CustomError | null {
  if (!isSolanaError(error, SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE)) return null;
  const cause: unknown = error.cause;
  if (!isSolanaError(cause, SOLANA_ERROR__INSTRUCTION_ERROR__CUSTOM)) return null;
  return { index: Number(cause.context.index), code: Number(cause.context.code) };
}

/** Kit hands over the integers in an error as bigints; they are indices and codes, small enough to print as numbers. */
function stringify(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => (typeof v === 'bigint' ? Number(v) : v));
}

/**
 * Render the `err` of a processed transaction. `instructions` are those of
 * the transaction, so a custom error code can be attributed to its program.
 */
export function describeTransactionError(err: TransactionError, instructions: readonly Instruction[] = []): string {
  if (typeof err === 'string') return err;
  if ('InstructionError' in err) {
    const [index, detail] = err.InstructionError;
    if (typeof detail === 'string') return `instruction ${Number(index)} failed: ${detail}`;
    return describeCustomError({ index: Number(index), code: Number(detail.Custom) }, instructions);
  }
  return stringify(err);
}

/** Render whatever a failed RPC call threw, unwrapping a failed preflight simulation. */
export function describeFailure(error: unknown, instructions: readonly Instruction[] = []): string {
  if (isSolanaError(error, SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE)) {
    const custom = simulatedCustomError(error);
    if (custom) return `simulation failed: ${describeCustomError(custom, instructions)}`;
    const cause: unknown = error.cause;
    return `simulation failed: ${cause instanceof Error ? cause.message : error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * True when the RPC node itself answered with a JSON-RPC error, which means
 * it did not accept the request. Kit numbers those errors with the node's
 * own negative codes; transport failures use positive ones.
 */
export function isRejectionByNode(error: unknown): boolean {
  return isSolanaError(error) && error.context.__code < 0;
}
