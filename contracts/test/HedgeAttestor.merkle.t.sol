// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {HedgeAttestor} from "../src/HedgeAttestor.sol";
import {CoreFixture} from "./support/CoreFixture.sol";
import {MerkleReference} from "./support/MerkleReference.sol";

contract VerifyEntryTest is CoreFixture {
    /// @dev Root of the leaves 1, 2 and 3, as pinned in packages/core/test/accounting-journal.test.ts.
    bytes32 internal constant PINNED_ROOT = 0x9b0225f2c6f59eeaf8302811ea290e95258763189b82dc033158e99a6ef45a87;

    string internal constant VECTORS = "test/fixtures/vectors.json";

    function _leaves(uint256 seed, uint256 size) internal pure returns (bytes32[] memory leaves) {
        leaves = new bytes32[](size);
        for (uint256 i = 0; i < size; ++i) {
            leaves[i] = keccak256(abi.encode(seed, i));
        }
    }

    function _numbered(uint256 size) internal pure returns (bytes32[] memory leaves) {
        leaves = new bytes32[](size);
        for (uint256 i = 0; i < size; ++i) {
            leaves[i] = bytes32(i + 1);
        }
    }

    function _list(bytes32 a) internal pure returns (bytes32[] memory list) {
        list = new bytes32[](1);
        list[0] = a;
    }

    function _list(bytes32 a, bytes32 b) internal pure returns (bytes32[] memory list) {
        list = new bytes32[](2);
        list[0] = a;
        list[1] = b;
    }

    function _attestJournal(bytes32[] memory leaves) internal returns (uint256) {
        return _attest(MerkleReference.root(leaves), uint64(leaves.length));
    }

    function test_ASingleEntryIsItsOwnRoot() public {
        bytes32 leaf = keccak256("the only entry");
        uint256 number = _attest(leaf, 1);

        assertTrue(attestor.verifyEntry(team, 0, number, leaf, new bytes32[](0)));
        assertFalse(attestor.verifyEntry(team, 0, number, keccak256("another entry"), new bytes32[](0)));
        assertFalse(attestor.verifyEntry(team, 0, number, leaf, _list(leaf)));
    }

    function test_ThePinnedThreeLeafVector() public {
        bytes32 one = bytes32(uint256(1));
        bytes32 two = bytes32(uint256(2));
        bytes32 three = bytes32(uint256(3));
        bytes32 firstPair = keccak256(abi.encodePacked(one, two));

        // Three is smaller than the hash it is paired with, so it goes first although it sits on the right.
        assertLt(uint256(three), uint256(firstPair));
        assertEq(keccak256(abi.encodePacked(three, firstPair)), PINNED_ROOT, "the vector itself");
        assertEq(MerkleReference.root(_numbered(3)), PINNED_ROOT, "reference root");

        uint256 number = _attest(PINNED_ROOT, 3);
        assertTrue(attestor.verifyEntry(team, 0, number, one, _list(two, three)));
        assertTrue(attestor.verifyEntry(team, 0, number, two, _list(one, three)));
        // The third leaf has no partner on the bottom level and meets the first pair one level up.
        assertTrue(attestor.verifyEntry(team, 0, number, three, _list(firstPair)));

        assertFalse(attestor.verifyEntry(team, 0, number, three, _list(one, two)));
        assertFalse(attestor.verifyEntry(team, 0, number, bytes32(uint256(4)), _list(firstPair)));
    }

    function test_PairsAreHashedSmallerFirstWhicheverSideTheyAreOn() public {
        bytes32 low = bytes32(uint256(1));
        bytes32 high = bytes32(type(uint256).max);
        bytes32 root = keccak256(abi.encodePacked(low, high));

        uint256 number = _attest(root, 2);
        assertTrue(attestor.verifyEntry(team, 0, number, low, _list(high)));
        assertTrue(attestor.verifyEntry(team, 0, number, high, _list(low)));
        assertEq(MerkleReference.root(_list(high, low)), root);
    }

    function test_EveryEntryOfJournalsOfOneToSeventeenEntriesVerifies() public {
        for (uint256 size = 1; size <= 17; ++size) {
            bytes32[] memory leaves = _leaves(size, size);
            uint256 number = _attestJournal(leaves);
            for (uint256 i = 0; i < size; ++i) {
                bytes32[] memory proof = MerkleReference.proof(leaves, i);
                assertTrue(attestor.verifyEntry(team, 0, number, leaves[i], proof), "an entry did not verify");
            }
        }
    }

    function test_AnOddEntryAtTheEndNeedsAShorterProof() public {
        // In five leaves the last one rises alone for two levels and meets the other four at the top.
        bytes32[] memory leaves = _leaves(5, 5);
        bytes32[] memory proof = MerkleReference.proof(leaves, 4);
        assertEq(proof.length, 1);
        assertEq(MerkleReference.proof(leaves, 0).length, 3);

        uint256 number = _attestJournal(leaves);
        assertTrue(attestor.verifyEntry(team, 0, number, leaves[4], proof));

        // In seven leaves the last one skips only the bottom level.
        leaves = _leaves(7, 7);
        assertEq(MerkleReference.proof(leaves, 6).length, 2);
        number = _attestJournal(leaves);
        assertTrue(attestor.verifyEntry(team, 0, number, leaves[6], MerkleReference.proof(leaves, 6)));
    }

    function test_AWrongProofDoesNotVerify() public {
        bytes32[] memory leaves = _leaves(8, 8);
        uint256 number = _attestJournal(leaves);
        bytes32[] memory proof = MerkleReference.proof(leaves, 3);
        assertTrue(attestor.verifyEntry(team, 0, number, leaves[3], proof));

        // the proof of another entry
        assertFalse(attestor.verifyEntry(team, 0, number, leaves[3], MerkleReference.proof(leaves, 5)));
        // another entry with this proof
        assertFalse(attestor.verifyEntry(team, 0, number, leaves[4], proof));
        // an entry that is not in the journal
        assertFalse(attestor.verifyEntry(team, 0, number, keccak256("not an entry"), proof));
        // no proof at all
        assertFalse(attestor.verifyEntry(team, 0, number, leaves[3], new bytes32[](0)));

        // one partner changed
        bytes32 kept = proof[1];
        proof[1] = bytes32(uint256(kept) ^ 1);
        assertFalse(attestor.verifyEntry(team, 0, number, leaves[3], proof));
        proof[1] = kept;

        // partners in the wrong order
        (proof[0], proof[2]) = (proof[2], proof[0]);
        assertFalse(attestor.verifyEntry(team, 0, number, leaves[3], proof));
    }

    function test_AnEntryVerifiesOnlyAgainstASnapshotThatCoversIt() public {
        bytes32[] memory journal = _leaves(9, 8);
        bytes32[] memory prefix = new bytes32[](5);
        for (uint256 i = 0; i < 5; ++i) {
            prefix[i] = journal[i];
        }
        uint256 early = _attestJournal(prefix);
        uint256 late = _attestJournal(journal);

        assertTrue(attestor.verifyEntry(team, 0, early, journal[2], MerkleReference.proof(prefix, 2)));
        assertTrue(attestor.verifyEntry(team, 0, late, journal[2], MerkleReference.proof(journal, 2)));
        assertTrue(attestor.verifyEntry(team, 0, late, journal[6], MerkleReference.proof(journal, 6)));

        // An entry written after the early snapshot is not under it, and proofs do not carry over.
        assertFalse(attestor.verifyEntry(team, 0, early, journal[6], MerkleReference.proof(journal, 6)));
        assertFalse(attestor.verifyEntry(team, 0, early, journal[2], MerkleReference.proof(journal, 2)));
    }

    function test_NothingBelongsToAnEmptyJournal() public {
        uint256 number = _attest(bytes32(0), 0);

        assertFalse(attestor.verifyEntry(team, 0, number, bytes32(0), new bytes32[](0)));
        assertFalse(attestor.verifyEntry(team, 0, number, keccak256("an entry"), new bytes32[](0)));
    }

    function test_VerifyingAgainstAMissingSnapshotReverts() public {
        vm.expectRevert(abi.encodeWithSelector(HedgeAttestor.UnknownSnapshot.selector, team, 0, 0));
        attestor.verifyEntry(team, 0, 0, bytes32(0), new bytes32[](0));

        _attest(PINNED_ROOT, 3);
        vm.expectRevert(abi.encodeWithSelector(HedgeAttestor.UnknownSnapshot.selector, team, 0, 1));
        attestor.verifyEntry(team, 0, 1, bytes32(uint256(3)), new bytes32[](0));

        vm.expectRevert(abi.encodeWithSelector(HedgeAttestor.UnknownSeries.selector, team, 1));
        attestor.verifyEntry(team, 1, 0, bytes32(uint256(3)), new bytes32[](0));
    }

    /// @dev The roots and proofs in the file come from the TypeScript in packages/attest, whose own
    /// tests check the file against what it computes. Passing here means the two agree.
    function test_TheVectorsSharedWithTheTypeScriptVerify() public {
        string memory json = vm.readFile(VECTORS);
        uint8[5] memory sizes = [1, 2, 3, 7, 8];

        for (uint256 v = 0; v < sizes.length; ++v) {
            string memory vector = string.concat(".merkle[", vm.toString(v), "]");
            bytes32[] memory leaves = vm.parseJsonBytes32Array(json, string.concat(vector, ".leaves"));
            bytes32 root = vm.parseJsonBytes32(json, string.concat(vector, ".root"));
            assertEq(leaves.length, sizes[v], "vector size");
            assertEq(MerkleReference.root(leaves), root, "root");

            uint256 number = _attest(root, sizes[v]);
            for (uint256 i = 0; i < leaves.length; ++i) {
                bytes32[] memory proof =
                    vm.parseJsonBytes32Array(json, string.concat(vector, ".proofs[", vm.toString(i), "]"));
                assertEq(proof, MerkleReference.proof(leaves, i), "proof");
                assertTrue(attestor.verifyEntry(team, 0, number, leaves[i], proof), "a shared vector did not verify");
            }
        }

        assertFalse(vm.keyExistsJson(json, ".merkle[5]"), "a vector is not covered");
        assertEq(vm.parseJsonBytes32(json, ".merkle[2].root"), PINNED_ROOT);
    }

    function testFuzz_EveryEntryVerifiesAndNothingElseDoes(uint256 seed, uint256 size, uint256 index, uint256 noise)
        public
    {
        size = bound(size, 1, 64);
        index = bound(index, 0, size - 1);
        bytes32[] memory leaves = _leaves(seed, size);
        bytes32[] memory proof = MerkleReference.proof(leaves, index);
        uint256 number = _attestJournal(leaves);
        uint256 bit = uint256(1) << (noise % 256);

        assertTrue(attestor.verifyEntry(team, 0, number, leaves[index], proof));
        assertFalse(attestor.verifyEntry(team, 0, number, bytes32(uint256(leaves[index]) ^ bit), proof));

        bytes32[] memory longer = new bytes32[](proof.length + 1);
        for (uint256 i = 0; i < proof.length; ++i) {
            longer[i] = proof[i];
        }
        longer[proof.length] = bytes32(noise);
        assertFalse(attestor.verifyEntry(team, 0, number, leaves[index], longer));

        if (proof.length == 0) return;

        bytes32[] memory shorter = new bytes32[](proof.length - 1);
        for (uint256 i = 0; i < shorter.length; ++i) {
            shorter[i] = proof[i];
        }
        assertFalse(attestor.verifyEntry(team, 0, number, leaves[index], shorter));

        uint256 changed = noise % proof.length;
        proof[changed] = bytes32(uint256(proof[changed]) ^ bit);
        assertFalse(attestor.verifyEntry(team, 0, number, leaves[index], proof));
    }

    function testFuzz_AnyLeafAndProofGetTheReferenceAnswer(
        bytes32 root,
        uint64 count,
        bytes32 leaf,
        bytes32[] memory proof,
        bool honest
    ) public {
        // Half the runs use the root the proof really leads to, so both answers are exercised.
        if (honest) root = MerkleReference.fold(leaf, proof);
        if (root == bytes32(0)) count = 0;
        if (root != bytes32(0) && count == 0) count = 1;
        uint256 number = _attest(root, count);

        bool expected = count != 0 && MerkleReference.fold(leaf, proof) == root;
        assertEq(attestor.verifyEntry(team, 0, number, leaf, proof), expected);
        if (honest && count != 0) assertTrue(expected);
    }
}

