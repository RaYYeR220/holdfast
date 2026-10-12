// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {Test, console} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {HedgeAttestor} from "../src/HedgeAttestor.sol";
import {AttestProbe} from "./support/AttestProbe.sol";

/// @notice Answers a precompile call by asking a HyperEVM node. A chain forked into forge has no
/// HyperCore behind it and its precompile addresses are empty, so this contract is placed on them
/// and passes every call on, unchanged, as an `eth_call` to the node the fork was made from.
contract NodePrecompile {
    Vm private constant VM = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    fallback(bytes calldata input) external returns (bytes memory) {
        return VM.rpc(
            "eth_call",
            string.concat('[{"to":"', VM.toString(address(this)), '","data":"', VM.toString(input), '"},"latest"]')
        );
    }
}

/// @notice Read-only checks against HyperEVM mainnet. They run only when HYPEREVM_FORK_URL is set:
///
///   HYPEREVM_FORK_URL=https://rpc.hyperliquid.xyz/evm forge test --match-contract HyperEvmForkTest -vv
///
/// Nothing is sent to the chain. The account is a public one that held a short of 0.01 ZEC when
/// this was written; if it trades, the expected size below has to follow.
contract HyperEvmForkTest is Test {
    struct PerpAssetInfo {
        string coin;
        uint32 marginTableId;
        uint8 szDecimals;
        uint8 maxLeverage;
        bool onlyIsolated;
    }

    address internal constant POSITION = 0x0000000000000000000000000000000000000813;
    address internal constant MARK_PX = 0x0000000000000000000000000000000000000806;
    address internal constant ORACLE_PX = 0x0000000000000000000000000000000000000807;
    address internal constant L1_BLOCK_NUMBER = 0x0000000000000000000000000000000000000809;
    address internal constant PERP_ASSET_INFO = 0x000000000000000000000000000000000000080a;

    uint256 internal constant HYPEREVM_MAINNET = 999;
    uint256 internal constant SMALL_BLOCK_GAS = 3_000_000;

    address internal constant ACCOUNT = 0xC7e7BAAFb0C822d0A934BbB2268F15A7eD8485bc;
    uint32 internal constant ZEC = 214;
    uint8 internal constant ZEC_SZ_DECIMALS = 2;
    /// @dev 0.01 ZEC short: one unit at two decimals of size.
    int64 internal constant EXPECTED_SZI = -1;

    /// @dev Bounds of a believable ZEC price, in dollars.
    uint256 internal constant MIN_USD = 100;
    uint256 internal constant MAX_USD = 10_000;

    bool internal live;
    HedgeAttestor internal attestor;

    function setUp() public {
        string memory url = vm.envOr("HYPEREVM_FORK_URL", string(""));
        live = bytes(url).length != 0;
        if (!live) return;

        vm.createSelectFork(url);
        bytes memory forwarder = address(new NodePrecompile()).code;
        address[5] memory precompiles = [POSITION, MARK_PX, ORACLE_PX, L1_BLOCK_NUMBER, PERP_ASSET_INFO];
        for (uint256 i = 0; i < precompiles.length; ++i) {
            vm.etch(precompiles[i], forwarder);
            vm.allowCheatcodes(precompiles[i]);
        }
        attestor = new HedgeAttestor();
    }

    modifier onlyLive() {
        vm.skip(!live);
        _;
    }

    /// @dev A raw perpetual price in dollars: it carries 6 - szDecimals decimals.
    function _usd(uint64 px, uint8 szDecimals) internal pure returns (string memory) {
        uint256 decimals = 6 - szDecimals;
        uint256 unit = 10 ** decimals;
        bytes memory fraction = bytes(vm.toString(px % unit));
        bytes memory padding = new bytes(decimals - fraction.length);
        for (uint256 i = 0; i < padding.length; ++i) {
            padding[i] = "0";
        }
        return string.concat("$", vm.toString(px / unit), ".", string(padding), string(fraction));
    }

    function _assertBelievable(uint64 px, string memory what) internal pure {
        uint256 unit = 10 ** (6 - ZEC_SZ_DECIMALS);
        assertGe(px, MIN_USD * unit, what);
        assertLe(px, MAX_USD * unit, what);
    }

    /// @dev A JSON-RPC quantity read back into a number.
    function _quantity(bytes memory answer) internal pure returns (uint256 value) {
        for (uint256 i = 0; i < answer.length; ++i) {
            value = (value << 8) | uint8(answer[i]);
        }
    }

    /// @dev A number written as a JSON-RPC quantity: hex without leading zeros.
    function _quantityHex(uint256 value) internal pure returns (string memory) {
        if (value == 0) return "0x0";
        bytes16 digits = "0123456789abcdef";
        uint256 length;
        for (uint256 rest = value; rest != 0; rest >>= 4) {
            ++length;
        }
        bytes memory text = new bytes(length + 2);
        text[0] = "0";
        text[1] = "x";
        for (uint256 i = length + 1; i > 1; --i) {
            text[i] = digits[value & 0xf];
            value >>= 4;
        }
        return string(text);
    }

    function test_ThisIsHyperEvmMainnet() public onlyLive {
        assertEq(block.chainid, HYPEREVM_MAINNET);
    }

    function test_ThePrecompilesDecodeForARealAccount() public onlyLive {
        (bool ok, bytes memory answer) = PERP_ASSET_INFO.staticcall(abi.encode(ZEC));
        assertTrue(ok, "perpAssetInfo");
        PerpAssetInfo memory info = abi.decode(answer, (PerpAssetInfo));
        console.log("perp %s: %s, szDecimals %s", uint256(ZEC), info.coin, uint256(info.szDecimals));
        assertEq(info.coin, "ZEC");
        assertEq(info.szDecimals, ZEC_SZ_DECIMALS);

        (ok, answer) = POSITION.staticcall(abi.encode(ACCOUNT, ZEC));
        assertTrue(ok, "position");
        assertEq(answer.length, 160, "position length");
        (int64 szi, uint64 entryNtl, int64 isolatedRawUsd, uint32 leverage, bool isIsolated) =
            abi.decode(answer, (int64, uint64, int64, uint32, bool));
        console.log("position raw:");
        console.logBytes(answer);
        console.log("szi");
        console.logInt(szi);
        console.log("entryNtl %s, leverage %s, isolated %s", uint256(entryNtl), uint256(leverage), isIsolated);
        console.log("isolatedRawUsd");
        console.logInt(isolatedRawUsd);
        assertEq(szi, EXPECTED_SZI, "the account's ZEC position");
        assertFalse(isIsolated);

        (ok, answer) = ORACLE_PX.staticcall(abi.encode(ZEC));
        assertTrue(ok, "oraclePx");
        assertEq(answer.length, 32, "oraclePx length");
        uint64 oraclePx = abi.decode(answer, (uint64));
        console.log("oraclePx %s = %s", uint256(oraclePx), _usd(oraclePx, info.szDecimals));
        _assertBelievable(oraclePx, "oracle price");

        (ok, answer) = MARK_PX.staticcall(abi.encode(ZEC));
        assertTrue(ok, "markPx");
        assertEq(answer.length, 32, "markPx length");
        uint64 markPx = abi.decode(answer, (uint64));
        console.log("markPx %s = %s", uint256(markPx), _usd(markPx, info.szDecimals));
        _assertBelievable(markPx, "mark price");
        assertApproxEqRel(markPx, oraclePx, 0.05e18, "mark and oracle are far apart");

        (ok, answer) = L1_BLOCK_NUMBER.staticcall("");
        assertTrue(ok, "l1BlockNumber");
        assertEq(answer.length, 32, "l1BlockNumber length");
        uint64 l1BlockNumber = abi.decode(answer, (uint64));
        console.log("l1BlockNumber %s", uint256(l1BlockNumber));
        assertGt(l1BlockNumber, 1_000_000_000);

        // Size times price is the notional in millionths of a dollar, without knowing szDecimals.
        uint256 notionalMicroUsd = uint256(uint64(-szi)) * oraclePx;
        console.log("short notional %s micro-dollars", notionalMicroUsd);
        assertGe(notionalMicroUsd, MIN_USD * 1e4);
        assertLe(notionalMicroUsd, MAX_USD * 1e4);
    }

    function test_AttestRecordsTheRealShort() public onlyLive {
        bytes32 root = keccak256("journal");
        bytes32 commitment = attestor.treasuryCommitmentOf(250_000_000, keccak256("salt"));

        vm.prank(ACCOUNT);
        attestor.setAttester(address(this));
        (uint256 series, uint256 number) = attestor.attest(ACCOUNT, ZEC, root, 3, commitment);

        HedgeAttestor.Snapshot memory snap = attestor.snapshot(ACCOUNT, series, number);
        console.log("series %s, snapshot %s: szi", series, number);
        console.logInt(snap.szi);
        console.log("oraclePx %s, markPx %s", uint256(snap.oraclePx), uint256(snap.markPx));
        console.log("l1BlockNumber %s, timestamp %s", uint256(snap.l1BlockNumber), uint256(snap.timestamp));

        assertEq(series, 0);
        assertEq(number, 0);
        assertEq(snap.perpIndex, ZEC);
        assertEq(snap.szi, EXPECTED_SZI);
        _assertBelievable(snap.oraclePx, "oracle price");
        _assertBelievable(snap.markPx, "mark price");
        assertGt(snap.l1BlockNumber, 1_000_000_000);
        assertEq(snap.timestamp, block.timestamp);
        assertEq(snap.journalRoot, root);
        assertEq(snap.journalCount, 3);
        assertEq(snap.treasuryCommitment, commitment);

        // The account closes the series; the short is read again into the next one.
        vm.prank(ACCOUNT);
        assertEq(attestor.startSeries(), 1);
        (series, number) = attestor.attest(ACCOUNT, ZEC, keccak256("shorter journal"), 1, commitment);
        assertEq(series, 1);
        assertEq(number, 0);
        assertEq(attestor.snapshot(ACCOUNT, 1, 0).szi, EXPECTED_SZI);
        assertEq(attestor.snapshot(ACCOUNT, 0, 0).journalCount, 3);
        assertEq(attestor.seriesEndedAt(ACCOUNT, 0), block.timestamp);
    }

    function test_AnUnknownPerpIsRefusedAndNothingIsStored() public onlyLive {
        vm.prank(ACCOUNT);
        attestor.setAttester(address(this));

        vm.expectRevert(abi.encodeWithSelector(HedgeAttestor.PrecompileReadFailed.selector, POSITION));
        attestor.attest(ACCOUNT, type(uint32).max, bytes32(0), 0, bytes32(0));

        assertEq(attestor.snapshotCount(ACCOUNT, 0), 0);
    }

    /// @dev Here the node itself runs the contract's bytecode against its own precompiles, with
    /// the gas of one small block for everything together: deployment, registration, two
    /// attestations, a new series and an attestation in it. The probe attests for itself, and it
    /// holds no position.
    function test_ANodeRunsTheWholeAttestationInOneSmallBlock() public onlyLive {
        bytes32 root = keccak256("journal");
        bytes32 commitment = keccak256("treasury");
        bytes memory creation = abi.encodePacked(
            type(AttestProbe).creationCode,
            abi.encode(type(HedgeAttestor).creationCode, ZEC, root, uint64(3), commitment)
        );
        bytes memory answer = vm.rpc(
            "eth_call",
            string.concat(
                '[{"from":"',
                vm.toString(ACCOUNT),
                '","data":"',
                vm.toString(creation),
                '","gas":"',
                _quantityHex(SMALL_BLOCK_GAS),
                '"},"latest"]'
            )
        );
        (HedgeAttestor.Snapshot memory snap, AttestProbe.Measured memory measured) =
            abi.decode(answer, (HedgeAttestor.Snapshot, AttestProbe.Measured));
        console.log("on the node: oraclePx %s, markPx %s", uint256(snap.oraclePx), uint256(snap.markPx));
        console.log("l1BlockNumber %s, timestamp %s", uint256(snap.l1BlockNumber), uint256(snap.timestamp));
        console.log("gas inside attest: first snapshot %s, a later one %s", measured.firstGas, measured.nextGas);
        console.log("gas inside startSeries %s", measured.startSeriesGas);

        assertEq(snap.perpIndex, ZEC);
        assertEq(snap.szi, 0);
        _assertBelievable(snap.oraclePx, "oracle price");
        _assertBelievable(snap.markPx, "mark price");
        assertGt(snap.l1BlockNumber, 1_000_000_000);
        assertApproxEqAbs(snap.timestamp, block.timestamp, 600);
        assertEq(snap.journalRoot, root);
        assertEq(snap.journalCount, 3);
        assertEq(snap.treasuryCommitment, commitment);
        assertLt(measured.firstGas, 300_000);
        assertLt(measured.nextGas, measured.firstGas);
        assertLt(measured.startSeriesGas, 100_000);
        assertEq(measured.series, 1);
        assertEq(measured.number, 0);
        assertEq(measured.endedAt, snap.timestamp);
    }

    function test_TheDeploymentFitsASmallBlock() public onlyLive {
        bytes memory answer = vm.rpc(
            "eth_estimateGas",
            string.concat(
                '[{"from":"', vm.toString(ACCOUNT), '","data":"', vm.toString(type(HedgeAttestor).creationCode), '"}]'
            )
        );
        uint256 gas = _quantity(answer);
        console.log("deployment gas estimated by the node %s", gas);
        assertLt(gas, SMALL_BLOCK_GAS);
    }
}
