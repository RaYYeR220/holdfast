import { type Hex, ZERO_ROOT, merkleRoot } from '@holdfast/core';
import { verifyChain } from '@holdfast/engine';
import { concat, keccak256 } from 'viem';
import { describe, expect, it } from 'vitest';
import { attestationFor, journalLeaf, journalLeaves, merkleProof, proofFor, verifyProof } from '../src/index';
import { chainedJournal, contractVerifies, engineJournal, reforged } from './support';

const numbered = (n: number): Hex => `0x${n.toString(16).padStart(64, '0')}`;

describe('journal leaves', () => {
  it('gives an entry the digest it carries as its leaf', () => {
    const entries = chainedJournal(4);
    expect(journalLeaves(entries)).toEqual(entries.map((entry) => entry.digest));
    expect(journalLeaf(entries[2] as (typeof entries)[number])).toBe(entries[2]?.digest);
  });

  it('agrees with the engine on entries the engine wrote', async () => {
    const entries = await engineJournal(4);
    expect(entries).toHaveLength(4);
    expect(entries[0]?.order?.result.ok).toBe(true);
    expect(entries[0]?.snapshot.treasury?.zat).toBe(5_000_000n);
    expect(verifyChain(entries, ZERO_ROOT)).toEqual({ ok: true });

    const digests = entries.map((entry) => entry.digest);
    expect(journalLeaves(entries)).toEqual(digests);
    expect(attestationFor(entries)).toEqual({ journalRoot: merkleRoot(digests), journalCount: 4n });

    const attested = attestationFor(entries);
    entries.forEach((entry, index) => {
      const proof = proofFor(entries, index);
      expect(contractVerifies(attested.journalRoot, attested.journalCount, journalLeaf(entry), proof)).toBe(true);
    });
  });

  it('refuses an entry whose content no longer matches its digest', () => {
    const [entry] = chainedJournal(1);
    if (entry === undefined) throw new Error('no entry');
    expect(() => journalLeaf({ ...entry, treasuryZat: entry.treasuryZat + 1n })).toThrow(/does not match its digest/);
    expect(() => journalLeaf({ ...entry, digest: numbered(1) })).toThrow(/does not match its digest/);
    expect(() => journalLeaf({ ...entry, added: true })).toThrow(/does not match its digest/);
  });

  it('refuses a list that is not the journal from its first entry', () => {
    const entries = chainedJournal(5);
    const [first, second, third, fourth, fifth] = entries;
    if (!first || !second || !third || !fourth || !fifth) throw new Error('journal too short');

    expect(() => journalLeaves(entries.slice(1))).toThrow(/position 0 does not follow/);
    expect(() => journalLeaves([first, third, fourth, fifth])).toThrow(/position 1 does not follow/);
    expect(() => journalLeaves([first, third, second, fourth, fifth])).toThrow(/position 1 does not follow/);
    expect(() => attestationFor([first, second, second])).toThrow(/position 2 does not follow/);
    expect(() => proofFor(entries.slice(2), 0)).toThrow(/position 0 does not follow/);
  });
});

describe('attestation', () => {
  it('commits to an empty journal with the zero root', () => {
    expect(attestationFor([])).toEqual({ journalRoot: ZERO_ROOT, journalCount: 0n });
  });

  it('commits to the root of the leaves and their count', () => {
    const entries = chainedJournal(7);
    expect(attestationFor(entries)).toEqual({ journalRoot: merkleRoot(journalLeaves(entries)), journalCount: 7n });
    expect(attestationFor(entries.slice(0, 1))).toEqual({ journalRoot: entries[0]?.digest, journalCount: 1n });
  });

  it('commits to every prefix of a journal separately', () => {
    const entries = chainedJournal(8);
    const roots = new Set(entries.map((_, i) => attestationFor(entries.slice(0, i + 1)).journalRoot));
    expect(roots.size).toBe(8);
  });
});