contract TreasuryCommitmentTest is CoreFixture {
    bytes32 internal constant SALT = 0x8d3c1f0e5b7a69483c2d1e0f9a8b7c6d5e4f30211203f4e5d6c7b8a99a8b7c6d;

    function test_TheCommitmentIsTheHashOfBalanceAndSalt() public view {
        assertEq(
            attestor.treasuryCommitmentOf(250_000_000, SALT), keccak256(abi.encodePacked(uint256(250_000_000), SALT))
        );
    }

    function test_AnOpenedCommitmentChecksOut() public view {
        bytes32 commitment = attestor.treasuryCommitmentOf(250_000_000, SALT);

        assertTrue(attestor.opensTreasuryCommitment(commitment, 250_000_000, SALT));
        assertFalse(attestor.opensTreasuryCommitment(commitment, 250_000_001, SALT));
        assertFalse(attestor.opensTreasuryCommitment(commitment, 250_000_000, bytes32(uint256(SALT) ^ 1)));
        assertFalse(attestor.opensTreasuryCommitment(bytes32(0), 250_000_000, SALT));
    }

    function test_TheSaltHidesTheBalance() public view {
        assertTrue(
            attestor.treasuryCommitmentOf(250_000_000, SALT) != attestor.treasuryCommitmentOf(250_000_000, bytes32(0))
        );
    }

    function test_ACommitmentStoredInASnapshotCanBeOpenedLater() public {
        bytes32 commitment = attestor.treasuryCommitmentOf(1_234_567_890, SALT);
        vm.prank(attester);
        (uint256 series, uint256 number) = attestor.attest(team, ZEC, bytes32(0), 0, commitment);

        bytes32 stored = attestor.snapshot(team, series, number).treasuryCommitment;
        assertTrue(attestor.opensTreasuryCommitment(stored, 1_234_567_890, SALT));
        assertFalse(attestor.opensTreasuryCommitment(stored, 1_234_567_891, SALT));
    }

    function test_TheCommitmentSharedWithTheTypeScriptOpens() public view {
        string memory json = vm.readFile("test/fixtures/vectors.json");
        uint256 balanceZat = vm.parseJsonUint(json, ".treasury.balanceZat");
        bytes32 salt = vm.parseJsonBytes32(json, ".treasury.salt");
        bytes32 commitment = vm.parseJsonBytes32(json, ".treasury.commitment");

        assertEq(balanceZat, 1_234_567_890);
        assertEq(attestor.treasuryCommitmentOf(1_234_567_890, salt), commitment);
        assertTrue(attestor.opensTreasuryCommitment(commitment, 1_234_567_890, salt));
    }

    function testFuzz_OnlyTheCommittedBalanceAndSaltOpen(
        uint64 balanceZat,
        bytes32 salt,
        uint64 otherZat,
        bytes32 otherSalt
    ) public view {
        bytes32 commitment = attestor.treasuryCommitmentOf(balanceZat, salt);

        assertEq(commitment, keccak256(abi.encodePacked(uint256(balanceZat), salt)));
        assertTrue(attestor.opensTreasuryCommitment(commitment, balanceZat, salt));
        assertEq(attestor.opensTreasuryCommitment(commitment, otherZat, salt), otherZat == balanceZat);
        assertEq(attestor.opensTreasuryCommitment(commitment, balanceZat, otherSalt), otherSalt == salt);
    }
}
