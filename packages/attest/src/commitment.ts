import type { Hex, Zat } from '@holdfast/core';
import { encodeAbiParameters, isHex, keccak256, size } from 'viem';

const MAX_UINT64 = 2n ** 64n - 1n;
const SALT_BYTES = 32;

/**
 * Commitment to the shielded treasury balance: keccak256 of the balance in
 * zatoshi and a salt, ABI-encoded as (uint64, bytes32). It is the value
 * `treasuryCommitmentOf` returns on the contract.
 *
 * The salt is what hides the balance. It has to be 32 random bytes, fresh for
 * every commitment and kept secret until the commitment is opened: balances
 * are few enough to try one by one against a commitment whose salt is known
 * or guessable.
 */
export function commitTreasury(zat: Zat, salt: Hex): Hex {
  if (zat < 0n || zat > MAX_UINT64) throw new RangeError(`balance ${zat} zat does not fit in 64 bits`);
  if (!isHex(salt, { strict: true }) || size(salt) !== SALT_BYTES) {
    throw new RangeError(`salt must be ${SALT_BYTES} bytes of hex`);
  }
  return keccak256(encodeAbiParameters([{ type: 'uint64' }, { type: 'bytes32' }], [zat, salt]));
}