describe('proofs', () => {
  it.each([1, 2, 3, 7, 8])('proves every entry of a journal of %i by the contract rule', (length) => {
    const entries = chainedJournal(length);
    const { journalRoot, journalCount } = attestationFor(entries);
    const depth = Math.ceil(Math.log2(length));

    entries.forEach((entry, index) => {
      const proof = proofFor(entries, index);
      expect(proof.length).toBeLessThanOrEqual(depth);
      expect(contractVerifies(journalRoot, journalCount, journalLeaf(entry), proof)).toBe(true);
      expect(verifyProof({ journalRoot, journalCount }, journalLeaf(entry), proof)).toBe(true);
    });
  });

  it('needs no proof for the only entry of a journal', () => {
    const entries = chainedJournal(1);
    expect(proofFor(entries, 0)).toEqual([]);
    expect(attestationFor(entries).journalRoot).toBe(entries[0]?.digest);
  });

  it('matches the fixed three-leaf vector shared with the core and contract tests', () => {
    const leaves = [numbered(1), numbered(2), numbered(3)];
    const root = '0x9b0225f2c6f59eeaf8302811ea290e95258763189b82dc033158e99a6ef45a87';
    const firstPair = keccak256(concat([numbered(1), numbered(2)]));

    expect(merkleRoot(leaves)).toBe(root);
    expect(merkleProof(leaves, 0)).toEqual([numbered(2), numbered(3)]);
    expect(merkleProof(leaves, 1)).toEqual([numbered(1), numbered(3)]);
    // The third leaf has no partner on the bottom level and meets the first pair one level up.
    expect(merkleProof(leaves, 2)).toEqual([firstPair]);
    leaves.forEach((leaf, index) => {
      expect(contractVerifies(root, 3n, leaf, merkleProof(leaves, index))).toBe(true);
    });
  });

  it('does not verify a tampered entry', () => {
    const entries = chainedJournal(7);
    const { journalRoot, journalCount } = attestationFor(entries);
    const target = entries[4];
    if (target === undefined) throw new Error('journal too short');
    const proof = proofFor(entries, 4);
    expect(contractVerifies(journalRoot, journalCount, journalLeaf(target), proof)).toBe(true);

    // Content changed, digest left alone: the entry no longer has a leaf at all.
    expect(() => journalLeaf({ ...target, note: 'tick 5, edited' })).toThrow(/does not match its digest/);

    // Content changed and digest recomputed: the leaf is a different one and the proof leads nowhere.
    const forged = reforged(target, { note: 'tick 5, edited' });
    expect(journalLeaf(forged)).not.toBe(target.digest);
    expect(contractVerifies(journalRoot, journalCount, journalLeaf(forged), proof)).toBe(false);
    expect(verifyProof({ journalRoot, journalCount }, journalLeaf(forged), proof)).toBe(false);

    const bigger = reforged(target, { treasuryZat: target.treasuryZat + 1n });
    expect(contractVerifies(journalRoot, journalCount, journalLeaf(bigger), proof)).toBe(false);
  });

  it('does not verify a proof that was altered or belongs to another entry', () => {
    const entries = chainedJournal(8);
    const { journalRoot, journalCount } = attestationFor(entries);
    const leaf = journalLeaf(entries[3] as (typeof entries)[number]);
    const proof = proofFor(entries, 3);

    expect(contractVerifies(journalRoot, journalCount, leaf, proofFor(entries, 5))).toBe(false);
    expect(contractVerifies(journalRoot, journalCount, leaf, proof.slice(0, -1))).toBe(false);
    expect(contractVerifies(journalRoot, journalCount, leaf, [...proof, numbered(1)])).toBe(false);
    expect(contractVerifies(journalRoot, journalCount, leaf, [numbered(9), ...proof.slice(1)])).toBe(false);
    expect(verifyProof({ journalRoot, journalCount }, leaf, [numbered(9), ...proof.slice(1)])).toBe(false);
  });

  it('does not verify against the snapshot of a shorter journal', () => {
    const entries = chainedJournal(8);
    const earlier = attestationFor(entries.slice(0, 5));
    const late = entries[6] as (typeof entries)[number];
    expect(contractVerifies(earlier.journalRoot, earlier.journalCount, journalLeaf(late), proofFor(entries, 6))).toBe(false);
  });

  it('finds nothing under an empty journal', () => {
    const empty = attestationFor([]);
    // Folding the zero leaf with no proof gives the zero root; the count is what says no.
    expect(contractVerifies(empty.journalRoot, empty.journalCount, ZERO_ROOT, [])).toBe(false);
    expect(verifyProof(empty, ZERO_ROOT, [])).toBe(false);
    expect(verifyProof({ ...empty, journalCount: 1n }, ZERO_ROOT, [])).toBe(true);
  });

  it('refuses a position outside the journal', () => {
    const entries = chainedJournal(3);
    expect(() => proofFor(entries, 3)).toThrow(RangeError);
    expect(() => proofFor(entries, -1)).toThrow(RangeError);
    expect(() => proofFor(entries, 0.5)).toThrow(RangeError);
    expect(() => proofFor([], 0)).toThrow(RangeError);
  });
});
