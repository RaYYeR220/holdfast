import { describe, expect, it } from 'vitest';
import { describeFailure, describeTransactionError } from '../src/errors';
import { payoutInstructions } from '../src/payout';
import { planOf } from './fixtures';

// Memo, CreateAssociatedTokenIdempotent, TransferChecked
const instructions = payoutInstructions(planOf([{ create: true }]));

describe('describeTransactionError', () => {
  it('names the Token program error behind a custom code', () => {
    expect(describeTransactionError({ InstructionError: [2, { Custom: 1 }] }, instructions)).toBe(
      'instruction 2 failed: custom program error 0x1 (Token program: InsufficientFunds)',
    );
    expect(describeTransactionError({ InstructionError: [2, { Custom: 4 }] }, instructions)).toBe(
      'instruction 2 failed: custom program error 0x4 (Token program: OwnerMismatch)',
    );
    expect(describeTransactionError({ InstructionError: [2, { Custom: 18 }] }, instructions)).toBe(
      'instruction 2 failed: custom program error 0x12 (Token program: MintDecimalsMismatch)',
    );
  });

  it('does not put a Token error name on another program or an unknown code', () => {
    expect(describeTransactionError({ InstructionError: [1, { Custom: 1 }] }, instructions)).toBe(
      'instruction 1 failed: custom program error 0x1',
    );
    expect(describeTransactionError({ InstructionError: [2, { Custom: 999 }] }, instructions)).toBe(
      'instruction 2 failed: custom program error 0x3e7',
    );
    expect(describeTransactionError({ InstructionError: [2, { Custom: 1 }] })).toBe(
      'instruction 2 failed: custom program error 0x1',
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
});

describe('describeFailure', () => {
  it('describes anything thrown', () => {
    expect(describeFailure(new Error('connect ECONNREFUSED'))).toBe('connect ECONNREFUSED');
    expect(describeFailure('plain')).toBe('plain');
  });
});
