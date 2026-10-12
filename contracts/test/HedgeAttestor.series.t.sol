// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {HedgeAttestor} from "../src/HedgeAttestor.sol";
import {CoreFixture} from "./support/CoreFixture.sol";
import {MerkleReference} from "./support/MerkleReference.sol";

contract SeriesTest is CoreFixture {
    bytes32 internal constant ROOT = keccak256("journal of three entries");
    bytes32 internal constant NEXT_ROOT = keccak256("journal of four entries");
    bytes32 internal constant INFLATED = keccak256("a journal nobody has");

    address internal stranger = makeAddr("stranger");

    function _startSeries() internal returns (uint256 series) {
        vm.prank(team);
        return attestor.startSeries();
    }

    /// @dev A good snapshot, then one that claims more entries than a journal will ever hold.
    function _brick() internal {
        _attest(ROOT, 3);
        _attest(INFLATED, type(uint64).max);
    }

    function _leaves(uint256 seed, uint256 size) internal pure returns (bytes32[] memory leaves) {
        leaves = new bytes32[](size);
        for (uint256 i = 0; i < size; ++i) {
            leaves[i] = keccak256(abi.encode(seed, i));
        }
    }

    function test_ATeamStartsInSeriesZero() public {
        assertEq(attestor.currentSeries(team), 0);
        assertEq(attestor.snapshotCount(team, 0), 0);
        assertEq(attestor.seriesEndedAt(team, 0), 0);

        vm.prank(attester);
        (uint256 series, uint256 number) = attestor.attest(team, ZEC, ROOT, 3, bytes32(0));
        assertEq(series, 0);
        assertEq(number, 0);
    }

    function test_AnInflatedJournalCountStopsItsSeries() public {
        _brick();

        // The journal really has four entries; the series can no longer say so.
        vm.prank(attester);
        vm.expectRevert(abi.encodeWithSelector(HedgeAttestor.JournalShrank.selector, type(uint64).max, uint64(4)));
        attestor.attest(team, ZEC, NEXT_ROOT, 4, bytes32(0));

        // Nor does matching the inflated count help: the root would have to be the inflated one.
        vm.prank(attester);
        vm.expectRevert(abi.encodeWithSelector(HedgeAttestor.JournalRewritten.selector, INFLATED, NEXT_ROOT));
        attestor.attest(team, ZEC, NEXT_ROOT, type(uint64).max, bytes32(0));

        assertEq(attestor.snapshotCount(team, 0), 2);
    }

    function test_TheTeamStartsANewSeriesAndAttestationsResume() public {
        _brick();
        vm.warp(NOW + 3600);

        vm.expectEmit(address(attestor));
        emit HedgeAttestor.SeriesStarted(team, 1);
        uint256 started = _startSeries();

        assertEq(started, 1);
        assertEq(attestor.currentSeries(team), 1);
        assertEq(attestor.seriesEndedAt(team, 0), NOW + 3600);
        assertEq(attestor.seriesEndedAt(team, 1), 0);
        assertEq(attestor.snapshotCount(team, 1), 0);

        vm.warp(NOW + 3660);
        HedgeAttestor.Snapshot memory expected = HedgeAttestor.Snapshot({
            perpIndex: ZEC,
            szi: -1,
            oraclePx: ORACLE,
            markPx: MARK,
            l1BlockNumber: L1_BLOCK,
            timestamp: NOW + 3660,
            journalCount: 4,
            journalRoot: NEXT_ROOT,
            treasuryCommitment: bytes32(0)
        });
        vm.expectEmit(address(attestor));
        emit HedgeAttestor.Attested(team, 1, 0, attester, expected);
        vm.prank(attester);
        (uint256 series, uint256 number) = attestor.attest(team, ZEC, NEXT_ROOT, 4, bytes32(0));

        assertEq(series, 1);
        assertEq(number, 0);
        (uint256 latest, HedgeAttestor.Snapshot memory snap) = attestor.latestSnapshot(team, 1);
        assertEq(latest, 0);
        _assertSnapshot(snap, expected);
    }

    function test_TheRulesHoldInsideTheNewSeries() public {
        _brick();
        _startSeries();
        assertEq(_attest(NEXT_ROOT, 4), 0);

        vm.prank(attester);
        vm.expectRevert(abi.encodeWithSelector(HedgeAttestor.JournalShrank.selector, uint64(4), uint64(3)));
        attestor.attest(team, ZEC, ROOT, 3, bytes32(0));

        vm.prank(attester);
        vm.expectRevert(abi.encodeWithSelector(HedgeAttestor.JournalRewritten.selector, NEXT_ROOT, ROOT));
        attestor.attest(team, ZEC, ROOT, 4, bytes32(0));

        assertEq(_attest(NEXT_ROOT, 4), 1);
        assertEq(_attest(keccak256("journal of five entries"), 5), 2);
        assertEq(attestor.snapshotCount(team, 1), 3);
    }

    function test_AClosedSeriesKeepsItsSnapshotsAndTheyStillVerify() public {
        bytes32[] memory journal = _leaves(1, 7);
        bytes32[] memory prefix = _leaves(1, 5);
        _attest(MerkleReference.root(prefix), 5);
        vm.warp(NOW + 60);
        _setPosition(team, ZEC, -5);
        _attest(MerkleReference.root(journal), 7);
        _attest(INFLATED, type(uint64).max);

        HedgeAttestor.Snapshot memory first = attestor.snapshot(team, 0, 0);
        HedgeAttestor.Snapshot memory second = attestor.snapshot(team, 0, 1);
        HedgeAttestor.Snapshot memory third = attestor.snapshot(team, 0, 2);

        vm.warp(NOW + 3600);
        _startSeries();
        _setPosition(team, ZEC, 0);
        bytes32[] memory rebuilt = _leaves(2, 3);
        _attest(MerkleReference.root(rebuilt), 3);

        assertEq(attestor.snapshotCount(team, 0), 3);
        _assertSnapshot(attestor.snapshot(team, 0, 0), first);
        _assertSnapshot(attestor.snapshot(team, 0, 1), second);
        _assertSnapshot(attestor.snapshot(team, 0, 2), third);
        (uint256 latest, HedgeAttestor.Snapshot memory last) = attestor.latestSnapshot(team, 0);
        assertEq(latest, 2);
        _assertSnapshot(last, third);
        assertEq(first.szi, -1);
        assertEq(second.szi, -5);

        assertTrue(attestor.verifyEntry(team, 0, 0, prefix[2], MerkleReference.proof(prefix, 2)));
        assertTrue(attestor.verifyEntry(team, 0, 1, journal[6], MerkleReference.proof(journal, 6)));
        assertTrue(attestor.verifyEntry(team, 1, 0, rebuilt[1], MerkleReference.proof(rebuilt, 1)));

        // A snapshot answers for its own series only.
        assertFalse(attestor.verifyEntry(team, 1, 0, journal[6], MerkleReference.proof(journal, 6)));
        assertFalse(attestor.verifyEntry(team, 0, 1, rebuilt[1], MerkleReference.proof(rebuilt, 1)));
    }

    function test_AClosedSeriesTakesNoMoreSnapshots() public {
        _attest(ROOT, 3);
        _startSeries();

        vm.prank(attester);
        (uint256 series, uint256 number) = attestor.attest(team, ZEC, NEXT_ROOT, 4, bytes32(0));

        assertEq(series, 1);
        assertEq(number, 0);
        assertEq(attestor.snapshotCount(team, 0), 1);
        assertEq(attestor.snapshot(team, 0, 0).journalRoot, ROOT);
        vm.expectRevert(abi.encodeWithSelector(HedgeAttestor.UnknownSnapshot.selector, team, 0, 1));
        attestor.snapshot(team, 0, 1);
    }

    function test_OnlyTheTeamStartsItsSeries() public {
        _attest(ROOT, 3);

        // Starting a series acts on the caller's own account. The attester has no history there.
        vm.prank(attester);
        vm.expectRevert(abi.encodeWithSelector(HedgeAttestor.SeriesUnused.selector, attester, 0));
        attestor.startSeries();

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(HedgeAttestor.SeriesUnused.selector, stranger, 0));
        attestor.startSeries();

        assertEq(attestor.currentSeries(team), 0);
        assertEq(attestor.seriesEndedAt(team, 0), 0);
    }

    function test_AnAttesterWithItsOwnHistoryMovesOnlyItsOwnSeries() public {
        _attest(ROOT, 3);
        _setPosition(attester, ZEC, 0);
        vm.startPrank(attester);
        attestor.setAttester(attester);
        attestor.attest(attester, ZEC, ROOT, 3, bytes32(0));
        assertEq(attestor.startSeries(), 1);
        vm.stopPrank();

        assertEq(attestor.currentSeries(attester), 1);
        assertEq(attestor.currentSeries(team), 0);
        assertEq(attestor.seriesEndedAt(team, 0), 0);

        // Its next snapshot for the team still continues the team's series, under the same rules.
        vm.prank(attester);
        vm.expectRevert(abi.encodeWithSelector(HedgeAttestor.JournalShrank.selector, uint64(3), uint64(1)));
        attestor.attest(team, ZEC, keccak256("one entry"), 1, bytes32(0));
        assertEq(_attest(NEXT_ROOT, 4), 1);
    }

    function testFuzz_NobodyButTheTeamMovesItsSeries(address caller) public {
        vm.assume(caller != team);
        _attest(ROOT, 3);

        vm.prank(caller);
        (bool ok,) = address(attestor).call(abi.encodeCall(HedgeAttestor.startSeries, ()));

        assertFalse(ok);
        assertEq(attestor.currentSeries(team), 0);
        assertEq(attestor.seriesEndedAt(team, 0), 0);
        assertEq(attestor.snapshotCount(team, 0), 1);
    }

    function test_ASeriesWithoutSnapshotsCannotBeAbandoned() public {
        vm.prank(team);
        vm.expectRevert(abi.encodeWithSelector(HedgeAttestor.SeriesUnused.selector, team, 0));
        attestor.startSeries();

        _attest(ROOT, 3);
        assertEq(_startSeries(), 1);

        vm.prank(team);
        vm.expectRevert(abi.encodeWithSelector(HedgeAttestor.SeriesUnused.selector, team, 1));
        attestor.startSeries();

        assertEq(attestor.currentSeries(team), 1);
    }

    function test_AStolenAttesterKeyCannotBlockTheTeamForGood() public {
        address next = makeAddr("next attester");
        _brick();

        // The team names a new attester first, then starts over.
        vm.startPrank(team);
        attestor.setAttester(next);
        attestor.startSeries();
        vm.stopPrank();

        vm.prank(attester);
        vm.expectRevert(abi.encodeWithSelector(HedgeAttestor.NotAttester.selector, team, attester));
        attestor.attest(team, ZEC, INFLATED, type(uint64).max, bytes32(0));

        assertEq(_attestAs(next, team, NEXT_ROOT, 4, bytes32(0)), 0);
        assertEq(attestor.snapshotCount(team, 1), 1);
        assertEq(attestor.snapshotCount(team, 0), 2);
    }

    function test_AnInflatedCountCanBeRecoveredFromEveryTime() public {
        for (uint256 series = 0; series < 4; ++series) {
            assertEq(_attest(ROOT, 3), 0);
            assertEq(_attest(INFLATED, type(uint64).max), 1);

            vm.prank(attester);
            vm.expectRevert(abi.encodeWithSelector(HedgeAttestor.JournalShrank.selector, type(uint64).max, uint64(4)));
            attestor.attest(team, ZEC, NEXT_ROOT, 4, bytes32(0));

            assertEq(_startSeries(), series + 1);
        }
        assertEq(_attest(NEXT_ROOT, 4), 0);
        assertEq(attestor.currentSeries(team), 4);
    }

    function test_NamingOrRemovingAnAttesterDoesNotStartASeries() public {
        _attest(ROOT, 3);

        vm.startPrank(team);
        attestor.setAttester(makeAddr("next attester"));
        attestor.removeAttester();
        attestor.setAttester(attester);
        vm.stopPrank();

        assertEq(attestor.currentSeries(team), 0);
        assertEq(attestor.seriesEndedAt(team, 0), 0);
        assertEq(_attest(NEXT_ROOT, 4), 1);
    }

    function test_StartingASeriesLeavesTheAttesterInPlace() public {
        _attest(ROOT, 3);
        _startSeries();

        assertEq(attestor.attesterOf(team), attester);
        assertEq(_attest(ROOT, 3), 0);
    }

    function test_EverySeriesRecordsWhenItWasClosed() public {
        _attest(ROOT, 3);
        vm.warp(NOW + 100);
        _startSeries();

        _attest(ROOT, 3);
        _attest(NEXT_ROOT, 4);
        vm.warp(NOW + 250);
        _startSeries();

        assertEq(attestor.currentSeries(team), 2);
        assertEq(attestor.seriesEndedAt(team, 0), NOW + 100);
        assertEq(attestor.seriesEndedAt(team, 1), NOW + 250);
        assertEq(attestor.seriesEndedAt(team, 2), 0);
        assertEq(attestor.snapshotCount(team, 0), 1);
        assertEq(attestor.snapshotCount(team, 1), 2);
        assertEq(attestor.snapshotCount(team, 2), 0);

        vm.expectRevert(abi.encodeWithSelector(HedgeAttestor.NoSnapshots.selector, team, 2));
        attestor.latestSnapshot(team, 2);
        vm.expectRevert(abi.encodeWithSelector(HedgeAttestor.UnknownSeries.selector, team, 3));
        attestor.seriesEndedAt(team, 3);
    }

    function test_SeriesAreCountedPerTeam() public {
        address other = makeAddr("other team");
        _setPosition(other, ZEC, 0);
        vm.prank(other);
        attestor.setAttester(attester);
        _attestAs(attester, other, ROOT, 3, bytes32(0));

        _brick();
        _startSeries();

        assertEq(attestor.currentSeries(team), 1);
        assertEq(attestor.currentSeries(other), 0);
        assertEq(attestor.seriesEndedAt(other, 0), 0);
        assertEq(_attestAs(attester, other, NEXT_ROOT, 4, bytes32(0)), 1);
    }

    function testFuzz_ANewSeriesIsNotHeldToTheOldCount(uint64 oldCount, uint64 newCount) public {
        oldCount = uint64(bound(oldCount, 1, type(uint64).max));
        newCount = uint64(bound(newCount, 1, type(uint64).max));
        _attest(ROOT, oldCount);
        _startSeries();

        vm.prank(attester);
        (uint256 series, uint256 number) = attestor.attest(team, ZEC, NEXT_ROOT, newCount, bytes32(0));

        assertEq(series, 1);
        assertEq(number, 0);
        assertEq(attestor.snapshot(team, 0, 0).journalCount, oldCount);
        assertEq(attestor.snapshot(team, 1, 0).journalCount, newCount);
    }
}
