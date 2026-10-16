// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Campaign} from "../src/Campaign.sol";
import {TreeRegistry} from "../src/TreeRegistry.sol";
import {TreecordRoles} from "../src/TreecordRoles.sol";
import {ITreeRegistry} from "../src/interfaces/ITreeRegistry.sol";
import {
    Attestation,
    AttestationKind,
    RemovalReason,
    TreeStatus,
    InvalidSlot,
    MilestonesNotSettled,
    ReplantDeadlineNotPassed,
    ReplantDeadlinePassed,
    Unauthorized,
    UnknownCampaign,
    UnknownTree,
    WrongTreeStatus,
    ZeroAddress
} from "../src/libraries/TreecordTypes.sol";
import {TestBase} from "./utils/TestBase.sol";

contract TreeHealthTest is TestBase {
    Campaign internal c;
    uint256 internal treeId;
    uint256 internal plantedAt;

    function setUp() public override {
        super.setUp();
        c = _activeCampaign();
        _claim(c, planter1, 3);
        treeId = _plant(c, 3, planter1);
        plantedAt = _now();
    }

    function test_deadSetsReplantDeadline() public {
        vm.warp(plantedAt + 10);
        Attestation memory att = _attestation(AttestationKind.Dead, address(c), 0, treeId, planter1, 0);
        vm.expectEmit(address(registry));
        emit ITreeRegistry.TreeDied(treeId, att.evidenceHash, uint64(plantedAt + 10 + 2 * UNIT));
        _submit(att);

        assertEq(uint8(registry.statusOf(treeId)), uint8(TreeStatus.Dead));
        assertEq(registry.getTree(treeId).replantDeadline, plantedAt + 10 + 2 * UNIT);
    }

    function test_operatorCanMarkDead() public {
        vm.prank(operator);
        registry.markDead(treeId, keccak256("operator decision"));
        assertEq(uint8(registry.statusOf(treeId)), uint8(TreeStatus.Dead));
    }

    function test_revertWhen_outsiderMarksDead() public {
        vm.prank(outsider);
        vm.expectRevert(abi.encodeWithSelector(Unauthorized.selector, outsider));
        registry.markDead(treeId, bytes32(0));
    }

    function test_replantWithinDeadlineKeepsOriginalSchedule() public {
        _reportDead(c, treeId, planter1);
        vm.warp(_now() + 2 * UNIT); // exactly at the deadline
        _reportReplanted(c, treeId, planter1);

        assertEq(uint8(registry.statusOf(treeId)), uint8(TreeStatus.Alive));
        assertEq(registry.getTree(treeId).replantDeadline, 0);
        (uint256 opensAt,) = c.milestoneWindow(treeId, 1);
        assertEq(opensAt, plantedAt + 3 * UNIT);
    }

    function test_revertWhen_replantAfterDeadline() public {
        _reportDead(c, treeId, planter1);
        uint256 deadline = _now() + 2 * UNIT;
        vm.warp(deadline + 1);
        Attestation memory att = _attestation(AttestationKind.Replanted, address(c), 0, treeId, planter1, 0);
        _submitExpectRevert(att, abi.encodeWithSelector(ReplantDeadlinePassed.selector, treeId, deadline));
    }

    function test_revertWhen_replantingAliveTree() public {
        Attestation memory att = _attestation(AttestationKind.Replanted, address(c), 0, treeId, planter1, 0);
        _submitExpectRevert(att, abi.encodeWithSelector(WrongTreeStatus.selector, treeId, TreeStatus.Alive));
    }

    function test_deadTreeIsNotPaid() public {
        _reportDead(c, treeId, planter1);
        _warpToOpen(c, treeId, 1);
        Attestation memory att = _attestation(AttestationKind.Alive, address(c), 0, treeId, planter1, 1);
        _submitExpectRevert(att, abi.encodeWithSelector(WrongTreeStatus.selector, treeId, TreeStatus.Dead));
    }

    function test_milestonesCanBeForfeitedWhileDead() public {
        _reportDead(c, treeId, planter1);
        _warpPastClose(c, treeId, 1);
        c.forfeitMilestone(treeId, 1);
        assertEq(c.forfeitedPool(), M0);
    }

    function test_expireAfterDeadlineForfeitsUnpaid() public {
        _reportDead(c, treeId, planter1);
        uint256 deadline = _now() + 2 * UNIT;

        vm.expectRevert(abi.encodeWithSelector(ReplantDeadlineNotPassed.selector, treeId, deadline));
        registry.expireDead(treeId);

        vm.warp(deadline + 1);
        vm.expectEmit(address(registry));
        emit ITreeRegistry.TreeRemoved(treeId, RemovalReason.ReplantExpired);
        vm.prank(outsider);
        registry.expireDead(treeId);

        assertEq(uint8(registry.statusOf(treeId)), uint8(TreeStatus.Removed));
        assertEq(c.forfeitedPool(), PER_TREE - M0);
        assertTrue(c.allMilestonesSettled(treeId));
        assertEq(c.settledCount(), 1);
    }

    function test_revertWhen_expiringAliveTree() public {
        vm.expectRevert(abi.encodeWithSelector(WrongTreeStatus.selector, treeId, TreeStatus.Alive));
        registry.expireDead(treeId);
    }

    function test_markCompletedOnceAllSettled() public {
        vm.expectRevert(abi.encodeWithSelector(MilestonesNotSettled.selector, treeId));
        registry.markCompleted(treeId);

        _payAllMilestones(c, treeId, planter1);
        vm.expectEmit(address(registry));
        emit ITreeRegistry.TreeCompleted(treeId);
        registry.markCompleted(treeId);

        assertEq(uint8(registry.statusOf(treeId)), uint8(TreeStatus.Completed));
        assertEq(c.settledCount(), 1);
    }

    function test_markCompletedWithSomeForfeits() public {
        for (uint8 m = 1; m < 6; ++m) {
            _warpPastClose(c, treeId, m);
            c.forfeitMilestone(treeId, m);
        }
        registry.markCompleted(treeId);
        assertEq(uint8(registry.statusOf(treeId)), uint8(TreeStatus.Completed));
        assertEq(c.forfeitedPool(), PER_TREE - M0);
    }

    function test_revertWhen_unknownTree() public {
        vm.expectRevert(abi.encodeWithSelector(UnknownTree.selector, 999));
        registry.expireDead(999);
        vm.expectRevert(abi.encodeWithSelector(UnknownTree.selector, 999));
        registry.markCompleted(999);
        assertEq(uint8(registry.statusOf(999)), uint8(TreeStatus.None));
    }

    function test_revertWhen_gatewayOnlyFunctionsCalledByOthers() public {
        vm.startPrank(outsider);
        vm.expectRevert(abi.encodeWithSelector(Unauthorized.selector, outsider));
        registry.registerTree(address(c), 4, planter1, bytes8(0), bytes32(0));
        vm.expectRevert(abi.encodeWithSelector(Unauthorized.selector, outsider));
        registry.recordCheckIn(treeId, bytes32(0));
        vm.expectRevert(abi.encodeWithSelector(Unauthorized.selector, outsider));
        registry.markReplanted(treeId, bytes32(0));
        vm.stopPrank();
    }

    function test_registerTreeInputValidation() public {
        vm.startPrank(address(gateway));
        vm.expectRevert(abi.encodeWithSelector(UnknownCampaign.selector, outsider));
        registry.registerTree(outsider, 4, planter1, bytes8(0), bytes32(0));
        vm.expectRevert(ZeroAddress.selector);
        registry.registerTree(address(c), 4, address(0), bytes8(0), bytes32(0));
        vm.expectRevert(abi.encodeWithSelector(InvalidSlot.selector, 0));
        registry.registerTree(address(c), 0, planter1, bytes8(0), bytes32(0));
        uint256 tooBig = uint256(type(uint32).max) + 1;
        vm.expectRevert(abi.encodeWithSelector(InvalidSlot.selector, tooBig));
        registry.registerTree(address(c), tooBig, planter1, bytes8(0), bytes32(0));
        vm.expectRevert(abi.encodeWithSelector(InvalidSlot.selector, 99));
        registry.registerTree(address(c), 99, planter1, bytes8(0), bytes32(0));
        vm.stopPrank();
    }

    function test_constructorRejectsZeroRoles() public {
        vm.expectRevert(ZeroAddress.selector);
        new TreeRegistry(TreecordRoles(address(0)));
    }
}
