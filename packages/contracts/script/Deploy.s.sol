// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {Campaign} from "../src/Campaign.sol";
import {CampaignFactory} from "../src/CampaignFactory.sol";
import {CarbonLedger} from "../src/CarbonLedger.sol";
import {TreeRegistry} from "../src/TreeRegistry.sol";
import {TreecordRoles} from "../src/TreecordRoles.sol";
import {VerificationGateway} from "../src/VerificationGateway.sol";
import {ITreeRegistry} from "../src/interfaces/ITreeRegistry.sol";
import {MockUSDC} from "../test/mocks/MockUSDC.sol";

/// @title Deploy
/// @notice Deploys and wires every Treecord contract, grants backend roles, and writes
///         deployments/<chainId>.json (only when broadcasting).
/// @dev Env:
///      - DEPLOYER_PRIVATE_KEY: deploys and holds DEFAULT_ADMIN_ROLE
///      - OPERATOR_PRIVATE_KEY: its address gets OPERATOR_ROLE and ISSUER_ROLE
///      - ATTESTER_PRIVATE_KEY: its address gets ATTESTER_ROLE
///      - TREASURY_ADDRESS
///      - USDC_ADDRESS: ignored on anvil (chain 31337), where a MockUSDC is deployed instead
///      - CARBON_METADATA_URI (optional)
contract Deploy is Script {
    uint256 internal constant ANVIL_CHAIN_ID = 31337;

    struct Deployment {
        address usdc;
        address roles;
        address treeRegistry;
        address campaignImplementation;
        address factory;
        address gateway;
        address carbonLedger;
    }

    function run() external returns (Deployment memory d) {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);
        address operator = vm.addr(vm.envUint("OPERATOR_PRIVATE_KEY"));
        address attester = vm.addr(vm.envUint("ATTESTER_PRIVATE_KEY"));
        address treasury = vm.envAddress("TREASURY_ADDRESS");
        string memory carbonUri =
            vm.envOr("CARBON_METADATA_URI", string("https://treecord.app/api/carbon/batches/{id}.json"));
        uint256 deployBlock = block.number;

        vm.startBroadcast(deployerKey);

        d.usdc = block.chainid == ANVIL_CHAIN_ID ? address(new MockUSDC()) : vm.envAddress("USDC_ADDRESS");

        TreecordRoles roles = new TreecordRoles(deployer, treasury);
        TreeRegistry registry = new TreeRegistry(roles);
        Campaign implementation = new Campaign(roles, IERC20(d.usdc), ITreeRegistry(address(registry)));
        CampaignFactory factory = new CampaignFactory(roles, address(implementation));
        VerificationGateway gateway = new VerificationGateway(roles);
        CarbonLedger ledger = new CarbonLedger(roles, IERC20(d.usdc), carbonUri);

        roles.setFactory(address(factory));
        roles.setTreeRegistry(address(registry));
        roles.setGateway(address(gateway));
        roles.setCarbonLedger(address(ledger));
        roles.grantRole(roles.OPERATOR_ROLE(), operator);
        roles.grantRole(roles.ISSUER_ROLE(), operator);
        roles.grantRole(roles.ATTESTER_ROLE(), attester);

        vm.stopBroadcast();

        d.roles = address(roles);
        d.treeRegistry = address(registry);
        d.campaignImplementation = address(implementation);
        d.factory = address(factory);
        d.gateway = address(gateway);
        d.carbonLedger = address(ledger);

        _log(d, deployer, operator, attester, treasury, deployBlock);
        _write(d, deployer, operator, attester, treasury, deployBlock);
    }

    function _write(
        Deployment memory d,
        address deployer,
        address operator,
        address attester,
        address treasury,
        uint256 deployBlock
    ) internal {
        if (!vm.isContext(VmSafe.ForgeContext.ScriptBroadcast)) {
            console2.log("Dry run: deployments file not written. Re-run with --broadcast.");
            return;
        }
        string memory key = "deployment";
        vm.serializeUint(key, "chainId", block.chainid);
        vm.serializeUint(key, "deployBlock", deployBlock);
        vm.serializeAddress(key, "deployer", deployer);
        vm.serializeAddress(key, "operator", operator);
        vm.serializeAddress(key, "attester", attester);
        vm.serializeAddress(key, "treasury", treasury);
        vm.serializeAddress(key, "usdc", d.usdc);
        vm.serializeAddress(key, "treecordRoles", d.roles);
        vm.serializeAddress(key, "treeRegistry", d.treeRegistry);
        vm.serializeAddress(key, "campaignImplementation", d.campaignImplementation);
        vm.serializeAddress(key, "campaignFactory", d.factory);
        vm.serializeAddress(key, "verificationGateway", d.gateway);
        string memory json = vm.serializeAddress(key, "carbonLedger", d.carbonLedger);

        string memory path = string.concat("deployments/", vm.toString(block.chainid), ".json");
        vm.writeJson(json, path);
        console2.log("Wrote", path);
    }

    function _log(
        Deployment memory d,
        address deployer,
        address operator,
        address attester,
        address treasury,
        uint256 deployBlock
    ) internal pure {
        console2.log("Deployer (admin)     ", deployer);
        console2.log("Operator + issuer    ", operator);
        console2.log("Attester             ", attester);
        console2.log("Treasury             ", treasury);
        console2.log("Deploy block         ", deployBlock);
        console2.log("USDC                 ", d.usdc);
        console2.log("TreecordRoles        ", d.roles);
        console2.log("TreeRegistry         ", d.treeRegistry);
        console2.log("Campaign impl        ", d.campaignImplementation);
        console2.log("CampaignFactory      ", d.factory);
        console2.log("VerificationGateway  ", d.gateway);
        console2.log("CarbonLedger         ", d.carbonLedger);
    }
}
