// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Campaign} from "../src/Campaign.sol";
import {ICampaign} from "../src/interfaces/ICampaign.sol";
import {
    CampaignConfig,
    CampaignStatus,
    FundingClosed,
    FundingStillOpen,
    NothingToRefund,
    RefundsNotAvailable,
    WrongCampaignStatus,
    ZeroAmount
} from "../src/libraries/TreecordTypes.sol";
import {TestBase} from "./utils/TestBase.sol";

contract FundingTest is TestBase {
    Campaign internal c;

    function setUp() public override {
        super.setUp();
        c = _newCampaign();
    }

    function test_partialContributionStaysFunding() public {
        _prepare(donorA, 300e6);
        vm.expectEmit(address(c));
        emit ICampaign.Contributed(donorA, 300e6, 300e6);
        vm.prank(donorA);
        c.contribute(300e6);

        assertEq(uint8(c.status()), uint8(CampaignStatus.Funding));
        assertEq(c.totalRaised(), 300e6);
        assertEq(c.contributions(donorA), 300e6);
        assertEq(c.contributorCount(), 1);
        assertEq(c.contributorAt(0), donorA);
        assertEq(usdc.balanceOf(address(c)), 300e6);
        assertEq(usdc.balanceOf(treasury), 0);
    }

    function test_repeatContributionsTrackOneContributor() public {
        _fund(c, donorA, 100e6);
        _fund(c, donorA, 200e6);
        assertEq(c.contributions(donorA), 300e6);
        assertEq(c.contributorCount(), 1);
        assertEq(c.contributors().length, 1);
    }

    function test_exactFundingActivatesAndPaysTreasury() public {
        _fund(c, donorA, 600e6);

        _prepare(donorB, 400e6);
        vm.expectEmit(address(c));
        emit ICampaign.Activated(_now(), 700e6, PER_TREE, 100e6);
        vm.expectEmit(address(c));
        emit ICampaign.BucketsReleased(treasury, 100e6, 50e6, 50e6);
        vm.prank(donorB);
        c.contribute(400e6);

        assertEq(uint8(c.status()), uint8(CampaignStatus.Active));
        assertEq(c.activatedAt(), _now());
        assertEq(c.incentivePool(), 700e6);
        assertEq(c.reserveAmount(), 100e6);
        assertEq(c.perTreeIncentive(), PER_TREE);
        assertEq(c.incentiveDust(), 0);
        assertEq(usdc.balanceOf(treasury), 200e6);
        assertEq(usdc.balanceOf(address(c)), 800e6);
    }

    function test_overfundingPullsOnlyTheRemainder() public {
        _fund(c, donorA, 900e6);
        uint256 accepted = _fund(c, donorB, 500e6);

        assertEq(accepted, 100e6);
        assertEq(c.contributions(donorB), 100e6);
        assertEq(usdc.balanceOf(donorB), 400e6);
        assertEq(c.totalRaised(), TARGET);
        assertEq(uint8(c.status()), uint8(CampaignStatus.Active));
    }

    function test_revertWhen_contributingZero() public {
        vm.prank(donorA);
        vm.expectRevert(ZeroAmount.selector);
        c.contribute(0);
    }

    function test_revertWhen_contributingAfterDeadline() public {
        vm.warp(c.config().fundingDeadline);
        usdc.mint(donorA, 1e6);
        vm.startPrank(donorA);
        usdc.approve(address(c), 1e6);
        vm.expectRevert(FundingClosed.selector);
        c.contribute(1e6);
        vm.stopPrank();
    }

    function test_revertWhen_contributingWhileActive() public {
        _fund(c, donorA, TARGET);
        vm.prank(donorB);
        vm.expectRevert(
            abi.encodeWithSelector(WrongCampaignStatus.selector, CampaignStatus.Funding, CampaignStatus.Active)
        );
        c.contribute(1);
    }

    function test_refundPathAfterMissedDeadline() public {
        _fund(c, donorA, 300e6);
        _fund(c, donorB, 200e6);

        vm.expectRevert(FundingStillOpen.selector);
        c.markRefunding();

        vm.warp(c.config().fundingDeadline);
        vm.expectEmit(address(c));
        emit ICampaign.RefundingStarted();
        c.markRefunding();
        assertEq(uint8(c.status()), uint8(CampaignStatus.Refunding));

        vm.prank(donorA);
        assertEq(c.claimRefund(), 300e6);
        vm.prank(donorB);
        assertEq(c.claimRefund(), 200e6);
        assertEq(usdc.balanceOf(donorA), 300e6);
        assertEq(usdc.balanceOf(address(c)), 0);
        assertTrue(c.refundClaimed(donorA));
    }

    function test_revertWhen_refundClaimedTwice() public {
        _fund(c, donorA, 300e6);
        vm.warp(c.config().fundingDeadline);
        c.markRefunding();
        vm.startPrank(donorA);
        c.claimRefund();
        vm.expectRevert(NothingToRefund.selector);
        c.claimRefund();
        vm.stopPrank();
    }

    function test_revertWhen_nonContributorClaimsRefund() public {
        _fund(c, donorA, 300e6);
        vm.warp(c.config().fundingDeadline);
        c.markRefunding();
        vm.prank(outsider);
        vm.expectRevert(NothingToRefund.selector);
        c.claimRefund();
    }

    function test_revertWhen_refundWhileFundingOrActive() public {
        _fund(c, donorA, 300e6);
        vm.prank(donorA);
        vm.expectRevert(abi.encodeWithSelector(RefundsNotAvailable.selector, CampaignStatus.Funding));
        c.claimRefund();

        _fund(c, donorB, 700e6);
        vm.prank(donorA);
        vm.expectRevert(abi.encodeWithSelector(RefundsNotAvailable.selector, CampaignStatus.Active));
        c.claimRefund();
    }

    function test_revertWhen_markRefundingAfterActivation() public {
        _fund(c, donorA, TARGET);
        vm.warp(c.config().fundingDeadline);
        vm.expectRevert(
            abi.encodeWithSelector(WrongCampaignStatus.selector, CampaignStatus.Funding, CampaignStatus.Active)
        );
        c.markRefunding();
    }

    function test_activationDustGoesToReserveAndIncentiveDust() public {
        // 7 trees and an odd target leave remainders in both buckets and per-tree division.
        Campaign odd = _createOdd();
        _fund(odd, donorA, 1_000_003);

        uint256 incentives = odd.incentivePool();
        uint256 treasuryIn = usdc.balanceOf(treasury);
        assertEq(incentives + odd.reserveAmount() + treasuryIn, 1_000_003);
        assertEq(odd.perTreeIncentive() * 7 + odd.incentiveDust(), incentives);
        assertGt(odd.incentiveDust(), 0);
    }

    function _prepare(address donor, uint256 amount) internal {
        usdc.mint(donor, amount);
        vm.prank(donor);
        usdc.approve(address(c), amount);
    }

    function _createOdd() internal returns (Campaign) {
        CampaignConfig memory cfg = _defaultConfig();
        cfg.treeTarget = 7;
        cfg.fundingTarget = 1_000_003;
        return _createCampaign(cfg);
    }
}
