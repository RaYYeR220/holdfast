import { type Hex, digest, merkleRoot } from '@holdfast/core';
import { fileURLToPath } from 'node:url';
import { commitTreasury, merkleProof } from '../src/index';

/**
 * Vectors the contract tests and this package's tests both check, so the
 * Solidity and the TypeScript cannot drift apart unnoticed. The file sits with
 * the contract tests because forge may only read inside its own project.
 */
export const VECTORS_PATH = fileURLToPath(new URL('../../../contracts/test/fixtures/vectors.json', import.meta.url));

export const VECTOR_SIZES = [1, 2, 3, 7, 8] as const;

export interface MerkleVector {
  leaves: Hex[];
  root: Hex;
  /** `proofs[i]` is the proof of `leaves[i]`. */
  proofs: Hex[][];
}

export interface Vectors {
  merkle: MerkleVector[];
  treasury: { balanceZat: string; salt: Hex; commitment: Hex };
}

const numbered = (n: number): Hex => `0x${n.toString(16).padStart(64, '0')}`;

export function buildVectors(): Vectors {
  const merkle = VECTOR_SIZES.map((size) => {
    // Three leaves are the vector the core tests pin; the other sizes are arbitrary digests.
    const leaves = Array.from({ length: size }, (_, i) =>
      size === 3 ? numbered(i + 1) : digest({ vector: size, leaf: i }),
    );
    return { leaves, root: merkleRoot(leaves), proofs: leaves.map((_, i) => merkleProof(leaves, i)) };
  });

  const balanceZat = 1_234_567_890n;
  const salt = digest('holdfast treasury commitment vector');
  return { merkle, treasury: { balanceZat: balanceZat.toString(), salt, commitment: commitTreasury(balanceZat, salt) } };
}
