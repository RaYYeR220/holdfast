// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

/// @notice The journal's Merkle tree, built level by level the way `merkleRoot` builds it in
/// packages/core/src/journal.ts. The tests check the contract against it.
library MerkleReference {
    /// @dev The two nodes joined smaller first, then hashed.
    function hashPair(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return uint256(a) <= uint256(b) ? keccak256(bytes.concat(a, b)) : keccak256(bytes.concat(b, a));
    }

    /// @dev One level up: neighbours are paired, and a last node without a neighbour moves up as it is.
    function levelAbove(bytes32[] memory level) internal pure returns (bytes32[] memory above) {
        above = new bytes32[]((level.length + 1) / 2);
        for (uint256 i = 0; i < level.length; i += 2) {
            above[i / 2] = i + 1 < level.length ? hashPair(level[i], level[i + 1]) : level[i];
        }
    }

    function root(bytes32[] memory leaves) internal pure returns (bytes32) {
        if (leaves.length == 0) return bytes32(0);
        bytes32[] memory level = leaves;
        while (level.length > 1) {
            level = levelAbove(level);
        }
        return level[0];
    }

    /// @dev The partners met on the way from `leaves[index]` to the root, bottom first.
    function proof(bytes32[] memory leaves, uint256 index) internal pure returns (bytes32[] memory path) {
        require(index < leaves.length, "no such leaf");
        bytes32[] memory partners = new bytes32[](256);
        uint256 length;
        bytes32[] memory level = leaves;
        while (level.length > 1) {
            uint256 partner = index ^ 1;
            if (partner < level.length) partners[length++] = level[partner];
            level = levelAbove(level);
            index /= 2;
        }
        path = new bytes32[](length);
        for (uint256 i = 0; i < length; ++i) {
            path[i] = partners[i];
        }
    }

    function fold(bytes32 leaf, bytes32[] memory path) internal pure returns (bytes32 node) {
        node = leaf;
        for (uint256 i = 0; i < path.length; ++i) {
            node = hashPair(node, path[i]);
        }
    }
}
