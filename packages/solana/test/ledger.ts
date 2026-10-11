import {
  createAddressWithSeed,
  isInstructionWithAccounts,
  isInstructionWithData,
  isSignerRole,
  type Address,
  type ResolvedInstruction,
} from '@solana/kit';
import {
  identifySystemInstruction,
  parseAllocateWithSeedInstruction,
  parseAssignWithSeedInstruction,
  parseTransferSolInstruction,
  parseTransferSolWithSeedInstruction,
  SYSTEM_PROGRAM_ADDRESS,
  SystemInstruction,
} from '@solana-program/system';

/** What the System program looks at in an account. */
export interface LedgerAccount {
  lamports: bigint;
  owner: Address;
  /** Bytes of data. */
  space: number;
}

/** The rent-exempt minimum of the fake chain: the rate Solana launched with. */
export const rentFor = (space: number): bigint => BigInt((128 + space) * 6_960);

export type Execution = { err: null; accounts: Map<Address, LedgerAccount> } | { err: object };

/**
 * The System program, as far as the payout rail depends on it. Every rule
 * here was checked against the real program on devnet (see the comment in
 * src/marker.ts for what each one buys):
 *
 * - allocating at a seed-derived address takes the signature of its base
 *   (`MissingRequiredSignature` otherwise) and the address must be the one
 *   the base, seed and owner derive (custom error 5 otherwise);
 * - allocating an account that has data, or that the System program does
 *   not own, fails with custom error 0, `AccountAlreadyInUse`; lamports the
 *   account may already hold are no obstacle;
 * - lamports cannot be transferred out of an account that has data, with
 *   or without seed (`InvalidArgument`);
 * - assigning a seed-derived address to another owner fails, because the
 *   address is not the one derived for that owner (custom error 5);
 * - at the end of the transaction an account that holds lamports must hold
 *   the rent-exempt minimum for its size (`InsufficientFundsForRent`), and
 *   an account left with no lamports is dropped, data and all;
 * - a transaction that fails changes nothing.
 */
export async function executeSystemInstructions(
  instructions: readonly ResolvedInstruction[],
  accountKeys: readonly Address[],
  read: (address: Address) => LedgerAccount | undefined,
): Promise<Execution> {
  const touched = new Map<Address, LedgerAccount>();
  const load = (address: Address): LedgerAccount => {
    const loaded = touched.get(address) ?? { ...(read(address) ?? { lamports: 0n, owner: SYSTEM_PROGRAM_ADDRESS, space: 0 }) };
    touched.set(address, loaded);
    return loaded;
  };
  const derived = (base: Address, seed: string, owner: Address): Promise<Address> =>
    createAddressWithSeed({ baseAddress: base, programAddress: owner, seed });

  for (const [index, instruction] of instructions.entries()) {
    if (instruction.programAddress !== SYSTEM_PROGRAM_ADDRESS) continue;
    if (!isInstructionWithAccounts(instruction) || !isInstructionWithData(instruction)) continue;
    const failed = (detail: string | { Custom: number }): Execution => ({ err: { InstructionError: [index, detail] } });
    const move = (from: LedgerAccount, to: Address, lamports: bigint): Execution | null => {
      if (from.space > 0) return failed('InvalidArgument');
      if (from.lamports < lamports) return failed({ Custom: 1 });
      from.lamports -= lamports;
      load(to).lamports += lamports;
      return null;
    };

    switch (identifySystemInstruction(instruction)) {
      case SystemInstruction.TransferSol: {
        const { accounts, data } = parseTransferSolInstruction(instruction);
        if (!isSignerRole(accounts.source.role)) return failed('MissingRequiredSignature');
        const failure = move(load(accounts.source.address), accounts.destination.address, data.amount);
        if (failure) return failure;
        break;
      }
      case SystemInstruction.TransferSolWithSeed: {
        const { accounts, data } = parseTransferSolWithSeedInstruction(instruction);
        if (!isSignerRole(accounts.baseAccount.role)) return failed('MissingRequiredSignature');
        const expected = await derived(accounts.baseAccount.address, data.fromSeed, data.fromOwner);
        if (expected !== accounts.source.address) return failed({ Custom: 5 });
        const failure = move(load(accounts.source.address), accounts.destination.address, data.amount);
        if (failure) return failure;
        break;
      }
      case SystemInstruction.AllocateWithSeed: {
        const { accounts, data } = parseAllocateWithSeedInstruction(instruction);
        const baseSigned = accounts.baseAccount.address === data.base && isSignerRole(accounts.baseAccount.role);
        if (!baseSigned) return failed('MissingRequiredSignature');
        if ((await derived(data.base, data.seed, data.programAddress)) !== accounts.newAccount.address) {
          return failed({ Custom: 5 });
        }
        const account = load(accounts.newAccount.address);
        if (account.space > 0 || account.owner !== SYSTEM_PROGRAM_ADDRESS) return failed({ Custom: 0 });
        account.space = Number(data.space);
        account.owner = data.programAddress;
        break;
      }
      case SystemInstruction.AssignWithSeed: {
        const { accounts, data } = parseAssignWithSeedInstruction(instruction);
        const baseSigned = accounts.baseAccount.address === data.base && isSignerRole(accounts.baseAccount.role);
        if (!baseSigned) return failed('MissingRequiredSignature');
        if ((await derived(data.base, data.seed, data.programAddress)) !== accounts.account.address) {
          return failed({ Custom: 5 });
        }
        load(accounts.account.address).owner = data.programAddress;
        break;
      }
      default:
        break;
    }
  }

  for (const [address, account] of touched) {
    if (account.lamports === 0n) {
      touched.set(address, { lamports: 0n, owner: SYSTEM_PROGRAM_ADDRESS, space: 0 });
    } else if (account.lamports < rentFor(account.space)) {
      return { err: { InsufficientFundsForRent: { account_index: accountKeys.indexOf(address) } } };
    }
  }
  return { err: null, accounts: touched };
}
