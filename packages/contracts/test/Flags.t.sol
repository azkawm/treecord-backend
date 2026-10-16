// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Campaign} from "../src/Campaign.sol";
import {ITreeRegistry} from "../src/interfaces/ITreeRegistry.sol";
import {
    Attestation,
    AttestationKind,
    RemovalReason,
    TreeStatus,
    NotContributor,
    TreeFrozen,
    Unauthorized,
    WrongTreeStatus
} from "../src/libraries/TreecordTypes.sol";
import {TestBase} from "./utils/TestBase.sol";

contract FlagsTest is TestBase {
    Campaign internal c;
    uint256 internal treeId;
    uint256 internal plantedAt;
    bytes32 internal constant REASON = keccak256("video looks recycled");
    bytes32 internal constant NOTE = keccak256("reviewed by operator");

    function setUp() public override {
        super.setUp();
        c = _activeCampaign();
        _claim(c, planter1, 2);
        treeId = _plant(c, 3, planter1);
        plantedAt = _now();
    }

    function test_onlyContributorsCanFlag() public {
        vm.prank(outsider);
        vm.expectRevert(abi.encodeWithSelector(NotContributor.selector, outsider));
        registry.flag(treeId, REASON);
    }

    function test_flagAliveTree() public {
        vm.expectEmit(address(registry));
        emit ITreeRegistry.TreeFlagged(treeId, donorB, REASON);
        vm.prank(donorB);
        registry.flag(treeId, REASON);

        assertEq(uint8(registry.statusOf(treeId)), uint8(TreeStatus.Flagged));
        assertEq(uint8(registry.getTree(treeId).statusBeforeFlag), uint8(TreeStatus.Alive));
        assertEq(registry.flaggerOf(treeId), donorB);
        assertEq(registry.getTree(treeId).flaggedAt, _now());
    }

    function test_oneActiveFlagPerTree() public {
        vm.prank(donorA);
        registry.flag(treeId, REASON);
        vm.prank(donorB);
        vm.expectRevert(abi.encodeWithSelector(WrongTreeStatus.selector, treeId, TreeStatus.Flagged));
        registry.flag(treeId, REASON);
    }

    function test_payoutsPausedWhileFlagged() public {
        vm.prank(donorA);
        registry.flag(treeId, REASON);
        _warpToOpen(c, treeId, 1);
        Attestation memory att = _attestation(AttestationKind.Alive, address(c), 0, treeId, planter1, 1);
        _submitExpectRevert(att, abi.encodeWithSelector(WrongTreeStatus.selector, treeId, TreeStatus.Flagged));
    }

    function test_forfeitFrozenWhileFlagged() public {
        vm.prank(donorA);
        registry.flag(treeId, REASON);
        _warpPastClose(c, treeId, 1);
        vm.expectRevert(abi.encodeWithSelector(TreeFrozen.selector, treeId));
        c.forfeitMilestone(treeId, 1);
    }

    function test_upholdRemovesTree() public {
        vm.prank(donorA);
        registry.flag(treeId, REASON);

        vm.expectEmit(address(registry));
        emit ITreeRegistry.FlagResolved(treeId, true, NOTE, 0);
        vm.expectEmit(address(registry));
        emit ITreeRegistry.TreeRemoved(treeId, RemovalReason.FlagUpheld);
        vm.prank(operator);
        registry.resolveFlag(treeId, true, NOTE);

        assertEq(uint8(registry.statusOf(treeId)), uint8(TreeStatus.Removed));
        assertEq(c.forfeitedPool(), PER_TREE - M0);
        assertEq(c.settledCount(), 1);
    }

    function test_dismissRestoresAliveAndShiftsSchedule() public {
        vm.prank(donorA);
        registry.flag(treeId, REASON);
        vm.warp(plantedAt + 500);

        vm.expectEmit(address(registry));
        emit ITreeRegistry.FlagResolved(treeId, false, NOTE, 500);
        vm.prank(operator);
        registry.resolveFlag(treeId, false, NOTE);

        assertEq(uint8(registry.statusOf(treeId)), uint8(TreeStatus.Alive));
        assertEq(registry.getTree(treeId).pausedDuration, 500);
        assertEq(registry.getTree(treeId).flaggedAt, 0);

        // Milestone 1 normally opens at 3 units (180s). It now opens at 680s and can be paid.
        (uint256 opensAt,) = c.milestoneWindow(treeId, 1);
        assertEq(opensAt, plantedAt + 3 * UNIT + 500);
        vm.warp(opensAt);
        _checkIn(c, treeId, planter1, 1);
        assertEq(usdc.balanceOf(planter1), 2 * M0);
    }

    function test_dismissNeverReopensAClosedWindow() public {
        _warpPastClose(c, treeId, 1); // milestone 1 closed unpaid, not yet forfeited
        vm.prank(donorA);
        registry.flag(treeId, REASON);
        vm.warp(_now() + 100);
        vm.prank(operator);
        registry.resolveFlag(treeId, false, NOTE);

        (, uint256 closesAt) = c.milestoneWindow(treeId, 1);
        assertLt(closesAt, _now());
        c.forfeitMilestone(treeId, 1);
    }

    function test_flagDeadTreeFreezesExpiryAndDismissExtendsDeadline() public {
        _reportDead(c, treeId, planter1);
        uint256 deadline = _now() + 2 * UNIT;

        vm.prank(donorA);
        registry.flag(treeId, REASON);
        vm.warp(deadline + 50);
        vm.expectRevert(abi.encodeWithSelector(WrongTreeStatus.selector, treeId, TreeStatus.Flagged));
        registry.expireDead(treeId);

        uint256 flaggedFor = deadline + 50 - plantedAt;
        vm.prank(operator);
        registry.resolveFlag(treeId, false, NOTE);
        assertEq(uint8(registry.statusOf(treeId)), uint8(TreeStatus.Dead));
        assertEq(registry.getTree(treeId).replantDeadline, deadline + flaggedFor);

        // Still inside the extended deadline, so the planter can replant.
        _reportReplanted(c, treeId, planter1);
        assertEq(uint8(registry.statusOf(treeId)), uint8(TreeStatus.Alive));
    }

    function test_revertWhen_flaggingRemovedTree() public {
        vm.prank(donorA);
        registry.flag(treeId, REASON);
        vm.prank(operator);
        registry.resolveFlag(treeId, true, NOTE);
        vm.prank(donorB);
        vm.expectRevert(abi.encodeWithSelector(WrongTreeStatus.selector, treeId, TreeStatus.Removed));
        registry.flag(treeId, REASON);
    }

    function test_revertWhen_resolveByOutsiderOrWithoutFlag() public {
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(WrongTreeStatus.selector, treeId, TreeStatus.Alive));
        registry.resolveFlag(treeId, false, NOTE);

        vm.prank(donorA);
        registry.flag(treeId, REASON);
        vm.prank(outsider);
        vm.expectRevert(abi.encodeWithSelector(Unauthorized.selector, outsider));
        registry.resolveFlag(treeId, false, NOTE);
    }
}
