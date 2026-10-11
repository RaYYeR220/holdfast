import { describe, expect, it } from 'vitest';
import { customErrorOf, describeFailure, describeTransactionError } from '../src/errors';
import { payoutInstructions } from '../src/payout';
import { planOf } from './fixtures';

// Memo, Transfer, AllocateWithSeed, CreateAssociatedTokenIdempotent, TransferChecked
const instructions = payoutInstructions(planOf([{ create: true }]));

describe('describeTransactionError', () => {
  it('names the Token program error behind a custom code', () => {
    expect(describeTransactionError({ InstructionError: [4, { Custom: 1 }] }, instructions)).toBe(
      'instruction 4 failed: custom program error 0x1 (Token program: InsufficientFunds)',
    );
    expect(describeTransactionError({ InstructionError: [4, { Custom: 4 }] }, instructions)).toBe(
      'instruction 4 failed: custom program error 0x4 (Token program: OwnerMismatch)',
    );
    expect(describeTransactionError({ InstructionError: [4, { Custom: 18 }] }, instructions)).toBe(
      'instruction 4 failed: custom program error 0x12 (Token program: MintDecimalsMismatch)',
    );
  });

  it('names the System program error behind a custom code', () => {
    expect(describeTransactionError({ InstructionError: [2, { Custom: 0 }] }, instructions)).toBe(
      'instruction 2 failed: custom program error 0x0 (System program: AccountAlreadyInUse)',
    );
    expect(describeTransactionError({ InstructionError: [2, { Custom: 5 }] }, instructions)).toBe(
      'instruction 2 failed: custom program error 0x5 (System program: AddressWithSeedMismatch)',
    );
  });

  it('does not put an error name on another program or an unknown code', () => {
    expect(describeTransactionError({ InstructionError: [3, { Custom: 1 }] }, instructions)).toBe(
      'instruction 3 failed: custom program error 0x1',
    );
    expect(describeTransactionError({ InstructionError: [4, { Custom: 999 }] }, instructions)).toBe(
      'instruction 4 failed: custom program error 0x3e7',
    );
    expect(describeTransactionError({ InstructionError: [4, { Custom: 1 }] })).toBe(
      'instruction 4 failed: custom program error 0x1',
    );
  });

  it('passes through errors that are not custom program errors', () => {
    expect(describeTransactionError('BlockhashNotFound')).toBe('BlockhashNotFound');
    expect(describeTransactionError({ InstructionError: [0, 'InvalidAccountData'] })).toBe(
      'instruction 0 failed: InvalidAccountData',
    );
    expect(describeTransactionError({ InsufficientFundsForRent: { account_index: 3 } })).toBe(
      '{"InsufficientFundsForRent":{"account_index":3}}',
    );
  });

  it('prints the integers of an error as numbers, though kit hands them over as bigints', () => {
    const asDecoded = { InsufficientFundsForRent: { account_index: 1n as unknown as number } };
    expect(describeTransactionError(asDecoded)).toBe('{"InsufficientFundsForRent":{"account_index":1}}');
  });
});

describe('customErrorOf', () => {
  it('picks the instruction and the code out of a custom program error', () => {
    expect(customErrorOf({ InstructionError: [2, { Custom: 0 }] })).toEqual({ index: 2, code: 0 });
  });

  it('is null for a success and for every other kind of error', () => {
    expect(customErrorOf(null)).toBeNull();
    expect(customErrorOf('BlockhashNotFound')).toBeNull();
    expect(customErrorOf({ InstructionError: [2, 'InvalidArgument'] })).toBeNull();
    expect(customErrorOf({ InsufficientFundsForRent: { account_index: 1 } })).toBeNull();
  });
});

describe('describeFailure', () => {
  it('describes anything thrown', () => {
    expect(describeFailure(new Error('connect ECONNREFUSED'))).toBe('connect ECONNREFUSED');
    expect(describeFailure('plain')).toBe('plain');
  });
});
