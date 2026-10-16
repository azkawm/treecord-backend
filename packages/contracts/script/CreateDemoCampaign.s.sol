// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";

import {CampaignFactory} from "../src/CampaignFactory.sol";
import {TreecordConstants as C} from "../src/libraries/TreecordConstants.sol";
import {CampaignConfig} from "../src/libraries/TreecordTypes.sol";

/// @title CreateDemoCampaign
/// @notice Creates one demo campaign with a short time unit so the 36-month lifecycle plays out live.
///         Reads deployments/<chainId>.json and writes deployments/<chainId>-demo.json when broadcasting.
/// @dev Broadcasts with OPERATOR_PRIVATE_KEY, which may create campaigns on a donor's behalf.
///      Env (all optional except the key):
///      - DEMO_TIME_UNIT_SECONDS (default 180)
///      - DEMO_CREATOR (default: the operator address)
///      - DEMO_TREE_TARGET (default 10)
///      - DEMO_FUNDING_TARGET in USDC base units (default 20 USDC, faucet friendly)
///      - DEMO_METADATA_URI
///      Deadlines are relative to the time unit: funding closes after 20 units, claims after 40.
contract CreateDemoCampaign is Script {
    uint64 internal constant FUNDING_UNITS = 20;
    uint64 internal constant CLAIM_UNITS = 40;

    function run() external returns (address campaign) {
        uint256 operatorKey = vm.envUint("OPERATOR_PRIVATE_KEY");
        address operator = vm.addr(operatorKey);
        uint64 timeUnit = uint64(vm.envOr("DEMO_TIME_UNIT_SECONDS", uint256(180)));

        string memory deploymentPath = string.concat("deployments/", vm.toString(block.chainid), ".json");
        CampaignFactory factory = CampaignFactory(vm.parseJsonAddress(vm.readFile(deploymentPath), ".campaignFactory"));

        CampaignConfig memory cfg = CampaignConfig({
            creator: vm.envOr("DEMO_CREATOR", operator),
            metadataURI: vm.envOr("DEMO_METADATA_URI", string("treecord://demo/mahogany-jakarta")),
            speciesCode: bytes32("SWIETENIA_MACROPHYLLA"),
            regionGeohash: bytes8("qqguwvt"),
            regionRadiusM: 5000,
            treeTarget: uint32(vm.envOr("DEMO_TREE_TARGET", uint256(10))),
            anchorBps: C.DEFAULT_ANCHOR_BPS,
            perPlanterCap: C.DEFAULT_PER_PLANTER_CAP,
            fundingTarget: vm.envOr("DEMO_FUNDING_TARGET", uint256(20e6)),
            fundingDeadline: uint64(block.timestamp) + FUNDING_UNITS * timeUnit,
            claimDeadline: uint64(block.timestamp) + CLAIM_UNITS * timeUnit,
            commitmentUnits: C.MIN_COMMITMENT_UNITS,
            timeUnit: timeUnit,
            split: C.defaultSplit()
        });

        vm.startBroadcast(operatorKey);
        campaign = factory.createCampaign(cfg);
        vm.stopBroadcast();

        console2.log("Demo campaign   ", campaign);
        console2.log("Creator         ", cfg.creator);
        console2.log("Time unit (s)   ", timeUnit);
        console2.log("Trees           ", cfg.treeTarget);
        console2.log("Funding target  ", cfg.fundingTarget);

        if (vm.isContext(VmSafe.ForgeContext.ScriptBroadcast)) {
            string memory json = vm.serializeAddress("demo", "campaign", campaign);
            string memory path = string.concat("deployments/", vm.toString(block.chainid), "-demo.json");
            vm.writeJson(json, path);
            console2.log("Wrote", path);
        }
    }
}
