// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

/// @notice Stands in for one HyperCore read precompile. It answers exactly the inputs it was given
/// an answer for. Any other input is refused the way HyperCore refuses an unknown perpetual: the
/// call fails and burns all the gas it was handed.
contract PrecompileStub {
    mapping(bytes32 inputHash => bytes) private _answers;
    mapping(bytes32 inputHash => bool) private _answered;

    function answer(bytes calldata input, bytes calldata output) external {
        bytes32 key = keccak256(input);
        _answers[key] = output;
        _answered[key] = true;
    }

    function refuse(bytes calldata input) external {
        delete _answered[keccak256(input)];
    }

    /// @dev Precompile inputs are ABI words or empty, so they never start with the selector of
    /// `answer` or `refuse` and always land here.
    fallback(bytes calldata input) external returns (bytes memory) {
        bytes32 key = keccak256(input);
        if (!_answered[key]) {
            assembly ("memory-safe") {
                invalid()
            }
        }
        return _answers[key];
    }
}
