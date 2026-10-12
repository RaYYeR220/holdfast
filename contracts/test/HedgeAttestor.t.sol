// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {HedgeAttestor} from "../src/HedgeAttestor.sol";
import {CoreFixture} from "./support/CoreFixture.sol";

contract RegistrationTest is CoreFixture {
    address internal stranger = makeAddr("stranger");

    function test_ATeamNamesItsAttester() public {
        address other = makeAddr("other team");

        vm.expectEmit(address(attestor));
        emit HedgeAttestor.AttesterSet(other, attester, address(0));
        vm.prank(other);
        attestor.setAttester(attester);

        assertEq(attestor.attesterOf(other), attester);
    }

    function test_ATeamReplacesItsAttester() public {
        address next = makeAddr("next attester");

        vm.expectEmit(address(attestor));
        emit HedgeAttestor.AttesterSet(team, next, attester);
        vm.prank(team);
        attestor.setAttester(next);

        assertEq(attestor.attesterOf(team), next);

        vm.prank(attester);
        vm.expectRevert(abi.encodeWithSelector(HedgeAttestor.NotAttester.selector, team, attester));
        attestor.attest(team, ZEC, bytes32(0), 0, bytes32(0));

        assertEq(_attestAs(next, team, bytes32(0), 0, bytes32(0)), 0);
    }

    function test_ATeamRemovesItsAttester() public {
        vm.expectEmit(address(attestor));
        emit HedgeAttestor.AttesterRemoved(team, attester);
        vm.prank(team);
        attestor.removeAttester();

        assertEq(attestor.attesterOf(team), address(0));

        vm.prank(attester);
        vm.expectRevert(abi.encodeWithSelector(HedgeAttestor.NotAttester.selector, team, attester));
        attestor.attest(team, ZEC, bytes32(0), 0, bytes32(0));
    }

    function test_RemovingKeepsTheSnapshotsAlreadyRecorded() public {
        _attest(bytes32(0), 0);

        vm.prank(team);
        attestor.removeAttester();

        assertEq(attestor.snapshotCount(team, 0), 1);
        assertEq(attestor.snapshot(team, 0, 0).szi, -1);
    }

    function test_TheZeroAddressCannotBeAnAttester() public {
        vm.prank(team);
        vm.expectRevert(HedgeAttestor.ZeroAttester.selector);
        attestor.setAttester(address(0));

        assertEq(attestor.attesterOf(team), attester);
    }

    function test_RemovingNeedsAnAttesterToRemove() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(HedgeAttestor.NoAttester.selector, stranger));
        attestor.removeAttester();
    }

    function test_NobodyElseCanRegisterForATeam() public {
        address theirs = makeAddr("stranger's attester");

        // Registration always acts on the caller's own account: there is no way to name the team.
        vm.prank(stranger);
        attestor.setAttester(theirs);
        assertEq(attestor.attesterOf(stranger), theirs);
        assertEq(attestor.attesterOf(team), attester);

        vm.prank(theirs);
        vm.expectRevert(abi.encodeWithSelector(HedgeAttestor.NotAttester.selector, team, theirs));
        attestor.attest(team, ZEC, bytes32(0), 0, bytes32(0));

        // Nor can the attester rename itself: it would only register for its own address.
        vm.prank(attester);
        attestor.setAttester(theirs);
        assertEq(attestor.attesterOf(team), attester);
    }

    function testFuzz_OnlyTheNamedAttesterAttests(address caller) public {
        vm.assume(caller != attester);

        vm.prank(caller);
        vm.expectRevert(abi.encodeWithSelector(HedgeAttestor.NotAttester.selector, team, caller));
        attestor.attest(team, ZEC, bytes32(0), 0, bytes32(0));

        assertEq(attestor.snapshotCount(team, 0), 0);
    }

    function test_ATeamIsNotItsOwnAttesterUnlessItSaysSo() public {
        vm.prank(team);
        vm.expectRevert(abi.encodeWithSelector(HedgeAttestor.NotAttester.selector, team, team));
        attestor.attest(team, ZEC, bytes32(0), 0, bytes32(0));

        vm.prank(team);
        attestor.setAttester(team);
        assertEq(_attestAs(team, team, bytes32(0), 0, bytes32(0)), 0);
    }

    function test_AnAccountWithoutAnAttesterCannotBeAttestedFor() public {
        _setPosition(stranger, ZEC, 0);

        vm.prank(attester);
        vm.expectRevert(abi.encodeWithSelector(HedgeAttestor.NotAttester.selector, stranger, attester));
        attestor.attest(stranger, ZEC, bytes32(0), 0, bytes32(0));
    }
}

