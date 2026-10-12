import { type Hex, ZERO_ROOT, digest, merkleRoot } from '@holdfast/core';

/**
 * The two fields that chain a journal entry to the one before it. Everything
 * else an entry carries is its body.
 */
export interface ChainedEntry {
  /** Digest of the previous entry; the zero root for the first. */
  prev: Hex;
  /** Digest of this entry's body together with `prev`. */
  digest: Hex;
}

/** What a snapshot commits to about the journal. */
export interface JournalAttestation {
  /** Merkle root over the leaves of the entries; the zero root for an empty journal. */
  journalRoot: Hex;
  /** Number of entries under the root, as the contract takes it. */
  journalCount: bigint;
}

/**
 * The leaf of one journal entry: its digest, recomputed from its content by
 * the rule the engine writes it with. An entry whose stored digest does not
 * match its content is not a journal entry and gets no leaf.
 */
export function journalLeaf<T extends ChainedEntry>(entry: T): Hex {
  const { prev, digest: stored, ...body } = entry;
  const leaf = digest({ prev, body });
  if (leaf !== stored) {
    throw new Error(`journal entry does not match its digest: it carries ${stored}, its content gives ${leaf}`);
  }
  return leaf;
}

/**
 * Leaves of a journal, in order. `entries` is the journal from its first
 * entry: each one has to follow the one before it, and the first follows the
 * zero root. A list with a gap, a reordering or a missing start is refused,
 * because a root over it would not be the root of the journal.
 */
export function journalLeaves<T extends ChainedEntry>(entries: readonly T[]): Hex[] {
  let prev: Hex = ZERO_ROOT;
  return entries.map((entry, index) => {
    if (entry.prev !== prev) {
      throw new Error(`journal entry at position ${index} does not follow the entry before it`);
    }
    prev = journalLeaf(entry);
    return prev;
  });
}

/** The root and count to pass to `attest` for a journal. */
export function attestationFor<T extends ChainedEntry>(entries: readonly T[]): JournalAttestation {
  const leaves = journalLeaves(entries);
  return { journalRoot: merkleRoot(leaves), journalCount: BigInt(leaves.length) };
}

/**
 * Proof that the leaf at `index` is under the root of `leaves`: the partner
 * nodes met on the way up, bottom first. A node that has no partner at the end
 * of a level moves up unchanged and adds nothing to the proof, so the only
 * leaf of a one-leaf tree has an empty proof.
 */
export function merkleProof(leaves: readonly Hex[], index: number): Hex[] {
  if (!Number.isInteger(index) || index < 0 || index >= leaves.length) {
    throw new RangeError(`no leaf at position ${index} among ${leaves.length}`);
  }
  const proof: Hex[] = [];
  let level = [...leaves];
  let position = index;
  while (level.length > 1) {
    const partner = level[position ^ 1];
    if (partner !== undefined) proof.push(partner);

    const next: Hex[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i] as Hex;
      const right = level[i + 1];
      // The root of two leaves is their pair hash, by the journal's own rule.
      next.push(right === undefined ? left : merkleRoot([left, right]));
    }
    level = next;
    position >>= 1;
  }
  return proof;
}

/** Proof for the entry at `index` of a journal, in the form `verifyEntry` takes. */
export function proofFor<T extends ChainedEntry>(entries: readonly T[], index: number): Hex[] {
  return merkleProof(journalLeaves(entries), index);
}

/**
 * What `verifyEntry` does on the contract, done here against a root and count
 * taken from a snapshot: fold the leaf and its proof up to a root and compare.
 * Nothing is under an empty journal. Like the contract, this cannot tell a
 * leaf from an inner node of the tree: compute the leaf from the entry with
 * `journalLeaf` before trusting the answer.
 */
export function verifyProof(committed: JournalAttestation, leaf: Hex, proof: readonly Hex[]): boolean {
  if (committed.journalCount === 0n) return false;
  let node = leaf;
  for (const partner of proof) node = merkleRoot([node, partner]);
  return node.toLowerCase() === committed.journalRoot.toLowerCase();
}
