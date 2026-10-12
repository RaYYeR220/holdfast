import type { Hex } from '@holdfast/core';
import { encodeAbiParameters, keccak256 } from 'viem';
import { describe, expect, it } from 'vitest';
import { commitTreasury } from '../src/index';

const SALT: Hex = '0x8d3c1f0e5b7a69483c2d1e0f9a8b7c6d5e4f30211203f4e5d6c7b8a99a8b7c6d';

describe('treasury commitment', () => {
  it('is the keccak256 of the balance and the salt as two ABI words', () => {
    const word = (n: bigint) => n.toString(16).padStart(64, '0');
    expect(commitTreasury(250_000_000n, SALT)).toBe(keccak256(`0x${word(250_000_000n)}${SALT.slice(2)}`));
    expect(commitTreasury(250_000_000n, SALT)).toBe(
      keccak256(encodeAbiParameters([{ type: 'uint256' }, { type: 'bytes32' }], [250_000_000n, SALT])),
    );
  });

  it('changes with the balance and with the salt', () => {
    const base = commitTreasury(250_000_000n, SALT);
    expect(commitTreasury(250_000_001n, SALT)).not.toBe(base);
    expect(commitTreasury(250_000_000n, `0x${'00'.repeat(31)}01`)).not.toBe(base);
    expect(commitTreasury(250_000_000n, SALT)).toBe(base);
  });

  it('takes every balance that fits the contract and no other', () => {
    expect(commitTreasury(0n, SALT)).toMatch(/^0x[0-9a-f]{64}$/);
    expect(commitTreasury(2n ** 64n - 1n, SALT)).toMatch(/^0x[0-9a-f]{64}$/);
    expect(() => commitTreasury(2n ** 64n, SALT)).toThrow(RangeError);
    expect(() => commitTreasury(-1n, SALT)).toThrow(RangeError);
  });

  it('refuses a salt that is not 32 bytes', () => {
    expect(() => commitTreasury(1n, '0x1234')).toThrow(RangeError);
    expect(() => commitTreasury(1n, `0x${'00'.repeat(33)}`)).toThrow(RangeError);
    expect(() => commitTreasury(1n, `0x${'zz'.repeat(32)}`)).toThrow(RangeError);
    expect(() => commitTreasury(1n, '0x')).toThrow(RangeError);
  });
});
