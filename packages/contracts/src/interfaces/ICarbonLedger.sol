// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {CarbonBatch, Retirement} from "../libraries/TreecordTypes.sol";

/// @title ICarbonLedger
/// @notice Non-transferable carbon credit ledger (ERC-1155, token id = batch id).
/// @dev Carbon amounts use 3 decimals: 1000 = 1 tCO2e. This lets pro-rata reservations keep kilogram
///      precision while registry issuances stay whole tonnes. Prices are USDC base units per whole tonne.
interface ICarbonLedger {
    /// @notice A pre-certification estimate was set (or replaced before issuance) for a campaign.
    event EstimateSet(address indexed campaign, uint256 estimatedAmount);
    /// @notice A contributor's reservation was set pro rata to their contribution.
    event Reserved(address indexed campaign, address indexed holder, uint256 amount);
    /// @notice A contributor declined the unfilled part of their reservation. It goes to platform inventory.
    event ReservationDeclined(address indexed campaign, address indexed holder, uint256 amount);
    /// @notice A registry issuance was mirrored on-chain.
    event BatchIssued(
        uint256 indexed batchId,
        address indexed campaign,
        string registry,
        string serialStart,
        string serialEnd,
        uint16 vintage,
        uint256 amount
    );
    /// @notice Issued credits were allocated to a reservation holder, or to platform inventory (the ledger itself).
    event Allocated(uint256 indexed batchId, address indexed holder, uint256 amount);
    /// @notice The sale price of a batch was set.
    event PriceSet(uint256 indexed batchId, uint256 usdcPerTonne);
    /// @notice A buyer purchased credits from platform inventory.
    event Purchased(uint256 indexed batchId, address indexed buyer, uint256 amount, uint256 usdcPaid);
    /// @notice Credits were burned in a permanent retirement.
    event Retired(
        uint256 indexed retirementId,
        uint256 indexed batchId,
        address indexed holder,
        uint256 amount,
        string beneficiary,
        string purpose
    );

    /// @notice Sets the pre-certification estimate and creates pro-rata reservations. Operator only.
    function setEstimate(address campaign, uint256 estimatedAmount) external;

    /// @notice Declines the unfilled part of the caller's reservation, moving it to platform inventory.
    function declineReservation(address campaign) external;

    /// @notice Mirrors a registry issuance and allocates it. Issuer only.
    function issueBatch(
        address campaign,
        string calldata registry,
        string calldata serialStart,
        string calldata serialEnd,
        uint16 vintage,
        uint256 amount
    ) external returns (uint256 batchId);

    /// @notice Sets the USDC price per whole tonne for a batch. Operator only.
    function setPrice(uint256 batchId, uint256 usdcPerTonne) external;

    /// @notice Buys credits from platform inventory. USDC goes to the treasury.
    function buy(uint256 batchId, uint256 amount) external returns (uint256 usdcPaid);

    /// @notice Burns the caller's credits and records a retirement.
    function retire(uint256 batchId, uint256 amount, string calldata beneficiary, string calldata purpose)
        external
        returns (uint256 retirementId);

    /// @notice A holder's reserved amount for a campaign (filled plus unfilled).
    function reservationOf(address campaign, address holder) external view returns (uint256);

    /// @notice A holder's reservation not yet filled by issuance.
    function remainingReservation(address campaign, address holder) external view returns (uint256);

    /// @notice Unsold platform inventory of a batch.
    function inventoryOf(uint256 batchId) external view returns (uint256);

    /// @notice Batch metadata.
    function getBatch(uint256 batchId) external view returns (CarbonBatch memory);

    /// @notice Retirement record.
    function getRetirement(uint256 retirementId) external view returns (Retirement memory);
}
