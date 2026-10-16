// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC1155Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";

import {Campaign} from "../src/Campaign.sol";
import {CarbonLedger} from "../src/CarbonLedger.sol";
import {ICarbonLedger} from "../src/interfaces/ICarbonLedger.sol";
import {
    CampaignStatus,
    CarbonBatch,
    Retirement,
    EmptyBeneficiary,
    EstimateLocked,
    InsufficientInventory,
    NoReservation,
    NonTransferable,
    PriceNotSet,
    Unauthorized,
    UnknownBatch,
    UnknownCampaign,
    WrongCampaignStatus,
    ZeroAddress,
    ZeroAmount
} from "../src/libraries/TreecordTypes.sol";
import {TestBase} from "./utils/TestBase.sol";

/// @dev Default campaign: donorA contributed 60%, donorB 40%. Carbon amounts use 3 decimals (1000 = 1 t).
contract CarbonLedgerTest is TestBase {
    Campaign internal c;
    address internal buyer = makeAddr("buyer");

    function setUp() public override {
        super.setUp();
        c = _activeCampaign();
    }

    // -----------------------------------------------------------------------
    // Estimates and reservations
    // -----------------------------------------------------------------------

    function test_estimateReservesProRata() public {
        vm.expectEmit(address(ledger));
        emit ICarbonLedger.Reserved(address(c), donorA, 60_000);
        vm.expectEmit(address(ledger));
        emit ICarbonLedger.Reserved(address(c), donorB, 40_000);
        vm.expectEmit(address(ledger));
        emit ICarbonLedger.EstimateSet(address(c), 100_000);
        _estimate(100_000);

        assertEq(ledger.reservationOf(address(c), donorA), 60_000);
        assertEq(ledger.remainingReservation(address(c), donorB), 40_000);
        (uint256 estimated, uint256 reservedTotal, uint256 outstanding,, bool started) =
            ledger.campaignCarbon(address(c));
        assertEq(estimated, 100_000);
        assertEq(reservedTotal, 100_000);
        assertEq(outstanding, 100_000);
        assertFalse(started);
    }

    function test_estimateCanBeReplacedBeforeIssuanceThenLocks() public {
        _estimate(100_000);
        _estimate(50_000);
        assertEq(ledger.reservationOf(address(c), donorA), 30_000);

        _issue(10_000);
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(EstimateLocked.selector, address(c)));
        ledger.setEstimate(address(c), 1);
    }

    function test_estimateSkipsDeclinedHolders() public {
        _estimate(100_000);
        vm.prank(donorB);
        ledger.declineReservation(address(c));
        _estimate(200_000);
        assertEq(ledger.reservationOf(address(c), donorA), 120_000);
        assertEq(ledger.reservationOf(address(c), donorB), 0);
        (, uint256 reservedTotal,,,) = ledger.campaignCarbon(address(c));
        assertEq(reservedTotal, 120_000);
    }

    function test_revertWhen_estimateInvalid() public {
        vm.prank(outsider);
        vm.expectRevert(abi.encodeWithSelector(Unauthorized.selector, outsider));
        ledger.setEstimate(address(c), 1);

        Campaign funding = _newCampaign();
        vm.startPrank(operator);
        vm.expectRevert(abi.encodeWithSelector(UnknownCampaign.selector, outsider));
        ledger.setEstimate(outsider, 1);

        vm.expectRevert(
            abi.encodeWithSelector(WrongCampaignStatus.selector, CampaignStatus.Active, CampaignStatus.Funding)
        );
        ledger.setEstimate(address(funding), 1);
        vm.stopPrank();
    }

    function test_declineMovesUnfilledToInventory() public {
        _estimate(100_000);
        vm.expectEmit(address(ledger));
        emit ICarbonLedger.ReservationDeclined(address(c), donorB, 40_000);
        vm.prank(donorB);
        ledger.declineReservation(address(c));

        assertTrue(ledger.declined(address(c), donorB));
        (, uint256 reservedTotal, uint256 outstanding,,) = ledger.campaignCarbon(address(c));
        assertEq(reservedTotal, 60_000);
        assertEq(outstanding, 60_000);

        uint256 batchId = _issue(100_000);
        assertEq(ledger.balanceOf(donorA, batchId), 60_000);
        assertEq(ledger.balanceOf(donorB, batchId), 0);
        assertEq(ledger.inventoryOf(batchId), 40_000);
    }

    function test_declineAfterPartialFillKeepsAllocated() public {
        _estimate(100_000);
        uint256 batchId = _issue(50_000); // fills half of each reservation
        assertEq(ledger.balanceOf(donorB, batchId), 20_000);

        vm.prank(donorB);
        ledger.declineReservation(address(c));
        assertEq(ledger.reservationOf(address(c), donorB), 20_000);
        assertEq(ledger.remainingReservation(address(c), donorB), 0);
        assertEq(ledger.balanceOf(donorB, batchId), 20_000);
    }

    function test_revertWhen_declineWithoutReservation() public {
        vm.prank(outsider);
        vm.expectRevert(abi.encodeWithSelector(NoReservation.selector, address(c), outsider));
        ledger.declineReservation(address(c));
    }

    // -----------------------------------------------------------------------
    // Issuance
    // -----------------------------------------------------------------------

    function test_issuanceFillsReservationsFirstThenInventory() public {
        _estimate(100_000);

        // First batch covers half of the reservations: pro rata, nothing to inventory.
        uint256 first = _issue(50_000);
        assertEq(ledger.balanceOf(donorA, first), 30_000);
        assertEq(ledger.balanceOf(donorB, first), 20_000);
        assertEq(ledger.inventoryOf(first), 0);

        // Second batch fills the rest exactly and sends the surplus to inventory.
        vm.expectEmit(address(ledger));
        emit ICarbonLedger.Allocated(2, donorA, 30_000);
        vm.expectEmit(address(ledger));
        emit ICarbonLedger.Allocated(2, donorB, 20_000);
        vm.expectEmit(address(ledger));
        emit ICarbonLedger.Allocated(2, address(ledger), 30_000);
        uint256 second = _issue(80_000);

        assertEq(ledger.balanceOf(donorA, second), 30_000);
        assertEq(ledger.inventoryOf(second), 30_000);
        assertEq(ledger.remainingReservation(address(c), donorA), 0);
        (,, uint256 outstanding, uint256 issued,) = ledger.campaignCarbon(address(c));
        assertEq(outstanding, 0);
        assertEq(issued, 130_000);
    }

    function test_issuanceRoundingGoesToInventory() public {
        _estimate(100_001); // reservations round down to 60_000 and 40_000
        uint256 batchId = _issue(7);
        // 7 * 0.6 = 4.2 -> 4 and 7 * 0.4 = 2.8 -> 2, so 1 unit goes to inventory.
        assertEq(ledger.balanceOf(donorA, batchId), 4);
        assertEq(ledger.balanceOf(donorB, batchId), 2);
        assertEq(ledger.inventoryOf(batchId), 1);
    }

    function test_issuanceWithoutEstimateGoesToInventory() public {
        uint256 batchId = _issue(5_000);
        assertEq(ledger.inventoryOf(batchId), 5_000);
        assertEq(ledger.balanceOf(donorA, batchId), 0);
    }

    function test_issueBatchStoresMetadata() public {
        vm.expectEmit(address(ledger));
        emit ICarbonLedger.BatchIssued(1, address(c), "SRN PPI", "IDN-0001", "IDN-0010", 2027, 10_000);
        uint256 batchId = _issue(10_000);
        CarbonBatch memory batch = ledger.getBatch(batchId);
        assertEq(batch.campaign, address(c));
        assertEq(batch.vintage, 2027);
        assertEq(batch.amount, 10_000);
        assertEq(batch.registry, "SRN PPI");
        assertEq(batch.serialStart, "IDN-0001");
        assertEq(batch.serialEnd, "IDN-0010");
        assertEq(ledger.batchCount(), 1);
    }

    function test_issuanceAllowedAfterCompletion() public {
        vm.warp(c.config().claimDeadline + 37 * UNIT);
        c.complete();
        uint256 batchId = _issue(1_000);
        assertEq(ledger.inventoryOf(batchId), 1_000);
    }

    function test_revertWhen_issueInvalid() public {
        vm.prank(outsider);
        vm.expectRevert(abi.encodeWithSelector(Unauthorized.selector, outsider));
        ledger.issueBatch(address(c), "SRN PPI", "a", "b", 2027, 1);

        Campaign funding = _newCampaign();
        vm.startPrank(operator);
        vm.expectRevert(ZeroAmount.selector);
        ledger.issueBatch(address(c), "SRN PPI", "a", "b", 2027, 0);
        vm.expectRevert(abi.encodeWithSelector(UnknownCampaign.selector, outsider));
        ledger.issueBatch(outsider, "SRN PPI", "a", "b", 2027, 1);
        vm.expectRevert(
            abi.encodeWithSelector(WrongCampaignStatus.selector, CampaignStatus.Active, CampaignStatus.Funding)
        );
        ledger.issueBatch(address(funding), "SRN PPI", "a", "b", 2027, 1);
        vm.stopPrank();
    }

    // -----------------------------------------------------------------------
    // Sale
    // -----------------------------------------------------------------------

    function test_buyMovesUsdcAndCredits() public {
        uint256 batchId = _issue(10_000);
        vm.expectEmit(address(ledger));
        emit ICarbonLedger.PriceSet(batchId, 15e6);
        vm.prank(operator);
        ledger.setPrice(batchId, 15e6);

        _fundBuyer(100e6);
        uint256 treasuryBefore = usdc.balanceOf(treasury);
        vm.expectEmit(address(ledger));
        emit ICarbonLedger.Purchased(batchId, buyer, 2_500, 37.5e6);
        vm.prank(buyer);
        assertEq(ledger.buy(batchId, 2_500), 37.5e6);

        assertEq(ledger.balanceOf(buyer, batchId), 2_500);
        assertEq(ledger.inventoryOf(batchId), 7_500);
        assertEq(usdc.balanceOf(treasury) - treasuryBefore, 37.5e6);
        assertEq(ledger.getBatch(batchId).priceUsdcPerTonne, 15e6);
    }

    function test_buyRoundsCostUp() public {
        uint256 batchId = _issue(10_000);
        vm.prank(operator);
        ledger.setPrice(batchId, 1_000_001);
        _fundBuyer(10e6);
        vm.prank(buyer);
        assertEq(ledger.buy(batchId, 1), 1_001); // 1.000001 USDC per kg, rounded up
    }

    function test_revertWhen_buyInvalid() public {
        uint256 batchId = _issue(1_000);
        _fundBuyer(100e6);
        vm.startPrank(buyer);
        vm.expectRevert(abi.encodeWithSelector(PriceNotSet.selector, batchId));
        ledger.buy(batchId, 1);
        vm.expectRevert(abi.encodeWithSelector(UnknownBatch.selector, 2));
        ledger.buy(2, 1);
        vm.expectRevert(abi.encodeWithSelector(UnknownBatch.selector, 0));
        ledger.buy(0, 1);
        vm.stopPrank();

        vm.prank(operator);
        ledger.setPrice(batchId, 1e6);
        vm.startPrank(buyer);
        vm.expectRevert(ZeroAmount.selector);
        ledger.buy(batchId, 0);
        vm.expectRevert(abi.encodeWithSelector(InsufficientInventory.selector, batchId, 1_001, 1_000));
        ledger.buy(batchId, 1_001);
        vm.stopPrank();
    }

    function test_revertWhen_setPriceInvalid() public {
        uint256 batchId = _issue(1_000);
        vm.prank(outsider);
        vm.expectRevert(abi.encodeWithSelector(Unauthorized.selector, outsider));
        ledger.setPrice(batchId, 1);
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(UnknownBatch.selector, 9));
        ledger.setPrice(9, 1);
    }

    // -----------------------------------------------------------------------
    // Non-transferability
    // -----------------------------------------------------------------------

    function test_userToUserTransfersRevert() public {
        _estimate(100_000);
        uint256 batchId = _issue(100_000);

        vm.startPrank(donorA);
        vm.expectRevert(NonTransferable.selector);
        ledger.safeTransferFrom(donorA, donorB, batchId, 1, "");

        uint256[] memory ids = new uint256[](1);
        uint256[] memory values = new uint256[](1);
        ids[0] = batchId;
        values[0] = 1;
        vm.expectRevert(NonTransferable.selector);
        ledger.safeBatchTransferFrom(donorA, donorB, ids, values, "");

        vm.expectRevert(NonTransferable.selector);
        ledger.setApprovalForAll(donorB, true);
        vm.stopPrank();
    }

    function test_inventoryCannotBeMovedByOthers() public {
        uint256 batchId = _issue(1_000);
        vm.prank(outsider);
        vm.expectRevert(
            abi.encodeWithSelector(IERC1155Errors.ERC1155MissingApprovalForAll.selector, outsider, address(ledger))
        );
        ledger.safeTransferFrom(address(ledger), outsider, batchId, 1, "");
    }

    // -----------------------------------------------------------------------
    // Retirement
    // -----------------------------------------------------------------------

    function test_retireBurnsAndRecords() public {
        _estimate(100_000);
        uint256 batchId = _issue(100_000);

        vm.expectEmit(address(ledger));
        emit ICarbonLedger.Retired(1, batchId, donorA, 10_000, "PT Contoh", "2026 office emissions");
        vm.prank(donorA);
        uint256 retirementId = ledger.retire(batchId, 10_000, "PT Contoh", "2026 office emissions");

        assertEq(retirementId, 1);
        assertEq(ledger.retirementCount(), 1);
        assertEq(ledger.balanceOf(donorA, batchId), 50_000);
        Retirement memory r = ledger.getRetirement(retirementId);
        assertEq(r.batchId, batchId);
        assertEq(r.holder, donorA);
        assertEq(r.amount, 10_000);
        assertEq(r.retiredAt, _now());
        assertEq(r.beneficiary, "PT Contoh");
        assertEq(r.purpose, "2026 office emissions");
    }

    function test_buyerCanRetirePurchasedCredits() public {
        uint256 batchId = _issue(5_000);
        vm.prank(operator);
        ledger.setPrice(batchId, 10e6);
        _fundBuyer(100e6);
        vm.startPrank(buyer);
        ledger.buy(batchId, 2_000);
        ledger.retire(batchId, 2_000, "Buyer Co", "Offset");
        vm.stopPrank();
        assertEq(ledger.balanceOf(buyer, batchId), 0);
    }

    function test_revertWhen_retireInvalid() public {
        _estimate(100_000);
        uint256 batchId = _issue(100_000);
        vm.startPrank(donorA);
        vm.expectRevert(ZeroAmount.selector);
        ledger.retire(batchId, 0, "x", "y");
        vm.expectRevert(EmptyBeneficiary.selector);
        ledger.retire(batchId, 1, "", "y");
        vm.expectRevert(abi.encodeWithSelector(UnknownBatch.selector, 5));
        ledger.retire(5, 1, "x", "y");
        vm.expectRevert(
            abi.encodeWithSelector(IERC1155Errors.ERC1155InsufficientBalance.selector, donorA, 60_000, 60_001, batchId)
        );
        ledger.retire(batchId, 60_001, "x", "y");
        vm.stopPrank();
    }

    // -----------------------------------------------------------------------
    // Admin
    // -----------------------------------------------------------------------

    function test_uriAndSetURI() public {
        assertEq(ledger.uri(1), "https://treecord.test/carbon/{id}.json");
        vm.prank(admin);
        ledger.setURI("https://treecord.app/carbon/{id}.json");
        assertEq(ledger.uri(1), "https://treecord.app/carbon/{id}.json");

        vm.prank(outsider);
        vm.expectRevert(abi.encodeWithSelector(Unauthorized.selector, outsider));
        ledger.setURI("x");
    }

    function test_constructorRejectsZeroUsdc() public {
        vm.expectRevert(ZeroAddress.selector);
        new CarbonLedger(roles, IERC20(address(0)), "");
    }

    function test_supportsErc1155Interface() public view {
        assertTrue(ledger.supportsInterface(0xd9b67a26));
        assertFalse(ledger.supportsInterface(type(IAccessControl).interfaceId));
    }

    // -----------------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------------

    function _estimate(uint256 amount) internal {
        vm.prank(operator);
        ledger.setEstimate(address(c), amount);
    }

    function _issue(uint256 amount) internal returns (uint256) {
        vm.prank(operator);
        return ledger.issueBatch(address(c), "SRN PPI", "IDN-0001", "IDN-0010", 2027, amount);
    }

    function _fundBuyer(uint256 amount) internal {
        usdc.mint(buyer, amount);
        vm.prank(buyer);
        usdc.approve(address(ledger), type(uint256).max);
    }
}
