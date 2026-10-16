// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {CarbonBatch, Retirement} from "../libraries/TreecordTypes.sol";

/// @title ICarbonLedger
/// @notice Non-transferable carbon credit ledger (ERC-1155, token id = batch id). Implemented in prompt 3.
/// @dev Carbon amounts use 3 decimals: 1000 = 1 tCO2e. This lets pro-rata reservations keep kilogram
///      precision while registry issuances stay whole tonnes.
interface ICarbonLedger {
    /// @notice A pre-certification estimate was set for a campaign.
    event EstimateSet(address indexed campaign, uint256 estimatedAmount);
    /// @notice A contributor received a reservation pro rata to their contribution.
    event Reserved(address indexed campaign, address indexed holder, uint256 amount);
    /// @notice A contributor declined their reservation. It moves to platform inventory.
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
    /// @notice Issued credits were allocated to a holder (reservation holder or treasury inventory).
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

    /// @notice Declines the caller's reservation, moving it to platform inventory.
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

    /// @notice Buys credits from treasury inventory.
    function buy(uint256 batchId, uint256 amount) external;

    /// @notice Burns the caller's credits and records a retirement.
    function retire(uint256 batchId, uint256 amount, string calldata beneficiary, string calldata purpose)
        external
        returns (uint256 retirementId);

    /// @notice A holder's reserved amount for a campaign.
    function reservationOf(address campaign, address holder) external view returns (uint256);

    /// @notice A holder's reservation not yet filled by issuance.
    function remainingReservation(address campaign, address holder) external view returns (uint256);

    /// @notice Batch metadata.
    function getBatch(uint256 batchId) external view returns (CarbonBatch memory);

    /// @notice Retirement record.
    function getRetirement(uint256 retirementId) external view returns (Retirement memory);
}
