// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Campaign} from "../src/Campaign.sol";
import {ICampaign} from "../src/interfaces/ICampaign.sol";
import {
    CampaignStatus,
    ClaimWindowClosed,
    NotEnoughSlots,
    PlanterCapExceeded,
    Unauthorized,
    WrongCampaignStatus,
    ZeroAddress,
    ZeroAmount
} from "../src/libraries/TreecordTypes.sol";
import {TestBase} from "./utils/TestBase.sol";

/// @dev Default campaign: 8 slots, ids 1-2 anchor, ids 3-8 open, per-planter cap 3.
contract SlotsTest is TestBase {
    Campaign internal c;

    function setUp() public override {
        super.setUp();
        c = _activeCampaign();
    }

    function test_openClaimsAreSequentialAfterAnchorRange() public {
        vm.expectEmit(address(c));
        emit ICampaign.SlotsClaimed(planter1, 3, 2);
        _claim(c, planter1, 2);
        _claim(c, planter2, 3);

        assertEq(c.slotOwner(3), planter1);
        assertEq(c.slotOwner(4), planter1);
        assertEq(c.slotOwner(5), planter2);
        assertEq(c.slotOwner(7), planter2);
        assertEq(c.slotOwner(8), address(0));
        assertEq(c.openAssigned(), 5);
        assertEq(c.openClaimsOf(planter1), 2);
        assertEq(c.availableOpenSlots(), 1);
        assertTrue(c.isAnchorSlot(2));
        assertFalse(c.isAnchorSlot(3));
        assertFalse(c.isAnchorSlot(0));
    }

    function test_revertWhen_capExceeded() public {
        _claim(c, planter1, 2);
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(PlanterCapExceeded.selector, 2, 1));
        c.claimSlotsFor(planter1, 2);
    }

    function test_revertWhen_notEnoughOpenSlots() public {
        _claim(c, planter1, 3);
        _claim(c, planter2, 3);
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(NotEnoughSlots.selector, 1, 0));
        c.claimSlotsFor(outsider, 1);
    }

    function test_revertWhen_claimAfterDeadline() public {
        vm.warp(c.config().claimDeadline);
        assertEq(c.availableOpenSlots(), 0);
        vm.prank(operator);
        vm.expectRevert(ClaimWindowClosed.selector);
        c.claimSlotsFor(planter1, 1);
    }

    function test_revertWhen_claimInputsInvalid() public {
        vm.startPrank(operator);
        vm.expectRevert(ZeroAddress.selector);
        c.claimSlotsFor(address(0), 1);
        vm.expectRevert(ZeroAmount.selector);
        c.claimSlotsFor(planter1, 0);
        vm.expectRevert(ZeroAddress.selector);
        c.assignAnchorSlots(address(0), 1);
        vm.expectRevert(ZeroAmount.selector);
        c.assignAnchorSlots(planter1, 0);
        vm.stopPrank();
    }

    function test_revertWhen_notOperator() public {
        vm.startPrank(outsider);
        vm.expectRevert(abi.encodeWithSelector(Unauthorized.selector, outsider));
        c.claimSlotsFor(planter1, 1);
        vm.expectRevert(abi.encodeWithSelector(Unauthorized.selector, outsider));
        c.assignAnchorSlots(planter1, 1);
        vm.stopPrank();
    }

    function test_revertWhen_campaignNotActive() public {
        Campaign funding = _newCampaign();
        vm.startPrank(operator);
        vm.expectRevert(
            abi.encodeWithSelector(WrongCampaignStatus.selector, CampaignStatus.Active, CampaignStatus.Funding)
        );
        funding.claimSlotsFor(planter1, 1);
        vm.expectRevert(
            abi.encodeWithSelector(WrongCampaignStatus.selector, CampaignStatus.Active, CampaignStatus.Funding)
        );
        funding.assignAnchorSlots(planter1, 1);
        vm.stopPrank();
    }

    function test_anchorAssignmentIgnoresCap() public {
        vm.expectEmit(address(c));
        emit ICampaign.AnchorSlotsAssigned(planter1, 1, 2);
        vm.prank(operator);
        c.assignAnchorSlots(planter1, 2);

        assertEq(c.slotOwner(1), planter1);
        assertEq(c.slotOwner(2), planter1);
        assertEq(c.anchorAssigned(), 2);
        assertEq(c.openClaimsOf(planter1), 0);
        _claim(c, planter1, 3); // the full open cap is still available
        assertEq(c.availableAnchorSlots(), 0);
    }

    function test_revertWhen_anchorExhaustedBeforeDeadline() public {
        vm.startPrank(operator);
        c.assignAnchorSlots(planter1, 2);
        vm.expectRevert(abi.encodeWithSelector(NotEnoughSlots.selector, 1, 0));
        c.assignAnchorSlots(planter1, 1);
        vm.stopPrank();
    }

    function test_unclaimedOpenSlotsRollOverAfterDeadline() public {
        _claim(c, planter1, 3); // slots 3-5
        vm.prank(operator);
        c.assignAnchorSlots(planter2, 1); // slot 1

        vm.warp(c.config().claimDeadline);
        // 1 anchor left plus 3 unclaimed open slots
        assertEq(c.availableAnchorSlots(), 4);

        vm.expectEmit(address(c));
        emit ICampaign.AnchorSlotsAssigned(outsider, 2, 1);
        vm.expectEmit(address(c));
        emit ICampaign.AnchorSlotsAssigned(outsider, 6, 3);
        vm.prank(operator);
        c.assignAnchorSlots(outsider, 4);

        assertEq(c.slotOwner(2), outsider);
        assertEq(c.slotOwner(6), outsider);
        assertEq(c.slotOwner(8), outsider);
        assertEq(c.availableAnchorSlots(), 0);
    }

    function test_rolloverOnlyFromOpenRangeWhenAnchorExhausted() public {
        vm.prank(operator);
        c.assignAnchorSlots(planter1, 2);
        vm.warp(c.config().claimDeadline);

        vm.expectEmit(address(c));
        emit ICampaign.AnchorSlotsAssigned(planter2, 3, 2);
        vm.prank(operator);
        c.assignAnchorSlots(planter2, 2);
        assertEq(c.slotOwner(3), planter2);
        assertEq(c.slotOwner(4), planter2);
    }

    function test_noSlotIsAssignedTwice() public {
        _claim(c, planter1, 3);
        _claim(c, planter2, 3);
        vm.startPrank(operator);
        c.assignAnchorSlots(outsider, 2);
        vm.warp(c.config().claimDeadline);
        vm.expectRevert(abi.encodeWithSelector(NotEnoughSlots.selector, 1, 0));
        c.assignAnchorSlots(outsider, 1);
        vm.stopPrank();

        address[3] memory owners = [outsider, planter1, planter2];
        uint256[3] memory counts;
        for (uint256 slotId = 1; slotId <= TREES; ++slotId) {
            address owner = c.slotOwner(slotId);
            for (uint256 i = 0; i < 3; ++i) {
                if (owner == owners[i]) counts[i] += 1;
            }
        }
        assertEq(counts[0] + counts[1] + counts[2], TREES);
        assertEq(counts[0], 2);
    }
}
