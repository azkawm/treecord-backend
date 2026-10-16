// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Shared enums, structs, and errors for every Treecord contract.
// See PRODUCT_KNOWLEDGE.md sections 3, 4, 8 and 15.

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

/// @notice Campaign lifecycle: Funding -> Active -> Completed, or Funding -> Refunding.
enum CampaignStatus {
    Funding,
    Active,
    Refunding,
    Completed
}

/// @notice Tree lifecycle. `None` marks an unregistered tree id.
enum TreeStatus {
    None,
    Alive,
    Flagged,
    Dead,
    Removed,
    Completed
}

/// @notice Kinds of verified evidence carried by an EIP-712 attestation.
enum AttestationKind {
    Planted,
    Alive,
    Dead,
    Replanted
}

/// @notice Why a tree was removed.
enum RemovalReason {
    ReplantExpired,
    FlagUpheld
}

// ---------------------------------------------------------------------------
// Structs
// ---------------------------------------------------------------------------

/// @notice Budget split in basis points. The five buckets must sum to 10000.
struct BudgetSplit {
    uint16 incentivesBps;
    uint16 seedlingsBps;
    uint16 verificationBps;
    uint16 reserveBps;
    uint16 feeBps;
}

/// @notice Immutable configuration of a campaign, fixed at creation.
struct CampaignConfig {
    address creator;
    string metadataURI;
    bytes32 speciesCode;
    bytes8 regionGeohash;
    uint32 regionRadiusM;
    uint32 treeTarget;
    uint16 anchorBps;
    uint16 perPlanterCap;
    uint256 fundingTarget;
    uint64 fundingDeadline;
    uint64 claimDeadline;
    uint16 commitmentUnits;
    uint64 timeUnit;
    BudgetSplit split;
}

/// @notice On-chain record of a planted tree. Packed into four storage slots.
/// @dev `pausedDuration` accumulates the time spent under dismissed flags. It shifts every milestone
///      window and the replant deadline (PRODUCT_KNOWLEDGE.md section 15, rule 2).
struct Tree {
    // slot 0
    address campaign;
    uint32 slotId;
    TreeStatus status;
    TreeStatus statusBeforeFlag;
    // slot 1
    address planter;
    uint64 plantedAt;
    uint32 checkInCount;
    // slot 2
    bytes8 geohash;
    uint64 replantDeadline;
    uint64 flaggedAt;
    uint64 pausedDuration;
    // slot 3
    bytes32 latestEvidenceHash;
}

/// @notice EIP-712 attestation signed by the backend attester (PRODUCT_KNOWLEDGE.md section 8).
struct Attestation {
    uint8 kind;
    address campaign;
    uint256 slotId;
    uint256 treeId;
    address planter;
    uint8 milestone;
    bytes32 evidenceHash;
    bytes8 geohash;
    uint16 score;
    uint256 nonce;
    uint64 expiry;
}

/// @notice A registry issuance mirrored on-chain. Carbon amounts use CARBON_DECIMALS (1000 = 1 tCO2e).
struct CarbonBatch {
    address campaign;
    uint16 vintage;
    uint256 amount;
    uint256 priceUsdcPerTonne;
    string registry;
    string serialStart;
    string serialEnd;
}

/// @notice A permanent retirement record. Carbon amounts use CARBON_DECIMALS (1000 = 1 tCO2e).
struct Retirement {
    uint256 batchId;
    address holder;
    uint256 amount;
    uint64 retiredAt;
    string beneficiary;
    string purpose;
}

// ---------------------------------------------------------------------------
// Errors: access and wiring
// ---------------------------------------------------------------------------

error Unauthorized(address caller);
error ZeroAddress();
error AlreadySet();

// ---------------------------------------------------------------------------
// Errors: campaign configuration
// ---------------------------------------------------------------------------

error InvalidSplit(uint256 sumBps);
error CommitmentTooShort(uint16 units, uint16 minimum);
error InvalidDeadlines();
error InvalidTreeTarget();
error InvalidTimeUnit();
error InvalidAnchorBps(uint16 anchorBps);
error InvalidPerPlanterCap();
error InvalidFundingTarget();

// ---------------------------------------------------------------------------
// Errors: campaign runtime
// ---------------------------------------------------------------------------

error WrongCampaignStatus(CampaignStatus expected, CampaignStatus actual);
error ZeroAmount();
error FundingClosed();
error FundingStillOpen();
error ClaimWindowClosed();
error ClaimWindowOpen();
error NotEnoughSlots(uint256 requested, uint256 available);
error PlanterCapExceeded(uint256 requested, uint256 remaining);
error InvalidSlot(uint256 slotId);
error SlotNotOwned(uint256 slotId, address planter);
error SlotAlreadyPlanted(uint256 slotId);
error InvalidMilestone(uint8 milestone);
error MilestoneAlreadySettled(uint256 treeId, uint8 milestone);
error MilestoneNotOpen(uint256 treeId, uint8 milestone, uint256 opensAt, uint256 closesAt);
error MilestoneWindowNotClosed(uint256 treeId, uint8 milestone, uint256 closesAt);
error TreeNotInCampaign(uint256 treeId);
error WrongPlanter(uint256 treeId, address planter);
error TreeFrozen(uint256 treeId);
error CompletionNotReady();
error RefundsNotAvailable(CampaignStatus status);
error NothingToRefund();
error ReserveExceeded(uint256 requested, uint256 available);

// ---------------------------------------------------------------------------
// Errors: tree registry
// ---------------------------------------------------------------------------

error UnknownCampaign(address campaign);
error UnknownTree(uint256 treeId);
error WrongTreeStatus(uint256 treeId, TreeStatus actual);
error ReplantDeadlinePassed(uint256 treeId, uint256 deadline);
error ReplantDeadlineNotPassed(uint256 treeId, uint256 deadline);
error NotContributor(address caller);
error MilestonesNotSettled(uint256 treeId);
