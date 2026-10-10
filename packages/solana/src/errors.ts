import {
  isSolanaError,
  SOLANA_ERROR__INSTRUCTION_ERROR__CUSTOM,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE,
  type Instruction,
  type TransactionError,
} from '@solana/kit';
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

function describeCustomError(index: number, code: number, instructions: readonly Instruction[]): string {
  const base = `instruction ${index} failed: custom program error 0x${code.toString(16)}`;
  const name = instructions[index]?.programAddress === TOKEN_PROGRAM_ADDRESS ? TOKEN_ERRORS[code] : undefined;
  return name ? `${base} (Token program: ${name})` : base;
}

function stringify(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => (typeof v === 'bigint' ? v.toString() : v));
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
    return describeCustomError(Number(index), Number(detail.Custom), instructions);
  }
  return stringify(err);
}

/** Render whatever a failed RPC call threw, unwrapping a failed preflight simulation. */
export function describeFailure(error: unknown, instructions: readonly Instruction[] = []): string {
  if (isSolanaError(error, SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE)) {
    const cause: unknown = error.cause;
    if (isSolanaError(cause, SOLANA_ERROR__INSTRUCTION_ERROR__CUSTOM)) {
      const { index, code } = cause.context;
      return `simulation failed: ${describeCustomError(Number(index), Number(code), instructions)}`;
    }
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
