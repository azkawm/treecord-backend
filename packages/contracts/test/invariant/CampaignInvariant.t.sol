// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

import {Campaign} from "../../src/Campaign.sol";
import {TreeRegistry} from "../../src/TreeRegistry.sol";
import {VerificationGateway} from "../../src/VerificationGateway.sol";
import {Attestation, AttestationKind, CampaignStatus} from "../../src/libraries/TreecordTypes.sol";
import {MockUSDC} from "../mocks/MockUSDC.sol";
import {TestBase} from "../utils/TestBase.sol";

/// @notice Drives one Active campaign through random plantings, check-ins, forfeits, deaths, replantings,
///         expiries, flags, resolutions, completions, reserve draws and time jumps. Every action that may revert is
///         wrapped in try/catch, so the fuzzer explores freely without failing on expected reverts.
contract CampaignHandler is Test {
    uint64 internal constant UNIT = 60;

    Campaign internal immutable c;
    TreeRegistry internal immutable registry;
    VerificationGateway internal immutable gateway;
    MockUSDC internal immutable usdc;
    uint256 internal immutable attesterKey;
    address internal immutable operator;
    address internal immutable donor;
    uint32 internal immutable treeTarget;

    uint256[] public trees;
    uint256 internal nonce = 1_000_000;

    constructor(
        Campaign c_,
        TreeRegistry registry_,
        VerificationGateway gateway_,
        MockUSDC usdc_,
        uint256 attesterKey_,
        address operator_,
        address donor_
    ) {
        c = c_;
        registry = registry_;
        gateway = gateway_;
        usdc = usdc_;
        attesterKey = attesterKey_;
        operator = operator_;
        donor = donor_;
        treeTarget = c_.config().treeTarget;
    }

    function treeCount() external view returns (uint256) {
        return trees.length;
    }

    function plant(uint256 slotSeed) external {
        uint256 slotId = bound(slotSeed, 1, treeTarget);
        if (c.slotTree(slotId) != 0) return;
        address planter = c.slotOwner(slotId);
        if (planter == address(0)) return;
        Attestation memory att = _att(AttestationKind.Planted, slotId, 0, planter, 0);
        try gateway.submit(att, _sign(att)) returns (uint256 treeId) {
            trees.push(treeId);
        } catch {}
    }

    function checkIn(uint256 treeSeed, uint256 milestoneSeed, bool jumpToWindow) external {
        if (trees.length == 0) return;
        uint256 treeId = _pick(treeSeed);
        uint8 milestone = uint8(bound(milestoneSeed, 1, 5));
        if (jumpToWindow) {
            (uint256 opensAt,) = c.milestoneWindow(treeId, milestone);
            if (opensAt > vm.getBlockTimestamp()) vm.warp(opensAt);
        }
        address planter = registry.getTree(treeId).planter;
        Attestation memory att = _att(AttestationKind.Alive, 0, treeId, planter, milestone);
        try gateway.submit(att, _sign(att)) {} catch {}
    }

    function forfeit(uint256 treeSeed, uint256 milestoneSeed) external {
        if (trees.length == 0) return;
        try c.forfeitMilestone(_pick(treeSeed), uint8(bound(milestoneSeed, 0, 5))) {} catch {}
    }

    function reportDead(uint256 treeSeed) external {
        if (trees.length == 0) return;
        uint256 treeId = _pick(treeSeed);
        Attestation memory att = _att(AttestationKind.Dead, 0, treeId, registry.getTree(treeId).planter, 0);
        try gateway.submit(att, _sign(att)) {} catch {}
    }

    function reportReplanted(uint256 treeSeed) external {
        if (trees.length == 0) return;
        uint256 treeId = _pick(treeSeed);
        Attestation memory att = _att(AttestationKind.Replanted, 0, treeId, registry.getTree(treeId).planter, 0);
        try gateway.submit(att, _sign(att)) {} catch {}
    }

    function expireDead(uint256 treeSeed) external {
        if (trees.length == 0) return;
        try registry.expireDead(_pick(treeSeed)) {} catch {}
    }

    function flag(uint256 treeSeed) external {
        if (trees.length == 0) return;
        uint256 treeId = _pick(treeSeed);
        vm.prank(donor);
        try registry.flag(treeId, keccak256("fuzz")) {} catch {}
    }

    function resolveFlag(uint256 treeSeed, bool uphold) external {
        if (trees.length == 0) return;
        uint256 treeId = _pick(treeSeed);
        vm.prank(operator);
        try registry.resolveFlag(treeId, uphold, keccak256("fuzz")) {} catch {}
    }

    function markCompleted(uint256 treeSeed) external {
        if (trees.length == 0) return;
        try registry.markCompleted(_pick(treeSeed)) {} catch {}
    }

    function drawReserve(uint256 treeSeed, uint256 amount) external {
        if (trees.length == 0) return;
        uint256 treeId = _pick(treeSeed);
        uint256 available = c.reserveAmount() - c.reserveDrawn();
        if (available == 0) return;
        amount = bound(amount, 1, available);
        vm.prank(operator);
        try c.drawReserve(treeId, amount) {} catch {}
    }

    function complete() external {
        try c.complete() {} catch {}
    }

    function refund(bool donorA) external {
        if (c.status() != CampaignStatus.Completed) return;
        vm.prank(donorA ? donor : address(0xB0B));
        try c.claimRefund() {} catch {}
    }

    function warp(uint256 secondsForward) external {
        vm.warp(vm.getBlockTimestamp() + bound(secondsForward, 0, 20 * UNIT));
    }

    function _pick(uint256 seed) internal view returns (uint256) {
        return trees[bound(seed, 0, trees.length - 1)];
    }

    function _att(AttestationKind kind, uint256 slotId, uint256 treeId, address planter, uint8 milestone)
        internal
        returns (Attestation memory)
    {
        ++nonce;
        return Attestation({
            kind: uint8(kind),
            campaign: address(c),
            slotId: slotId,
            treeId: treeId,
            planter: planter,
            milestone: milestone,
            evidenceHash: keccak256(abi.encode(nonce)),
            geohash: bytes8("qqguwvt"),
            score: 9_000,
            nonce: nonce,
            expiry: uint64(vm.getBlockTimestamp() + 1 hours)
        });
    }

    function _sign(Attestation memory att) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(attesterKey, gateway.hashAttestation(att));
        return abi.encodePacked(r, s, v);
    }
}