contract AttestTest is CoreFixture {
    bytes32 internal constant ROOT = keccak256("journal of three entries");
    bytes32 internal constant COMMITMENT = keccak256("treasury");

    function _expected(int64 szi, bytes32 journalRoot, uint64 journalCount)
        internal
        pure
        returns (HedgeAttestor.Snapshot memory)
    {
        return HedgeAttestor.Snapshot({
            perpIndex: ZEC,
            szi: szi,
            oraclePx: ORACLE,
            markPx: MARK,
            l1BlockNumber: L1_BLOCK,
            timestamp: NOW,
            journalCount: journalCount,
            journalRoot: journalRoot,
            treasuryCommitment: COMMITMENT
        });
    }

    function test_StoresAndEmitsWhatHyperCoreReports() public {
        HedgeAttestor.Snapshot memory expected = _expected(-1, ROOT, 3);

        vm.expectEmit(address(attestor));
        emit HedgeAttestor.Attested(team, 0, 0, attester, expected);
        vm.prank(attester);
        (uint256 series, uint256 number) = attestor.attest(team, ZEC, ROOT, 3, COMMITMENT);

        assertEq(series, 0);
        assertEq(number, 0);
        assertEq(attestor.snapshotCount(team, 0), 1);
        _assertSnapshot(attestor.snapshot(team, 0, 0), expected);

        (uint256 latest, HedgeAttestor.Snapshot memory snap) = attestor.latestSnapshot(team, 0);
        assertEq(latest, 0);
        _assertSnapshot(snap, expected);
    }

    function test_ReadsThePositionOfTheNamedUserInTheNamedPerp() public {
        address other = makeAddr("other team");
        uint32 btc = 0;
        _setPosition(other, ZEC, 250);
        _setPosition(team, btc, 0);
        _setPrices(btc, 1_234_560, 1_234_000);
        vm.prank(other);
        attestor.setAttester(attester);

        vm.startPrank(attester);
        attestor.attest(team, ZEC, bytes32(0), 0, bytes32(0));
        attestor.attest(other, ZEC, bytes32(0), 0, bytes32(0));
        attestor.attest(team, btc, bytes32(0), 0, bytes32(0));
        vm.stopPrank();

        assertEq(attestor.snapshot(team, 0, 0).szi, -1);
        assertEq(attestor.snapshot(other, 0, 0).szi, 250);

        HedgeAttestor.Snapshot memory flat = attestor.snapshot(team, 0, 1);
        assertEq(flat.perpIndex, btc);
        assertEq(flat.szi, 0);
        assertEq(flat.oraclePx, 1_234_560);
        assertEq(flat.markPx, 1_234_000);
    }

    function test_SnapshotsAreNumberedAndNeverRewritten() public {
        HedgeAttestor.Snapshot memory first = _expected(-1, ROOT, 3);
        assertEq(_attestAs(attester, team, ROOT, 3, COMMITMENT), 0);

        vm.warp(NOW + 60);
        _setPosition(team, ZEC, -5);
        _setPrices(ZEC, ORACLE + 100, MARK + 100);
        _setL1Block(L1_BLOCK + 600);
        bytes32 nextRoot = keccak256("journal of four entries");
        assertEq(_attestAs(attester, team, nextRoot, 4, COMMITMENT), 1);

        vm.warp(NOW + 120);
        _setPosition(team, ZEC, 0);
        assertEq(_attestAs(attester, team, nextRoot, 4, COMMITMENT), 2);

        assertEq(attestor.snapshotCount(team, 0), 3);
        _assertSnapshot(attestor.snapshot(team, 0, 0), first);

        HedgeAttestor.Snapshot memory second = attestor.snapshot(team, 0, 1);
        assertEq(second.szi, -5);
        assertEq(second.oraclePx, ORACLE + 100);
        assertEq(second.markPx, MARK + 100);
        assertEq(second.l1BlockNumber, L1_BLOCK + 600);
        assertEq(second.timestamp, NOW + 60);
        assertEq(second.journalCount, 4);
        assertEq(second.journalRoot, nextRoot);

        (uint256 latest, HedgeAttestor.Snapshot memory third) = attestor.latestSnapshot(team, 0);
        assertEq(latest, 2);
        assertEq(third.szi, 0);
        assertEq(third.timestamp, NOW + 120);
    }

    function test_TheJournalCannotShrink() public {
        _attest(ROOT, 3);

        vm.prank(attester);
        vm.expectRevert(abi.encodeWithSelector(HedgeAttestor.JournalShrank.selector, uint64(3), uint64(2)));
        attestor.attest(team, ZEC, keccak256("shorter"), 2, COMMITMENT);

        vm.prank(attester);
        vm.expectRevert(abi.encodeWithSelector(HedgeAttestor.JournalShrank.selector, uint64(3), uint64(0)));
        attestor.attest(team, ZEC, bytes32(0), 0, COMMITMENT);

        assertEq(attestor.snapshotCount(team, 0), 1);
    }

    function test_TheJournalMayStayTheSameOrGrow() public {
        assertEq(_attest(bytes32(0), 0), 0);
        assertEq(_attest(bytes32(0), 0), 1);
        assertEq(_attest(ROOT, 3), 2);
        assertEq(_attest(ROOT, 3), 3);
        assertEq(_attest(keccak256("longer"), type(uint64).max), 4);
    }

    function test_AJournalOfTheSameLengthKeepsItsRoot() public {
        _attest(ROOT, 3);
        bytes32 other = keccak256("another journal of three entries");

        vm.prank(attester);
        vm.expectRevert(abi.encodeWithSelector(HedgeAttestor.JournalRewritten.selector, ROOT, other));
        attestor.attest(team, ZEC, other, 3, COMMITMENT);

        assertEq(attestor.snapshotCount(team, 0), 1);
    }

    function test_AnEmptyJournalHasTheZeroRootAndOnlyAnEmptyOne() public {
        vm.prank(attester);
        vm.expectRevert(abi.encodeWithSelector(HedgeAttestor.JournalRootCountMismatch.selector, ROOT, uint64(0)));
        attestor.attest(team, ZEC, ROOT, 0, COMMITMENT);

        vm.prank(attester);
        vm.expectRevert(abi.encodeWithSelector(HedgeAttestor.JournalRootCountMismatch.selector, bytes32(0), uint64(3)));
        attestor.attest(team, ZEC, bytes32(0), 3, COMMITMENT);

        assertEq(attestor.snapshotCount(team, 0), 0);
    }

    function test_EachTeamHasItsOwnHistory() public {
        address other = makeAddr("other team");
        _setPosition(other, ZEC, 0);
        vm.prank(other);
        attestor.setAttester(attester);

        _attest(ROOT, 3);

        assertEq(_attestAs(attester, other, keccak256("one entry"), 1, COMMITMENT), 0);
        assertEq(attestor.snapshotCount(team, 0), 1);
        assertEq(attestor.snapshotCount(other, 0), 1);
    }

    function test_ViewsRefuseSnapshotsThatDoNotExist() public {
        vm.expectRevert(abi.encodeWithSelector(HedgeAttestor.NoSnapshots.selector, team, 0));
        attestor.latestSnapshot(team, 0);

        vm.expectRevert(abi.encodeWithSelector(HedgeAttestor.UnknownSnapshot.selector, team, 0, 0));
        attestor.snapshot(team, 0, 0);

        _attest(ROOT, 3);

        vm.expectRevert(abi.encodeWithSelector(HedgeAttestor.UnknownSnapshot.selector, team, 0, 1));
        attestor.snapshot(team, 0, 1);
    }

    function test_ViewsRefuseSeriesThatDoNotExist() public {
        _attest(ROOT, 3);

        vm.expectRevert(abi.encodeWithSelector(HedgeAttestor.UnknownSeries.selector, team, 1));
        attestor.snapshotCount(team, 1);

        vm.expectRevert(abi.encodeWithSelector(HedgeAttestor.UnknownSeries.selector, team, 1));
        attestor.seriesEndedAt(team, 1);

        vm.expectRevert(abi.encodeWithSelector(HedgeAttestor.UnknownSeries.selector, team, 1));
        attestor.snapshot(team, 1, 0);

        vm.expectRevert(abi.encodeWithSelector(HedgeAttestor.UnknownSeries.selector, team, 1));
        attestor.latestSnapshot(team, 1);

        vm.expectRevert(abi.encodeWithSelector(HedgeAttestor.UnknownSeries.selector, team, 7));
        attestor.verifyEntry(team, 7, 0, ROOT, new bytes32[](0));
    }

    function testFuzz_StoresWhateverHyperCoreReports(
        int64 szi,
        uint64 oraclePx,
        uint64 markPx,
        uint64 l1Block,
        uint32 perp,
        uint64 timestamp,
        bytes32 commitment
    ) public {
        oraclePx = uint64(bound(oraclePx, 1, type(uint64).max));
        markPx = uint64(bound(markPx, 1, type(uint64).max));
        _setPosition(team, perp, szi);
        _setPrices(perp, oraclePx, markPx);
        _setL1Block(l1Block);
        vm.warp(timestamp);

        vm.prank(attester);
        attestor.attest(team, perp, ROOT, 3, commitment);

        _assertSnapshot(
            attestor.snapshot(team, 0, 0),
            HedgeAttestor.Snapshot({
                perpIndex: perp,
                szi: szi,
                oraclePx: oraclePx,
                markPx: markPx,
                l1BlockNumber: l1Block,
                timestamp: timestamp,
                journalCount: 3,
                journalRoot: ROOT,
                treasuryCommitment: commitment
            })
        );
    }
}

