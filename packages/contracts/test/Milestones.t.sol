// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Campaign} from "../src/Campaign.sol";
import {ICampaign} from "../src/interfaces/ICampaign.sol";
import {TreecordConstants as C} from "../src/libraries/TreecordConstants.sol";
import {
    Attestation,
    AttestationKind,
    InvalidMilestone,
    MilestoneAlreadySettled,
    MilestoneNotOpen,
    MilestoneWindowNotClosed,
    TreeNotInCampaign,
    Unauthorized
} from "../src/libraries/TreecordTypes.sol";
import {TestBase} from "./utils/TestBase.sol";

contract MilestonesTest is TestBase {
    Campaign internal c;
    uint256 internal treeId;
    uint256 internal plantedAt;

    function setUp() public override {
        super.setUp();
        c = _activeCampaign();
        _claim(c, planter1, 2);
        treeId = _plant(c, 3, planter1);
        plantedAt = _now();
    }

    function test_amountsFollowScheduleAndSumToPerTree() public view {
        assertEq(c.milestoneAmount(0), M0);
        assertEq(c.milestoneAmount(1), M0);
        assertEq(c.milestoneAmount(2), M0);
        assertEq(c.milestoneAmount(3), M3);
        assertEq(c.milestoneAmount(4), M3);
        assertEq(c.milestoneAmount(5), M5);

        uint256 sum;
        for (uint8 m = 0; m < C.MILESTONE_COUNT; ++m) {
            sum += c.milestoneAmount(m);
        }
        assertEq(sum, PER_TREE);
    }

    function test_windowsFollowSchedule() public view {
        uint64[6] memory due = [uint64(0), 3, 6, 12, 24, 36];
        for (uint8 m = 0; m < C.MILESTONE_COUNT; ++m) {
            (uint256 opensAt, uint256 closesAt) = c.milestoneWindow(treeId, m);
            assertEq(opensAt, plantedAt + due[m] * UNIT);
            assertEq(closesAt, opensAt + UNIT);
        }
    }

    function test_revertWhen_invalidMilestoneIndex() public {
        vm.expectRevert(abi.encodeWithSelector(InvalidMilestone.selector, 6));
        c.milestoneAmount(6);
        vm.expectRevert(abi.encodeWithSelector(InvalidMilestone.selector, 6));
        c.isMilestonePaid(treeId, 6);
        vm.expectRevert(abi.encodeWithSelector(InvalidMilestone.selector, 6));
        c.forfeitMilestone(treeId, 6);
        vm.expectRevert(abi.encodeWithSelector(InvalidMilestone.selector, 6));
        c.milestoneWindow(treeId, 6);
    }

    function test_earlyCheckInRejected() public {
        vm.warp(plantedAt + 3 * UNIT - 1);
        Attestation memory att = _attestation(AttestationKind.Alive, address(c), 0, treeId, planter1, 1);
        _submitExpectRevert(
            att,
            abi.encodeWithSelector(MilestoneNotOpen.selector, treeId, 1, plantedAt + 3 * UNIT, plantedAt + 4 * UNIT)
        );
    }

    function test_inWindowPaidAtBothEdges() public {
        vm.warp(plantedAt + 3 * UNIT);
        vm.expectEmit(address(c));
        emit ICampaign.MilestonePaid(treeId, 1, planter1, M0);
        _checkIn(c, treeId, planter1, 1);

        vm.warp(plantedAt + 7 * UNIT); // last second of milestone 2
        _checkIn(c, treeId, planter1, 2);

        assertEq(usdc.balanceOf(planter1), 3 * M0);
        assertEq(c.totalPaid(), 3 * M0);
        assertEq(c.paidMask(treeId), 0x07);
    }

    function test_lateCheckInRejected() public {
        vm.warp(plantedAt + 4 * UNIT + 1);
        Attestation memory att = _attestation(AttestationKind.Alive, address(c), 0, treeId, planter1, 1);
        _submitExpectRevert(
            att,
            abi.encodeWithSelector(MilestoneNotOpen.selector, treeId, 1, plantedAt + 3 * UNIT, plantedAt + 4 * UNIT)
        );
    }

    function test_forfeitAfterWindow() public {
        vm.warp(plantedAt + 4 * UNIT + 1);
        vm.expectEmit(address(c));
        emit ICampaign.MilestoneForfeited(treeId, 1, M0);
        vm.prank(outsider);
        c.forfeitMilestone(treeId, 1);

        assertEq(c.forfeitedPool(), M0);
        assertEq(c.forfeitedMask(treeId), 0x02);
        assertFalse(c.isMilestonePaid(treeId, 1));
    }

    function test_revertWhen_forfeitBeforeWindowCloses() public {
        vm.warp(plantedAt + 4 * UNIT);
        vm.expectRevert(abi.encodeWithSelector(MilestoneWindowNotClosed.selector, treeId, 1, plantedAt + 4 * UNIT));
        c.forfeitMilestone(treeId, 1);
    }

    function test_doublePayRejected() public {
        _warpToOpen(c, treeId, 1);
        _checkIn(c, treeId, planter1, 1);
        Attestation memory att = _attestation(AttestationKind.Alive, address(c), 0, treeId, planter1, 1);
        _submitExpectRevert(att, abi.encodeWithSelector(MilestoneAlreadySettled.selector, treeId, 1));
    }

    function test_revertWhen_forfeitingPaidOrForfeitedMilestone() public {
        _warpToOpen(c, treeId, 1);
        _checkIn(c, treeId, planter1, 1);
        _warpPastClose(c, treeId, 2);
        vm.expectRevert(abi.encodeWithSelector(MilestoneAlreadySettled.selector, treeId, 1));
        c.forfeitMilestone(treeId, 1);
        c.forfeitMilestone(treeId, 2);
        vm.expectRevert(abi.encodeWithSelector(MilestoneAlreadySettled.selector, treeId, 2));
        c.forfeitMilestone(treeId, 2);
    }

    function test_payAfterForfeitRejected() public {
        _warpPastClose(c, treeId, 1);
        c.forfeitMilestone(treeId, 1);
        Attestation memory att = _attestation(AttestationKind.Alive, address(c), 0, treeId, planter1, 1);
        _submitExpectRevert(att, abi.encodeWithSelector(MilestoneAlreadySettled.selector, treeId, 1));
    }

    function test_allMilestonesPaidOnTime() public {
        _payAllMilestones(c, treeId, planter1);
        assertEq(usdc.balanceOf(planter1), PER_TREE);
        assertTrue(c.allMilestonesSettled(treeId));
        assertEq(c.unpaidCommittedIncentives(), 0);
    }

    function test_revertWhen_hooksCalledByOutsiders() public {
        vm.startPrank(outsider);
        vm.expectRevert(abi.encodeWithSelector(Unauthorized.selector, outsider));
        c.releaseMilestone(treeId, 1, planter1);
        vm.expectRevert(abi.encodeWithSelector(Unauthorized.selector, outsider));
        c.onTreePlanted(4, 99, planter1);
        vm.expectRevert(abi.encodeWithSelector(Unauthorized.selector, outsider));
        c.onTreeRemoved(treeId);
        vm.expectRevert(abi.encodeWithSelector(Unauthorized.selector, outsider));
        c.onTreeCompleted(treeId);
        vm.stopPrank();
    }

    function test_revertWhen_treeFromAnotherCampaign() public {
        Campaign other = _activeCampaign();
        vm.expectRevert(abi.encodeWithSelector(TreeNotInCampaign.selector, treeId));
        other.forfeitMilestone(treeId, 1);
        vm.expectRevert(abi.encodeWithSelector(TreeNotInCampaign.selector, treeId));
        other.milestoneWindow(treeId, 1);
    }
}