/// @notice The campaign always holds enough USDC for what it owes, and its accounting identity always holds.
contract CampaignInvariantTest is TestBase {
    Campaign internal c;
    CampaignHandler internal handler;

    function setUp() public override {
        super.setUp();
        c = _newCampaign();
        _fund(c, donorA, 600e6);
        _fund(c, address(0xB0B), 400e6);

        // Assign every slot: 2 anchor to planter1, 3 open each to planter1 and planter2.
        vm.startPrank(operator);
        c.assignAnchorSlots(planter1, 2);
        c.claimSlotsFor(planter1, 3);
        c.claimSlotsFor(planter2, 3);
        vm.stopPrank();

        handler = new CampaignHandler(c, registry, gateway, usdc, attesterKey, operator, donorA);
        targetContract(address(handler));
    }

    /// @notice USDC balance >= unpaid committed incentives + unused reserve + forfeited pool (prompt 4 invariant).
    function invariant_balanceCoversObligations() public view {
        if (c.status() != CampaignStatus.Active) return;
        uint256 obligations = c.unpaidCommittedIncentives() + (c.reserveAmount() - c.reserveDrawn()) + c.forfeitedPool();
        assertGe(usdc.balanceOf(address(c)), obligations);
    }

    /// @notice While Active, the balance equals exactly what was funded minus what left the contract.
    function invariant_accountingIdentity() public view {
        if (c.status() != CampaignStatus.Active) return;
        assertEq(usdc.balanceOf(address(c)), c.incentivePool() + c.reserveAmount() - c.totalPaid() - c.reserveDrawn());
    }

    /// @notice After completion, the balance is exactly the refund pool minus refunds already pulled.
    function invariant_refundsBoundedAfterCompletion() public view {
        if (c.status() != CampaignStatus.Completed) return;
        uint256 refunded = _refunded();
        assertLe(refunded, c.refundPool());
        assertEq(usdc.balanceOf(address(c)), c.refundPool() - refunded);
    }

    /// @notice Paid plus forfeited incentives never exceed what planted trees committed.
    function invariant_settledNeverExceedsCommitted() public view {
        assertLe(c.totalPaid() + c.forfeitedPool(), uint256(c.plantedCount()) * c.perTreeIncentive());
        assertLe(c.settledCount(), c.plantedCount());
        assertEq(c.plantedCount(), handler.treeCount());
    }

    function _refunded() internal view returns (uint256 total) {
        if (c.refundClaimed(donorA)) total += (c.refundPool() * c.contributions(donorA)) / c.totalRaised();
        if (c.refundClaimed(address(0xB0B))) {
            total += (c.refundPool() * c.contributions(address(0xB0B))) / c.totalRaised();
        }
    }
}
