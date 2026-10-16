// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Campaign} from "../src/Campaign.sol";
import {TreecordConstants as C} from "../src/libraries/TreecordConstants.sol";
import {BudgetSplit, CampaignConfig} from "../src/libraries/TreecordTypes.sol";
import {TestBase} from "./utils/TestBase.sol";

contract FuzzTest is TestBase {
    /// @notice Activation never creates or loses USDC, for any split, target, tree count and anchor share.
    function testFuzz_activationConservesUsdc(
        uint256 target,
        uint32 trees,
        uint16 anchorBps,
        uint16 cutA,
        uint16 cutB,
        uint16 cutC,
        uint16 cutD
    ) public {
        trees = uint32(bound(trees, 1, 10_000));
        target = bound(target, 1, 1e15);
        anchorBps = uint16(bound(anchorBps, 0, C.BPS));
        BudgetSplit memory split = _splitFromCuts(cutA, cutB, cutC, cutD);
        vm.assume((target * split.incentivesBps) / C.BPS / trees > 0);

        CampaignConfig memory cfg = _defaultConfig();
        cfg.treeTarget = trees;
        cfg.fundingTarget = target;
        cfg.anchorBps = anchorBps;
        cfg.split = split;
        Campaign camp = _createCampaign(cfg);
        _fund(camp, donorA, target);

        uint256 held = usdc.balanceOf(address(camp));
        assertEq(held + usdc.balanceOf(treasury), target, "USDC created or lost");
        assertEq(held, camp.incentivePool() + camp.reserveAmount(), "campaign holds incentives + reserve");
        assertEq(camp.perTreeIncentive() * trees + camp.incentiveDust(), camp.incentivePool(), "per-tree split exact");
        assertEq(uint256(camp.anchorSlots()) + camp.openSlots(), trees, "every slot is anchor or open");

        uint256 sum;
        for (uint8 m = 0; m < C.MILESTONE_COUNT; ++m) {
            sum += camp.milestoneAmount(m);
        }
        assertEq(sum, camp.perTreeIncentive(), "milestones sum to per-tree incentive");
    }

    /// @notice Pro-rata completion refunds never exceed the refund pool and lose less than 1 unit per contributor.
    function testFuzz_completionRefundsNeverExceedPool(uint256[5] memory amounts, uint8 count) public {
        uint256 n = bound(count, 1, 5);
        uint256 target;
        for (uint256 i = 0; i < n; ++i) {
            amounts[i] = bound(amounts[i], 1e6, 1e12);
            target += amounts[i];
        }

        CampaignConfig memory cfg = _defaultConfig();
        cfg.fundingTarget = target;
        Campaign camp = _createCampaign(cfg);
        for (uint256 i = 0; i < n; ++i) {
            _fund(camp, _contributor(i), amounts[i]);
        }

        vm.warp(cfg.claimDeadline + 37 * UNIT);
        camp.complete();
        uint256 pool = camp.refundPool();

        uint256 refunded;
        for (uint256 i = 0; i < n; ++i) {
            vm.prank(_contributor(i));
            refunded += camp.claimRefund();
        }
        assertLe(refunded, pool, "refunds exceed pool");
        assertLt(pool - refunded, n, "more than 1 unit lost per contributor");
        assertEq(usdc.balanceOf(address(camp)), pool - refunded);
    }

    /// @notice Reservations never exceed the estimate, allocations never exceed reservations, and every batch is
    ///         fully accounted for between holders and inventory.
    function testFuzz_reservationAndIssuanceRounding(
        uint256[4] memory amounts,
        uint256 estimate,
        uint256 batch1,
        uint256 batch2,
        bool firstDeclines
    ) public {
        uint256 target;
        for (uint256 i = 0; i < 4; ++i) {
            amounts[i] = bound(amounts[i], 1e6, 1e12);
            target += amounts[i];
        }
        estimate = bound(estimate, 0, 1e12);
        batch1 = bound(batch1, 1, 1e12);
        batch2 = bound(batch2, 1, 1e12);

        CampaignConfig memory cfg = _defaultConfig();
        cfg.fundingTarget = target;
        Campaign camp = _createCampaign(cfg);
        for (uint256 i = 0; i < 4; ++i) {
            _fund(camp, _contributor(i), amounts[i]);
        }

        vm.prank(operator);
        ledger.setEstimate(address(camp), estimate);
        uint256 reservedSum;
        for (uint256 i = 0; i < 4; ++i) {
            reservedSum += ledger.reservationOf(address(camp), _contributor(i));
        }
        assertLe(reservedSum, estimate, "reservations exceed estimate");

        if (firstDeclines && ledger.reservationOf(address(camp), _contributor(0)) > 0) {
            vm.prank(_contributor(0));
            ledger.declineReservation(address(camp));
        }

        uint256 id1 = _issueFor(camp, batch1);
        uint256 id2 = _issueFor(camp, batch2);
        _assertBatchAccounted(camp, id1, batch1);
        _assertBatchAccounted(camp, id2, batch2);

        uint256 outstanding;
        for (uint256 i = 0; i < 4; ++i) {
            address holder = _contributor(i);
            uint256 reserved = ledger.reservationOf(address(camp), holder);
            uint256 allocated = ledger.allocatedOf(address(camp), holder);
            assertLe(allocated, reserved, "allocation exceeds reservation");
            assertEq(ledger.balanceOf(holder, id1) + ledger.balanceOf(holder, id2), allocated);
            outstanding += reserved - allocated;
        }
        (,, uint256 trackedOutstanding,,) = ledger.campaignCarbon(address(camp));
        assertEq(trackedOutstanding, outstanding, "outstanding drift");
    }

    function _assertBatchAccounted(Campaign camp, uint256 batchId, uint256 amount) internal view {
        uint256 total = ledger.inventoryOf(batchId);
        for (uint256 i = 0; i < 4; ++i) {
            total += ledger.balanceOf(_contributor(i), batchId);
        }
        assertEq(total, amount, "batch not fully allocated");
        assertEq(ledger.getBatch(batchId).campaign, address(camp));
    }

    function _issueFor(Campaign camp, uint256 amount) internal returns (uint256) {
        vm.prank(operator);
        return ledger.issueBatch(address(camp), "SRN PPI", "A", "B", 2027, amount);
    }

    function _contributor(uint256 i) internal pure returns (address) {
        return address(uint160(0xC0FFEE00 + i));
    }

    /// @dev Turns four cut points in [0, BPS] into five buckets that always sum to BPS.
    function _splitFromCuts(uint16 a, uint16 b, uint16 c, uint16 d) internal pure returns (BudgetSplit memory) {
        uint256[4] memory cuts = [bound(a, 0, C.BPS), bound(b, 0, C.BPS), bound(c, 0, C.BPS), bound(d, 0, C.BPS)];
        for (uint256 i = 0; i < 4; ++i) {
            for (uint256 j = i + 1; j < 4; ++j) {
                if (cuts[j] < cuts[i]) (cuts[i], cuts[j]) = (cuts[j], cuts[i]);
            }
        }
        return BudgetSplit({
            incentivesBps: uint16(C.BPS - cuts[3]),
            seedlingsBps: uint16(cuts[1] - cuts[0]),
            verificationBps: uint16(cuts[2] - cuts[1]),
            reserveBps: uint16(cuts[3] - cuts[2]),
            feeBps: uint16(cuts[0])
        });
    }
}
