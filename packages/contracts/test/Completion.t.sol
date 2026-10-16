// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Campaign} from "../src/Campaign.sol";
import {ICampaign} from "../src/interfaces/ICampaign.sol";
import {
    CampaignStatus,
    CompletionNotReady,
    ReserveExceeded,
    TreeNotInCampaign,
    Unauthorized,
    WrongCampaignStatus,
    ZeroAmount
} from "../src/libraries/TreecordTypes.sol";
import {TestBase} from "./utils/TestBase.sol";

contract CompletionTest is TestBase {
    Campaign internal c;

    function setUp() public override {
        super.setUp();
        c = _activeCampaign();
        _claim(c, planter1, 3);
    }

    function test_revertWhen_completingWhileFunding() public {
        Campaign funding = _newCampaign();
        vm.expectRevert(
            abi.encodeWithSelector(WrongCampaignStatus.selector, CampaignStatus.Active, CampaignStatus.Funding)
        );
        funding.complete();
    }

    function test_noPlantingsCompletesOnlyAfterClaimDeadlinePlusCommitment() public {
        uint256 endsAt = c.config().claimDeadline + 37 * UNIT;
        vm.warp(endsAt - 1);
        vm.expectRevert(CompletionNotReady.selector);
        c.complete();

        vm.warp(endsAt);
        c.complete();
        assertEq(uint8(c.status()), uint8(CampaignStatus.Completed));
        assertEq(c.refundPool(), 800e6); // all incentives and the full reserve
    }

    function test_revertWhen_treesUnsettled() public {
        _plant(c, 3, planter1);
        vm.warp(_now() + 10 days);
        vm.expectRevert(CompletionNotReady.selector);
        c.complete();
    }

    function test_fullLifecycleRefundsLeftoversProRata() public {
        // Tree A: every milestone paid, then completed.
        uint256 treeA = _plant(c, 3, planter1);
        // Tree B: dies and is never replanted.
        uint256 treeB = _plant(c, 4, planter1);
        _reportDead(c, treeB, planter1);

        // Operator draws 5 USDC of reserve for a replanting attempt on tree B.
        vm.prank(operator);
        c.drawReserve(treeB, 5e6);

        vm.warp(_now() + 2 * UNIT + 1);
        registry.expireDead(treeB);

        _payAllMilestones(c, treeA, planter1);
        registry.markCompleted(treeA);
        assertEq(c.settledCount(), c.plantedCount());

        // Planting ended before the claim deadline, so the claim deadline is the completion floor.
        vm.warp(c.config().claimDeadline + 37 * UNIT);
        vm.expectEmit(address(c));
        // 700 incentives + 100 reserve - 87.5 tree A - 8.75 tree B milestone 0 - 5 drawn
        emit ICampaign.CampaignCompleted(698.75e6);
        c.complete();

        assertEq(c.refundPool(), usdc.balanceOf(address(c)));
        vm.prank(donorA);
        assertEq(c.claimRefund(), 419.25e6); // 60%
        vm.prank(donorB);
        assertEq(c.claimRefund(), 279.5e6); // 40%
        assertEq(usdc.balanceOf(address(c)), 0);
    }

    function test_latePlantingMovesCompletionFloor() public {
        // Claimed slots can still be planted after the claim deadline.
        vm.warp(c.config().claimDeadline + 100);
        uint256 treeId = _plant(c, 3, planter1);
        _payAllMilestones(c, treeId, planter1);
        registry.markCompleted(treeId);

        uint256 lastPlanted = c.lastPlantedAt();
        vm.warp(lastPlanted + 37 * UNIT - 1);
        vm.expectRevert(CompletionNotReady.selector);
        c.complete();
        vm.warp(lastPlanted + 37 * UNIT);
        c.complete();
    }

    function test_drawReserve() public {
        uint256 treeId = _plant(c, 3, planter1);
        uint256 before = usdc.balanceOf(treasury);

        vm.expectEmit(address(c));
        emit ICampaign.ReserveDrawn(treeId, treasury, 30e6);
        vm.prank(operator);
        c.drawReserve(treeId, 30e6);

        assertEq(usdc.balanceOf(treasury) - before, 30e6);
        assertEq(c.reserveDrawn(), 30e6);

        vm.startPrank(operator);
        vm.expectRevert(abi.encodeWithSelector(ReserveExceeded.selector, 71e6, 70e6));
        c.drawReserve(treeId, 71e6);
        vm.expectRevert(ZeroAmount.selector);
        c.drawReserve(treeId, 0);
        vm.expectRevert(abi.encodeWithSelector(TreeNotInCampaign.selector, 999));
        c.drawReserve(999, 1);
        vm.stopPrank();

        vm.prank(outsider);
        vm.expectRevert(abi.encodeWithSelector(Unauthorized.selector, outsider));
        c.drawReserve(treeId, 1);
    }
}