contract PrecompileReadTest is CoreFixture {
    bytes32 internal constant ROOT = keccak256("journal of three entries");

    address[4] internal precompiles = [POSITION, ORACLE_PX, MARK_PX, L1_BLOCK_NUMBER];

    /// @dev One good snapshot first, so that "nothing is stored" can be checked against a history.
    function setUp() public override {
        super.setUp();
        _attest(ROOT, 3);
    }

    function _attestExpecting(bytes memory revertData) internal {
        HedgeAttestor.Snapshot memory before = attestor.snapshot(team, 0, 0);

        vm.prank(attester);
        vm.expectRevert(revertData);
        attestor.attest{gas: CALL_GAS}(team, ZEC, keccak256("journal of four entries"), 4, bytes32(0));

        assertEq(attestor.snapshotCount(team, 0), 1, "a snapshot was stored");
        _assertSnapshot(attestor.snapshot(team, 0, 0), before);
    }

    function _expectMalformed(address precompile, bytes memory output) internal {
        _setAnswer(precompile, _inputFor(precompile), output);
        _attestExpecting(abi.encodeWithSelector(HedgeAttestor.MalformedPrecompileData.selector, precompile));
    }

    function test_ARefusedReadRevertsAndStoresNothing() public {
        for (uint256 i = 0; i < precompiles.length; ++i) {
            uint256 state = vm.snapshotState();
            _refuse(precompiles[i], _inputFor(precompiles[i]));
            _attestExpecting(abi.encodeWithSelector(HedgeAttestor.PrecompileReadFailed.selector, precompiles[i]));
            vm.revertToState(state);
        }
    }

    function test_AnUnknownPerpIsARefusedRead() public {
        vm.prank(attester);
        vm.expectRevert(abi.encodeWithSelector(HedgeAttestor.PrecompileReadFailed.selector, POSITION));
        attestor.attest{gas: CALL_GAS}(team, ZEC + 1, ROOT, 3, bytes32(0));

        // The position exists but the perpetual has no price.
        _setPosition(team, ZEC + 1, 0);
        vm.prank(attester);
        vm.expectRevert(abi.encodeWithSelector(HedgeAttestor.PrecompileReadFailed.selector, ORACLE_PX));
        attestor.attest{gas: CALL_GAS}(team, ZEC + 1, ROOT, 3, bytes32(0));

        assertEq(attestor.snapshotCount(team, 0), 1);
    }

    function test_ARefusedReadLeavesEnoughGasToSayWhy() public {
        _refuse(L1_BLOCK_NUMBER, "");

        // The last of the four reads fails with the least gas left to report it.
        vm.prank(attester);
        vm.expectRevert(abi.encodeWithSelector(HedgeAttestor.PrecompileReadFailed.selector, L1_BLOCK_NUMBER));
        attestor.attest{gas: 120_000}(team, ZEC, ROOT, 3, bytes32(0));
    }

    function test_AMissingPrecompileRevertsAndStoresNothing() public {
        // On a chain without HyperCore the addresses hold no code and a call returns nothing.
        for (uint256 i = 0; i < precompiles.length; ++i) {
            uint256 state = vm.snapshotState();
            vm.etch(precompiles[i], "");
            _attestExpecting(abi.encodeWithSelector(HedgeAttestor.MalformedPrecompileData.selector, precompiles[i]));
            vm.revertToState(state);
        }
    }

    function test_AnAnswerOfTheWrongLengthIsMalformed() public {
        _expectMalformed(POSITION, "");
        _expectMalformed(POSITION, abi.encode(int64(-1), uint64(0), int64(0), uint32(10)));
        _expectMalformed(POSITION, abi.encode(int64(-1), uint64(0), int64(0), uint32(10), false, uint256(0)));
        _expectMalformed(POSITION, bytes.concat(_position(-1), hex"00"));
        _setPosition(team, ZEC, -1);

        _expectMalformed(ORACLE_PX, "");
        _expectMalformed(ORACLE_PX, abi.encodePacked(ORACLE));
        _expectMalformed(ORACLE_PX, abi.encode(ORACLE, uint256(0)));
        _setPrices(ZEC, ORACLE, MARK);

        _expectMalformed(MARK_PX, "");
        _expectMalformed(MARK_PX, abi.encodePacked(uint248(MARK)));
        _expectMalformed(MARK_PX, abi.encode(MARK, uint256(0)));
        _setPrices(ZEC, ORACLE, MARK);

        _expectMalformed(L1_BLOCK_NUMBER, "");
        _expectMalformed(L1_BLOCK_NUMBER, abi.encodePacked(L1_BLOCK));
        _expectMalformed(L1_BLOCK_NUMBER, abi.encode(L1_BLOCK, uint256(0)));
    }

    function test_APositionWordOutsideItsTypeIsMalformed() public {
        uint256 ok = 0;
        // szi above and below int64
        _expectMalformed(POSITION, abi.encode(uint256(1) << 63, ok, ok, ok, ok));
        _expectMalformed(POSITION, abi.encode(int256(type(int64).min) - 1, ok, ok, ok, ok));
        // entryNtl above uint64
        _expectMalformed(POSITION, abi.encode(int256(-1), uint256(1) << 64, ok, ok, ok));
        // isolatedRawUsd above and below int64
        _expectMalformed(POSITION, abi.encode(int256(-1), ok, uint256(1) << 63, ok, ok));
        _expectMalformed(POSITION, abi.encode(int256(-1), ok, int256(type(int64).min) - 1, ok, ok));
        // leverage above uint32
        _expectMalformed(POSITION, abi.encode(int256(-1), ok, ok, uint256(1) << 32, ok));
        // isIsolated that is neither false nor true
        _expectMalformed(POSITION, abi.encode(int256(-1), ok, ok, ok, uint256(2)));
    }

    function test_APriceOrBlockNumberAboveUint64IsMalformed() public {
        uint256 tooLarge = uint256(type(uint64).max) + 1;

        _expectMalformed(ORACLE_PX, abi.encode(tooLarge));
        _setPrices(ZEC, ORACLE, MARK);
        _expectMalformed(MARK_PX, abi.encode(tooLarge));
        _setPrices(ZEC, ORACLE, MARK);
        _expectMalformed(L1_BLOCK_NUMBER, abi.encode(tooLarge));
    }

    function test_AZeroPriceIsNotAPrice() public {
        _setPrices(ZEC, 0, MARK);
        _attestExpecting(abi.encodeWithSelector(HedgeAttestor.ZeroPrice.selector, ORACLE_PX));

        _setPrices(ZEC, ORACLE, 0);
        _attestExpecting(abi.encodeWithSelector(HedgeAttestor.ZeroPrice.selector, MARK_PX));
    }

    function test_TheWidestValuesOfEachTypeAreAccepted() public {
        _setAnswer(
            POSITION,
            abi.encode(team, ZEC),
            abi.encode(type(int64).min, type(uint64).max, type(int64).min, type(uint32).max, true)
        );
        _setPrices(ZEC, type(uint64).max, type(uint64).max);
        _setL1Block(type(uint64).max);
        assertEq(_attest(ROOT, 3), 1);

        _setAnswer(
            POSITION, abi.encode(team, ZEC), abi.encode(type(int64).max, uint64(0), type(int64).max, uint32(0), false)
        );
        assertEq(_attest(ROOT, 3), 2);

        HedgeAttestor.Snapshot memory short = attestor.snapshot(team, 0, 1);
        assertEq(short.szi, type(int64).min);
        assertEq(short.oraclePx, type(uint64).max);
        assertEq(short.markPx, type(uint64).max);
        assertEq(short.l1BlockNumber, type(uint64).max);
        assertEq(attestor.snapshot(team, 0, 2).szi, type(int64).max);
    }

    function testFuzz_AMalformedPositionStoresNothing(bytes memory output) public {
        vm.assume(output.length != 160);
        _expectMalformed(POSITION, output);
    }

    function testFuzz_AMalformedPriceStoresNothing(bytes memory output, bool mark) public {
        vm.assume(output.length != 32);
        _expectMalformed(mark ? MARK_PX : ORACLE_PX, output);
    }
}
