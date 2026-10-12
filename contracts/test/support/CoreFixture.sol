// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {Test} from "forge-std/Test.sol";
import {HedgeAttestor} from "../../src/HedgeAttestor.sol";
import {PrecompileStub} from "./PrecompileStub.sol";

/// @notice A HedgeAttestor with the four HyperCore precompiles it reads replaced by stubs.
abstract contract CoreFixture is Test {
    address internal constant POSITION = 0x0000000000000000000000000000000000000813;
    address internal constant MARK_PX = 0x0000000000000000000000000000000000000806;
    address internal constant ORACLE_PX = 0x0000000000000000000000000000000000000807;
    address internal constant L1_BLOCK_NUMBER = 0x0000000000000000000000000000000000000809;

    /// @dev Index and prices of the ZEC perpetual as read from mainnet when these tests were written.
    uint32 internal constant ZEC = 214;
    uint64 internal constant ORACLE = 12_347_810;
    uint64 internal constant MARK = 12_339_000;
    uint64 internal constant L1_BLOCK = 1_179_360_279;
    uint64 internal constant NOW = 1_791_685_480;

    /// @dev Gas for a call that is expected to hit a refused read. A refused read burns all but one
    /// part in sixty-four of what is left, so the calls are capped to keep the rest of the test fed.
    uint256 internal constant CALL_GAS = 400_000;

    HedgeAttestor internal attestor;
    address internal team = makeAddr("team");
    address internal attester = makeAddr("attester");

    function setUp() public virtual {
        attestor = new HedgeAttestor();

        bytes memory stub = address(new PrecompileStub()).code;
        vm.etch(POSITION, stub);
        vm.etch(MARK_PX, stub);
        vm.etch(ORACLE_PX, stub);
        vm.etch(L1_BLOCK_NUMBER, stub);

        vm.warp(NOW);
        _setPosition(team, ZEC, -1);
        _setPrices(ZEC, ORACLE, MARK);
        _setL1Block(L1_BLOCK);

        vm.prank(team);
        attestor.setAttester(attester);
    }

    function _setPosition(address user, uint32 perp, int64 szi) internal {
        _setAnswer(POSITION, abi.encode(user, perp), _position(szi));
    }

    function _setPrices(uint32 perp, uint64 oraclePx, uint64 markPx) internal {
        _setAnswer(ORACLE_PX, abi.encode(perp), abi.encode(oraclePx));
        _setAnswer(MARK_PX, abi.encode(perp), abi.encode(markPx));
    }

    function _setL1Block(uint64 number) internal {
        _setAnswer(L1_BLOCK_NUMBER, "", abi.encode(number));
    }

    function _setAnswer(address precompile, bytes memory input, bytes memory output) internal {
        PrecompileStub(precompile).answer(input, output);
    }

    function _refuse(address precompile, bytes memory input) internal {
        PrecompileStub(precompile).refuse(input);
    }

    /// @dev A cross-margin position at 10x, the shape HyperCore returns for the test account.
    function _position(int64 szi) internal pure returns (bytes memory) {
        return abi.encode(szi, uint64(12_264_000), int64(0), uint32(10), false);
    }

    /// @dev Input of the read that `attest` makes to `precompile` for the team's ZEC position.
    function _inputFor(address precompile) internal view returns (bytes memory) {
        if (precompile == POSITION) return abi.encode(team, ZEC);
        if (precompile == L1_BLOCK_NUMBER) return "";
        return abi.encode(ZEC);
    }

    /// @dev Attests for the team as its attester, with no treasury commitment. Returns the number
    /// of the snapshot in the team's current series.
    function _attest(bytes32 journalRoot, uint64 journalCount) internal returns (uint256) {
        return _attestAs(attester, team, journalRoot, journalCount, bytes32(0));
    }

    /// @dev Attests for `user` in ZEC as `caller`. Returns the number of the snapshot in the
    /// current series of `user`.
    function _attestAs(address caller, address user, bytes32 journalRoot, uint64 journalCount, bytes32 commitment)
        internal
        returns (uint256 number)
    {
        vm.prank(caller);
        (, number) = attestor.attest(user, ZEC, journalRoot, journalCount, commitment);
    }

    /// @dev Snapshots in the team's current series.
    function _count() internal view returns (uint256) {
        return attestor.snapshotCount(team, attestor.currentSeries(team));
    }

    function _assertSnapshot(HedgeAttestor.Snapshot memory actual, HedgeAttestor.Snapshot memory expected)
        internal
        pure
    {
        assertEq(actual.perpIndex, expected.perpIndex, "perpIndex");
        assertEq(actual.szi, expected.szi, "szi");
        assertEq(actual.oraclePx, expected.oraclePx, "oraclePx");
        assertEq(actual.markPx, expected.markPx, "markPx");
        assertEq(actual.l1BlockNumber, expected.l1BlockNumber, "l1BlockNumber");
        assertEq(actual.timestamp, expected.timestamp, "timestamp");
        assertEq(actual.journalCount, expected.journalCount, "journalCount");
        assertEq(actual.journalRoot, expected.journalRoot, "journalRoot");
        assertEq(actual.treasuryCommitment, expected.treasuryCommitment, "treasuryCommitment");
    }
}
