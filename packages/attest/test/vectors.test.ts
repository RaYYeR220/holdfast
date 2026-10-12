import { readFileSync } from 'node:fs';
import { merkleRoot } from '@holdfast/core';
import { describe, expect, it } from 'vitest';
import { VECTORS_PATH, VECTOR_SIZES, type Vectors, buildVectors } from '../scripts/vectors';
import { commitTreasury, merkleProof } from '../src/index';
import { contractVerifies } from './support';

/**
 * contracts/test/fixtures/vectors.json is checked here against this package
 * and in the forge tests against the contract. `pnpm --filter @holdfast/attest
 * vectors` rewrites it.
 */
describe('vectors shared with the contract tests', () => {
  const stored = JSON.parse(readFileSync(VECTORS_PATH, 'utf8')) as Vectors;

  it('are what this package computes today', () => {
    expect(stored).toEqual(buildVectors());
  });

  it('cover one, two, three, seven and eight leaves', () => {
    expect(stored.merkle.map((vector) => vector.leaves.length)).toEqual([...VECTOR_SIZES]);
  });

  it('hold roots and proofs that follow the contract rule', () => {
    for (const vector of stored.merkle) {
      expect(merkleRoot(vector.leaves)).toBe(vector.root);
      vector.leaves.forEach((leaf, index) => {
        expect(vector.proofs[index]).toEqual(merkleProof(vector.leaves, index));
        expect(contractVerifies(vector.root, BigInt(vector.leaves.length), leaf, vector.proofs[index] ?? [])).toBe(true);
      });
    }
  });

  it('pin the three-leaf root the core tests pin', () => {
    expect(stored.merkle[2]?.root).toBe('0x9b0225f2c6f59eeaf8302811ea290e95258763189b82dc033158e99a6ef45a87');
  });

  it('hold a treasury commitment that opens', () => {
    const { balanceZat, salt, commitment } = stored.treasury;
    expect(commitTreasury(BigInt(balanceZat), salt)).toBe(commitment);
  });
});
