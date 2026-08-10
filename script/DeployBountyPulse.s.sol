// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {BountyPulse} from "../src/BountyPulse.sol";

contract DeployBountyPulse is Script {
    function run() external returns (BountyPulse bountyPulse) {
        uint256 deployerPrivateKey = vm.envUint("ANVIL_DEPLOYER_PRIVATE_KEY");

        vm.startBroadcast(deployerPrivateKey);
        bountyPulse = new BountyPulse();
        vm.stopBroadcast();

        console2.log("BountyPulse deployed at:", address(bountyPulse));
        console2.log("Arbiter:", bountyPulse.arbiter());
    }
}
