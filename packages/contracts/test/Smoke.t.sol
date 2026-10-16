// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {Campaign} from "../src/Campaign.sol";
import {CampaignFactory} from "../src/CampaignFactory.sol";
import {TreeRegistry} from "../src/TreeRegistry.sol";
import {TreecordRoles} from "../src/TreecordRoles.sol";
import {ITreeRegistry} from "../src/interfaces/ITreeRegistry.sol";
import {TreecordConstants as C} from "../src/libraries/TreecordConstants.sol";
import {
    CampaignConfig,
    CampaignStatus,
    TreeStatus,
    PlanterCapExceeded,
    TreeFrozen
} from "../src/libraries/TreecordTypes.sol";

contract SmokeUSDC is ERC20 {
    constructor() ERC20("Test USDC", "USDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @notice End-to-end smoke test of the prompt 2 contracts. The full suite arrives in prompt 4.
/// @dev This test contract acts as the VerificationGateway and as the operator.
contract SmokeTest is Test {
    uint64 internal constant UNIT = 60;

    SmokeUSDC internal usdc;
    TreecordRoles internal roles;
    TreeRegistry internal registry;
    CampaignFactory internal factory;
    Campaign internal campaign;

    address internal treasury = makeAddr("treasury");
    address internal donorA = makeAddr("donorA");
    address internal donorB = makeAddr("donorB");
    address internal planter1 = makeAddr("planter1");
    address internal planter2 = makeAddr("planter2");

    function setUp() public {
        usdc = new SmokeUSDC();
        roles = new TreecordRoles(address(this), treasury);
        registry = new TreeRegistry(roles);
        Campaign impl = new Campaign(roles, IERC20(address(usdc)), ITreeRegistry(address(registry)));
        factory = new CampaignFactory(roles, address(impl));

        roles.setFactory(address(factory));
        roles.setTreeRegistry(address(registry));
        roles.setGateway(address(this));
        roles.grantRole(roles.OPERATOR_ROLE(), address(this));

        CampaignConfig memory cfg = CampaignConfig({
            creator: donorA,
            metadataURI: "ipfs://demo",
            speciesCode: bytes32("SWIETENIA_MACROPHYLLA"),
            regionGeohash: bytes8("qqguwvt"),
            regionRadiusM: 5000,
            treeTarget: 4,
            anchorBps: C.DEFAULT_ANCHOR_BPS,
            perPlanterCap: 2,
            fundingTarget: 1000e6,
            fundingDeadline: uint64(block.timestamp + 1 days),
            claimDeadline: uint64(block.timestamp + 2 days),
            commitmentUnits: 36,
            timeUnit: UNIT,
            split: C.defaultSplit()
        });
        vm.prank(donorA);
        campaign = Campaign(factory.createCampaign(cfg));

        usdc.mint(donorA, 600e6);
        usdc.mint(donorB, 600e6);
    }

    function test_fullLifecycle() public {
        // Funding: donorB overpays and only the remainder is pulled. Activation sends 20% to treasury.
        _contribute(donorA, 600e6);
        _contribute(donorB, 600e6);
        assertEq(uint8(campaign.status()), uint8(CampaignStatus.Active));
        assertEq(campaign.contributions(donorB), 400e6);
        assertEq(usdc.balanceOf(donorB), 200e6);
        assertEq(usdc.balanceOf(treasury), 200e6);
        assertEq(usdc.balanceOf(address(campaign)), 800e6);
        assertEq(campaign.perTreeIncentive(), 175e6);
        assertEq(campaign.anchorSlots(), 1);
        assertEq(campaign.openSlots(), 3);

        // Open claims are capped per planter and start after the anchor range.
        campaign.claimSlotsFor(planter1, 2);
        assertEq(campaign.slotOwner(2), planter1);
        assertEq(campaign.slotOwner(3), planter1);
        vm.expectRevert(abi.encodeWithSelector(PlanterCapExceeded.selector, 1, 0));
        campaign.claimSlotsFor(planter1, 1);

        // Plant slot 2 and pay milestone 0.
        uint256 t0 = vm.getBlockTimestamp();
        uint256 treeId = registry.registerTree(address(campaign), 2, planter1, bytes8("qqguwvt"), keccak256("e0"));
        campaign.releaseMilestone(treeId, 0, planter1);
        assertEq(usdc.balanceOf(planter1), 17.5e6);

        // Milestone 1 is due at 3 units.
        vm.warp(t0 + 3 * UNIT);
        registry.recordCheckIn(treeId, keccak256("e1"));
        campaign.releaseMilestone(treeId, 1, planter1);
        assertEq(usdc.balanceOf(planter1), 35e6);

        // Milestone 2 window [6u, 7u] is missed and forfeited.
        vm.warp(t0 + 7 * UNIT + 1);
        campaign.forfeitMilestone(treeId, 2);
        assertEq(campaign.forfeitedPool(), 17.5e6);

        // A flag freezes the clock, and dismissal shifts later windows by the flagged duration.
        vm.prank(donorA);
        registry.flag(treeId, keccak256("looks fake"));
        vm.expectRevert(abi.encodeWithSelector(TreeFrozen.selector, treeId));
        campaign.forfeitMilestone(treeId, 3);
        vm.warp(vm.getBlockTimestamp() + 100);
        registry.resolveFlag(treeId, false, keccak256("checked"));
        (uint256 opensAt,) = campaign.milestoneWindow(treeId, 3);
        assertEq(opensAt, t0 + 12 * UNIT + 100);

        // Death without replanting removes the tree and forfeits everything unpaid.
        registry.markDead(treeId, keccak256("dead"));
        vm.warp(vm.getBlockTimestamp() + 2 * UNIT + 1);
        registry.expireDead(treeId);
        assertEq(uint8(registry.statusOf(treeId)), uint8(TreeStatus.Removed));
        assertEq(campaign.forfeitedPool(), 175e6 - 35e6);
        assertEq(campaign.settledCount(), campaign.plantedCount());

        // After the claim deadline, unclaimed open slots roll into the anchor portion.
        vm.warp(t0 + 2 days);
        assertEq(campaign.availableAnchorSlots(), 2);
        campaign.assignAnchorSlots(planter2, 2);
        assertEq(campaign.slotOwner(1), planter2);
        assertEq(campaign.slotOwner(4), planter2);

        // Completion: everything not paid out is refundable pro rata.
        vm.warp(t0 + 2 days + 37 * UNIT);
        campaign.complete();
        assertEq(campaign.refundPool(), 765e6);
        assertEq(usdc.balanceOf(address(campaign)), 765e6);

        vm.prank(donorA);
        assertEq(campaign.claimRefund(), 459e6);
        vm.prank(donorB);
        assertEq(campaign.claimRefund(), 306e6);
        assertEq(usdc.balanceOf(address(campaign)), 0);
    }

    function _contribute(address donor, uint256 amount) internal {
        vm.startPrank(donor);
        usdc.approve(address(campaign), amount);
        campaign.contribute(amount);
        vm.stopPrank();
    }
}
