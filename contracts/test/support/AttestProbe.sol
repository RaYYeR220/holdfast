// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {HedgeAttestor} from "../../src/HedgeAttestor.sol";

/// @notice Runs the contract's whole life inside one `eth_call` on a HyperEVM node. The constructor
/// deploys a HedgeAttestor, names itself as its own attester, attests for itself twice, starts a
/// new series and attests once more. In place of its code it hands back the first stored snapshot
/// and what it measured on the way. Nothing reaches the chain: the node runs the call against its
/// current state and discards it.
///
/// @dev The HedgeAttestor creation code comes in as an argument. Written as `new HedgeAttestor()`
/// in a test file, forge would compile the deployment into a cheatcode call, which no node knows.
contract AttestProbe {
    /// @param firstGas Gas inside the first attestation of an account.
    /// @param nextGas Gas inside a later attestation in the same series.
    /// @param startSeriesGas Gas inside `startSeries`.
    /// @param series Series the attestation after `startSeries` went into.
    /// @param number Its number in that series.
    /// @param endedAt When the node says the first series was closed.
    struct Measured {
        uint256 firstGas;
        uint256 nextGas;
        uint256 startSeriesGas;
        uint256 series;
        uint256 number;
        uint64 endedAt;
    }

    error DeploymentFailed();

    constructor(
        bytes memory attestorCreationCode,
        uint32 perpIndex,
        bytes32 journalRoot,
        uint64 journalCount,
        bytes32 treasuryCommitment
    ) {
        address deployed;
        assembly ("memory-safe") {
            deployed := create(0, add(attestorCreationCode, 0x20), mload(attestorCreationCode))
        }
        if (deployed == address(0)) revert DeploymentFailed();
        HedgeAttestor attestor = HedgeAttestor(deployed);
        attestor.setAttester(address(this));
        Measured memory measured;

        uint256 gasBefore = gasleft();
        attestor.attest(address(this), perpIndex, journalRoot, journalCount, treasuryCommitment);
        measured.firstGas = gasBefore - gasleft();

        gasBefore = gasleft();
        attestor.attest(address(this), perpIndex, journalRoot, journalCount, treasuryCommitment);
        measured.nextGas = gasBefore - gasleft();

        gasBefore = gasleft();
        attestor.startSeries();
        measured.startSeriesGas = gasBefore - gasleft();

        (measured.series, measured.number) =
            attestor.attest(address(this), perpIndex, journalRoot, journalCount, treasuryCommitment);
        measured.endedAt = attestor.seriesEndedAt(address(this), 0);

        bytes memory result = abi.encode(attestor.snapshot(address(this), 0, 0), measured);
        assembly ("memory-safe") {
            return(add(result, 0x20), mload(result))
        }
    }
}
