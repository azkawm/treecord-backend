// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {CampaignConfig, CampaignStatus} from "../libraries/TreecordTypes.sol";

/// @title ICampaign
/// @notice A single tree campaign: USDC escrow, slots, and per-tree milestone incentives.
interface ICampaign {
    // -----------------------------------------------------------------------
    // Events
    // -----------------------------------------------------------------------

    /// @notice A contribution was accepted. `amount` is what was actually pulled (capped at the remaining target).
    event Contributed(address indexed contributor, uint256 amount, uint256 totalRaised);
    /// @notice The funding target was reached and the campaign is now Active.
    event Activated(uint256 activatedAt, uint256 incentivePool, uint256 perTreeIncentive, uint256 reserveAmount);
    /// @notice Seedling, verification and fee buckets were sent to the treasury on activation.
    event BucketsReleased(address indexed treasury, uint256 seedlings, uint256 verification, uint256 fee);
    /// @notice The funding deadline passed without reaching the target. Contributors can pull full refunds.
    event RefundingStarted();
    /// @notice A contributor pulled a refund (full while Refunding, pro rata after Completed).
    event Refunded(address indexed contributor, uint256 amount);
    /// @notice Open slots `firstSlotId .. firstSlotId + count - 1` were claimed for a planter.
    event SlotsClaimed(address indexed planter, uint256 firstSlotId, uint256 count);
    /// @notice Anchor (or rolled-over open) slots `firstSlotId .. firstSlotId + count - 1` were assigned to a planter.
    event AnchorSlotsAssigned(address indexed planter, uint256 firstSlotId, uint256 count);
    /// @notice A slot received its tree.
    event SlotPlanted(uint256 indexed slotId, uint256 indexed treeId, address indexed planter);
    /// @notice A milestone incentive was paid to the planter.
    event MilestonePaid(uint256 indexed treeId, uint8 indexed milestone, address indexed planter, uint256 amount);
    /// @notice A milestone incentive was forfeited to the campaign pool (missed window or tree removed).
    event MilestoneForfeited(uint256 indexed treeId, uint8 indexed milestone, uint256 amount);
    /// @notice Part of the replacement reserve was sent to the treasury to pay for a replanting.
    event ReserveDrawn(uint256 indexed treeId, address indexed to, uint256 amount);
    /// @notice The campaign completed. `refundPool` is shared pro rata among contributors.
    event CampaignCompleted(uint256 refundPool);

    // -----------------------------------------------------------------------
    // Lifecycle
    // -----------------------------------------------------------------------

    /// @notice Initializes a freshly cloned campaign. Called once by the factory.
    function initialize(CampaignConfig calldata cfg) external;

    /// @notice Contributes USDC while Funding. Pulls at most the remaining amount to the target.
    function contribute(uint256 amount) external returns (uint256 accepted);

    /// @notice Moves an unfunded campaign to Refunding after the funding deadline.
    function markRefunding() external;

    /// @notice Pulls the caller's refund (full while Refunding, pro rata after Completed).
    function claimRefund() external returns (uint256 amount);

    /// @notice Completes the campaign once every planted tree is settled and the commitment period has ended.
    function complete() external;

    // -----------------------------------------------------------------------
    // Slots
    // -----------------------------------------------------------------------

    /// @notice Claims open slots on behalf of a planter (gasless claims).
    function claimSlotsFor(address planter, uint16 count) external;

    /// @notice Assigns anchor slots, and after the claim deadline rolled-over open slots, to a planter.
    function assignAnchorSlots(address planter, uint16 count) external;

    /// @notice The planter that owns a slot, or zero.
    function slotOwner(uint256 slotId) external view returns (address);

    // -----------------------------------------------------------------------
    // Hooks from TreeRegistry and VerificationGateway
    // -----------------------------------------------------------------------

    /// @notice Records that a slot was planted. Only callable by the TreeRegistry.
    function onTreePlanted(uint256 slotId, uint256 treeId, address planter) external;

    /// @notice Pays a milestone incentive. Only callable by the VerificationGateway.
    function releaseMilestone(uint256 treeId, uint8 milestone, address planter) external;

    /// @notice Forfeits every unsettled milestone of a removed tree. Only callable by the TreeRegistry.
    function onTreeRemoved(uint256 treeId) external;

    /// @notice Records that a tree completed. Only callable by the TreeRegistry.
    function onTreeCompleted(uint256 treeId) external;

    /// @notice Forfeits a milestone whose window closed unpaid. Callable by anyone.
    function forfeitMilestone(uint256 treeId, uint8 milestone) external;

    // -----------------------------------------------------------------------
    // Views used by other contracts
    // -----------------------------------------------------------------------

    /// @notice The full campaign configuration.
    function config() external view returns (CampaignConfig memory);

    /// @notice Current campaign status.
    function status() external view returns (CampaignStatus);

    /// @notice Length of one time unit in seconds.
    function timeUnit() external view returns (uint64);

    /// @notice USDC contributed by an address.
    function contributions(address contributor) external view returns (uint256);

    /// @notice Total USDC contributed (equals the funding target once Active).
    function totalRaised() external view returns (uint256);

    /// @notice Number of distinct contributors.
    function contributorCount() external view returns (uint256);

    /// @notice Contributor at an index, in first-contribution order.
    function contributorAt(uint256 index) external view returns (address);

    /// @notice True when every milestone of a tree is paid or forfeited.
    function allMilestonesSettled(uint256 treeId) external view returns (bool);
}
