// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {Script, console} from "forge-std/Script.sol";
import {HedgeAttestor} from "../src/HedgeAttestor.sol";

/// @notice Deploys HedgeAttestor to HyperEVM. The deployer's private key is read from
/// DEPLOYER_PRIVATE_KEY; the contract takes no constructor arguments and has no owner, so the
/// deployer keeps no power over it.
///
///   forge script script/Deploy.s.sol --rpc-url hyperevm --broadcast
///
/// Without --broadcast the script only simulates and sends nothing.
contract Deploy is Script {
    uint256 internal constant HYPEREVM_MAINNET = 999;
    uint256 internal constant HYPEREVM_TESTNET = 998;

    /// @notice The RPC endpoint is not a HyperEVM one; the contract is of no use elsewhere.
    error NotHyperEvm(uint256 chainId);

    function run() external returns (HedgeAttestor attestor) {
        if (block.chainid != HYPEREVM_MAINNET && block.chainid != HYPEREVM_TESTNET) revert NotHyperEvm(block.chainid);

        vm.startBroadcast(vm.envUint("DEPLOYER_PRIVATE_KEY"));
        attestor = new HedgeAttestor();
        vm.stopBroadcast();

        console.log("HedgeAttestor %s on chain %s", address(attestor), block.chainid);
    }
}
