// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

import {RoleGated, TreecordRoles} from "./TreecordRoles.sol";
import {ICampaign} from "./interfaces/ICampaign.sol";
import {ITreeRegistry} from "./interfaces/ITreeRegistry.sol";
import {TreecordConstants as C} from "./libraries/TreecordConstants.sol";
import {
    CampaignConfig,
    CampaignStatus,
    Tree,
    TreeStatus,
    ClaimWindowClosed,
    CompletionNotReady,
    FundingClosed,
    FundingStillOpen,
    InvalidMilestone,
    InvalidSlot,
    MilestoneAlreadySettled,
    MilestoneNotOpen,
    MilestoneWindowNotClosed,
    NotEnoughSlots,
    NothingToRefund,
    PlanterCapExceeded,
    RefundsNotAvailable,
    ReserveExceeded,
    SlotAlreadyPlanted,
    SlotNotOwned,
    TreeFrozen,
    TreeNotInCampaign,
    Unauthorized,
    WrongCampaignStatus,
    WrongPlanter,
    WrongTreeStatus,
    ZeroAddress,
    ZeroAmount
} from "./libraries/TreecordTypes.sol";

/// @title Campaign
/// @notice USDC escrow for one tree campaign: funding, slots, and per-tree milestone incentives.
/// @dev Deployed once as an implementation and used through minimal proxy clones created by CampaignFactory.
///      `roles`, `usdc` and `treeRegistry` are immutables, so they live in the implementation bytecode and
///      are shared by every clone.
///
///      Accounting. After activation the contract holds `incentivePool + reserveAmount`. Money leaves only as
///      milestone payouts (`totalPaid`), reserve draws (`reserveDrawn`) and refunds. At completion everything
///      left (`refundPool`) is refundable pro rata: forfeited milestones, removed trees, never-planted slots,
///      unused reserve and rounding dust (PRODUCT_KNOWLEDGE.md section 15, rule 12).
///
///      Rounding. Bucket remainders go to the reserve, so activation never loses USDC. The per-tree remainder of
///      the incentive pool is tracked as `incentiveDust`. The last milestone of each tree pays the per-tree
///      remainder, so the six milestones of a tree sum exactly to `perTreeIncentive`.
///
///      Slots. Ids 1..anchorSlots are anchor slots, anchorSlots+1..treeTarget are open slots. Both ranges are
///      handed out sequentially, so a claim is always a contiguous range and is logged as one event
///      (cheaper than one event per slot). After the claim deadline, unclaimed open slots roll into the
///      anchor portion and can be assigned by an operator.
contract Campaign is ICampaign, RoleGated, Initializable, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    /// @notice The USDC token (6 decimals).
    IERC20 public immutable usdc;
    /// @notice The global tree registry.
    ITreeRegistry public immutable treeRegistry;

    CampaignConfig internal _config;

    /// @inheritdoc ICampaign
    CampaignStatus public status;
    /// @notice The factory that created this campaign.
    address public factory;

    // ---------------------------------------------------------------- funding

    /// @inheritdoc ICampaign
    uint256 public totalRaised;
    /// @inheritdoc ICampaign
    mapping(address contributor => uint256 amount) public contributions;
    /// @notice True once a contributor has pulled their refund.
    mapping(address contributor => bool claimed) public refundClaimed;
    address[] internal _contributors;

    // ------------------------------------------------------------- activation

    /// @notice Timestamp of activation, zero before.
    uint64 public activatedAt;
    /// @notice USDC reserved for planter incentives.
    uint256 public incentivePool;
    /// @notice USDC kept for replanting (replacement reserve plus bucket rounding remainders).
    uint256 public reserveAmount;
    /// @notice Incentive per tree: incentivePool / treeTarget.
    uint256 public perTreeIncentive;
    /// @notice incentivePool - perTreeIncentive * treeTarget. Refundable at completion.
    uint256 public incentiveDust;

    // ------------------------------------------------------------------ slots

    /// @notice Number of anchor (platform-managed) slots.
    uint32 public anchorSlots;
    /// @notice Number of open (public) slots.
    uint32 public openSlots;
    /// @notice Anchor slots assigned so far.
    uint32 public anchorAssigned;
    /// @notice Open slots handed out so far, by planter claims or by rollover assignment.
    uint32 public openAssigned;
    /// @inheritdoc ICampaign
    mapping(uint256 slotId => address planter) public slotOwner;
    /// @notice Tree planted in a slot, zero if not planted.
    mapping(uint256 slotId => uint256 treeId) public slotTree;
    /// @notice Open slots claimed by a planter. Counts toward perPlanterCap. Anchor assignments do not.
    mapping(address planter => uint32 count) public openClaimsOf;

    // ------------------------------------------------------------------ trees

    /// @notice Number of trees planted in this campaign.
    uint32 public plantedCount;
    /// @notice Number of planted trees that are Completed or Removed.
    uint32 public settledCount;
    /// @notice Latest planting timestamp in this campaign.
    uint64 public lastPlantedAt;
    /// @notice Bit i set when milestone i of a tree was paid.
    mapping(uint256 treeId => uint8 mask) public paidMask;
    /// @notice Bit i set when milestone i of a tree was forfeited.
    mapping(uint256 treeId => uint8 mask) public forfeitedMask;

    // ------------------------------------------------------------- accounting

    /// @notice Total milestone incentives paid to planters.
    uint256 public totalPaid;
    /// @notice Total milestone incentives forfeited back to the campaign.
    uint256 public forfeitedPool;
    /// @notice Total drawn from the replacement reserve.
    uint256 public reserveDrawn;
    /// @notice USDC refundable pro rata after completion. Zero before.
    uint256 public refundPool;

    modifier onlyTreeRegistry() {
        if (msg.sender != address(treeRegistry)) revert Unauthorized(msg.sender);
        _;
    }

    modifier inStatus(CampaignStatus expected) {
        if (status != expected) revert WrongCampaignStatus(expected, status);
        _;
    }

    /// @param roles_ Central role registry.
    /// @param usdc_ USDC token.
    /// @param treeRegistry_ Global tree registry.
    constructor(TreecordRoles roles_, IERC20 usdc_, ITreeRegistry treeRegistry_) RoleGated(roles_) {
        if (address(usdc_) == address(0) || address(treeRegistry_) == address(0)) revert ZeroAddress();
        usdc = usdc_;
        treeRegistry = treeRegistry_;
        _disableInitializers();
    }

    // =======================================================================
    // Lifecycle
    // =======================================================================

    /// @inheritdoc ICampaign
    /// @dev The factory validates `cfg` before cloning and calls this in the same transaction.
    function initialize(CampaignConfig calldata cfg) external initializer {
        _config = cfg;
        factory = msg.sender;
        // casting to 'uint32' is safe because anchorBps <= BPS, so the result is at most treeTarget (a uint32)
        // forge-lint: disable-next-line(unsafe-typecast)
        anchorSlots = uint32((uint256(cfg.treeTarget) * cfg.anchorBps) / C.BPS);
        openSlots = cfg.treeTarget - anchorSlots;
    }

    /// @inheritdoc ICampaign
    /// @dev Pulls only `min(amount, fundingTarget - totalRaised)` so overfunding never needs a refund
    ///      (PRODUCT_KNOWLEDGE.md section 15, rule 7). Reaching the target activates the campaign and sends
    ///      the seedling, verification and fee buckets to the treasury in the same transaction.
    function contribute(uint256 amount)
        external
        nonReentrant
        inStatus(CampaignStatus.Funding)
        returns (uint256 accepted)
    {
        if (amount == 0) revert ZeroAmount();
        if (block.timestamp >= _config.fundingDeadline) revert FundingClosed();

        uint256 remaining = _config.fundingTarget - totalRaised;
        accepted = amount < remaining ? amount : remaining;

        if (contributions[msg.sender] == 0) _contributors.push(msg.sender);
        contributions[msg.sender] += accepted;
        totalRaised += accepted;
        emit Contributed(msg.sender, accepted, totalRaised);

        usdc.safeTransferFrom(msg.sender, address(this), accepted);

        if (totalRaised == _config.fundingTarget) _activate();
    }

    /// @inheritdoc ICampaign
    function markRefunding() external inStatus(CampaignStatus.Funding) {
        if (block.timestamp < _config.fundingDeadline) revert FundingStillOpen();
        status = CampaignStatus.Refunding;
        emit RefundingStarted();
    }

    /// @inheritdoc ICampaign
    /// @dev Refunding: the full contribution. Completed: refundPool * contribution / totalRaised.
    ///      Pro-rata rounding leaves at most one base unit per contributor in the contract.
    function claimRefund() external nonReentrant returns (uint256 amount) {
        uint256 contributed = contributions[msg.sender];
        if (contributed == 0 || refundClaimed[msg.sender]) revert NothingToRefund();

        if (status == CampaignStatus.Refunding) {
            amount = contributed;
        } else if (status == CampaignStatus.Completed) {
            amount = (refundPool * contributed) / totalRaised;
        } else {
            revert RefundsNotAvailable(status);
        }

        refundClaimed[msg.sender] = true;
        emit Refunded(msg.sender, amount);
        if (amount > 0) usdc.safeTransfer(msg.sender, amount);
    }

    /// @inheritdoc ICampaign
    /// @dev Allowed when every planted tree is Completed or Removed and the commitment period plus the
    ///      final window has passed since the later of the last planting and the claim deadline. Using the
    ///      claim deadline as a floor stops a campaign with no plantings from completing right after activation.
    function complete() external inStatus(CampaignStatus.Active) {
        if (settledCount != plantedCount) revert CompletionNotReady();
        uint256 start = lastPlantedAt > _config.claimDeadline ? lastPlantedAt : _config.claimDeadline;
        uint256 endsAt = start + (uint256(_config.commitmentUnits) + 1) * _config.timeUnit;
        if (block.timestamp < endsAt) revert CompletionNotReady();

        status = CampaignStatus.Completed;
        refundPool = incentivePool + reserveAmount - totalPaid - reserveDrawn;
        emit CampaignCompleted(refundPool);
    }

    // =======================================================================
    // Slots
    // =======================================================================

    /// @inheritdoc ICampaign
    /// @dev Operator only. Open slots only, before the claim deadline, capped per planter.
    function claimSlotsFor(address planter, uint16 count)
        external
        onlyRoleHolder(OPERATOR_ROLE)
        inStatus(CampaignStatus.Active)
    {
        if (planter == address(0)) revert ZeroAddress();
        if (count == 0) revert ZeroAmount();
        if (block.timestamp >= _config.claimDeadline) revert ClaimWindowClosed();

        uint256 available = openSlots - openAssigned;
        if (count > available) revert NotEnoughSlots(count, available);

        uint256 capRemaining = _config.perPlanterCap - openClaimsOf[planter];
        if (count > capRemaining) revert PlanterCapExceeded(count, capRemaining);

        openClaimsOf[planter] += count;
        uint256 first = _takeOpen(planter, count);
        emit SlotsClaimed(planter, first, count);
    }

    /// @inheritdoc ICampaign
    /// @dev Operator only. Uses anchor slots first. After the claim deadline it continues with unclaimed
    ///      open slots (rolled over to anchor). Emits one AnchorSlotsAssigned per contiguous range (at most two).
    ///      perPlanterCap does not apply: anchor slots are planted by platform-managed crews.
    function assignAnchorSlots(address planter, uint16 count)
        external
        onlyRoleHolder(OPERATOR_ROLE)
        inStatus(CampaignStatus.Active)
    {
        if (planter == address(0)) revert ZeroAddress();
        if (count == 0) revert ZeroAmount();

        uint256 available = availableAnchorSlots();
        if (count > available) revert NotEnoughSlots(count, available);

        uint256 fromAnchor = anchorSlots - anchorAssigned;
        if (fromAnchor > count) fromAnchor = count;
        if (fromAnchor > 0) {
            uint256 first = uint256(anchorAssigned) + 1;
            for (uint256 slotId = first; slotId < first + fromAnchor; ++slotId) {
                slotOwner[slotId] = planter;
            }
            // casting to 'uint32' is safe because fromAnchor <= count, a uint16
            // forge-lint: disable-next-line(unsafe-typecast)
            anchorAssigned += uint32(fromAnchor);
            emit AnchorSlotsAssigned(planter, first, fromAnchor);
        }

        uint256 fromOpen = count - fromAnchor;
        if (fromOpen > 0) {
            uint256 first = _takeOpen(planter, fromOpen);
            emit AnchorSlotsAssigned(planter, first, fromOpen);
        }
    }

    /// @notice Open slots still claimable by planters (zero after the claim deadline).
    function availableOpenSlots() public view returns (uint256) {
        if (block.timestamp >= _config.claimDeadline) return 0;
        return openSlots - openAssigned;
    }

    /// @notice Slots an operator can assign now: unassigned anchor slots, plus unclaimed open slots after the claim deadline.
    function availableAnchorSlots() public view returns (uint256 available) {
        available = anchorSlots - anchorAssigned;
        if (block.timestamp >= _config.claimDeadline) available += openSlots - openAssigned;
    }

    /// @notice True if a slot id is in the anchor range.
    /// @param slotId The slot id.
    function isAnchorSlot(uint256 slotId) external view returns (bool) {
        return slotId >= 1 && slotId <= anchorSlots;
    }

    /// @dev Hands out the next `count` open slots to `planter` and returns the first slot id.
    function _takeOpen(address planter, uint256 count) internal returns (uint256 first) {
        first = uint256(anchorSlots) + openAssigned + 1;
        for (uint256 slotId = first; slotId < first + count; ++slotId) {
            slotOwner[slotId] = planter;
        }
        // casting to 'uint32' is safe because callers pass at most a uint16 count
        // forge-lint: disable-next-line(unsafe-typecast)
        openAssigned += uint32(count);
    }

    // =======================================================================
    // Hooks
    // =======================================================================

    /// @inheritdoc ICampaign
    /// @dev Requires an Active campaign, a slot owned by `planter`, and a slot not yet planted.
    function onTreePlanted(uint256 slotId, uint256 treeId, address planter)
        external
        onlyTreeRegistry
        inStatus(CampaignStatus.Active)
    {
        if (slotId == 0 || slotId > _config.treeTarget) revert InvalidSlot(slotId);
        if (slotOwner[slotId] != planter) revert SlotNotOwned(slotId, planter);
        if (slotTree[slotId] != 0) revert SlotAlreadyPlanted(slotId);

        slotTree[slotId] = treeId;
        plantedCount += 1;
        // casting to 'uint64' is safe because block timestamps fit in 64 bits for billions of years
        // forge-lint: disable-next-line(unsafe-typecast)
        if (block.timestamp > lastPlantedAt) lastPlantedAt = uint64(block.timestamp);
        emit SlotPlanted(slotId, treeId, planter);
    }

    /// @inheritdoc ICampaign
    /// @dev Gateway only. The tree must be Alive (flagged and dead trees are not paid), the planter must match,
    ///      the milestone must be unsettled, and now must be inside [opensAt, closesAt].
    function releaseMilestone(uint256 treeId, uint8 milestone, address planter) external nonReentrant onlyGateway {
        Tree memory tree = _treeOf(treeId);
        if (tree.status != TreeStatus.Alive) revert WrongTreeStatus(treeId, tree.status);
        if (planter != tree.planter) revert WrongPlanter(treeId, planter);
        _requireUnsettled(treeId, milestone);

        (uint256 opensAt, uint256 closesAt) = _window(tree, milestone);
        if (block.timestamp < opensAt || block.timestamp > closesAt) {
            revert MilestoneNotOpen(treeId, milestone, opensAt, closesAt);
        }

        uint256 amount = _milestoneAmount(milestone);
        paidMask[treeId] |= uint8(1 << milestone);
        totalPaid += amount;
        emit MilestonePaid(treeId, milestone, planter, amount);

        usdc.safeTransfer(planter, amount);
    }

    /// @inheritdoc ICampaign
    /// @dev Reverts while the tree is Flagged: flags freeze the clock (PRODUCT_KNOWLEDGE.md section 15, rule 2).
    function forfeitMilestone(uint256 treeId, uint8 milestone) external {
        Tree memory tree = _treeOf(treeId);
        if (tree.status == TreeStatus.Flagged) revert TreeFrozen(treeId);
        _requireUnsettled(treeId, milestone);

        (, uint256 closesAt) = _window(tree, milestone);
        if (block.timestamp <= closesAt) revert MilestoneWindowNotClosed(treeId, milestone, closesAt);

        _forfeit(treeId, milestone);
    }

    /// @inheritdoc ICampaign
    function onTreeRemoved(uint256 treeId) external onlyTreeRegistry {
        uint8 settled = paidMask[treeId] | forfeitedMask[treeId];
        for (uint8 milestone = 0; milestone < C.MILESTONE_COUNT; ++milestone) {
            if (settled & (1 << milestone) == 0) _forfeit(treeId, milestone);
        }
        settledCount += 1;
    }

    /// @inheritdoc ICampaign
    function onTreeCompleted(uint256) external onlyTreeRegistry {
        settledCount += 1;
    }

    /// @notice Sends part of the replacement reserve to the treasury to pay for replanting a tree.
    /// @dev Operator only, while Active. The seedling purchase itself is tracked off-chain in the MVP.
    /// @param treeId The tree being replanted. Must belong to this campaign.
    /// @param amount USDC base units to draw.
    function drawReserve(uint256 treeId, uint256 amount)
        external
        nonReentrant
        onlyRoleHolder(OPERATOR_ROLE)
        inStatus(CampaignStatus.Active)
    {
        _treeOf(treeId);
        if (amount == 0) revert ZeroAmount();
        uint256 available = reserveAmount - reserveDrawn;
        if (amount > available) revert ReserveExceeded(amount, available);

        reserveDrawn += amount;
        address treasury = roles.treasury();
        emit ReserveDrawn(treeId, treasury, amount);
        usdc.safeTransfer(treasury, amount);
    }

    // =======================================================================
    // Views
    // =======================================================================

    /// @inheritdoc ICampaign
    function config() external view returns (CampaignConfig memory) {
        return _config;
    }

    /// @inheritdoc ICampaign
    function timeUnit() external view returns (uint64) {
        return _config.timeUnit;
    }

    /// @inheritdoc ICampaign
    function contributorCount() external view returns (uint256) {
        return _contributors.length;
    }

    /// @inheritdoc ICampaign
    function contributorAt(uint256 index) external view returns (address) {
        return _contributors[index];
    }

    /// @notice All contributors, in first-contribution order.
    function contributors() external view returns (address[] memory) {
        return _contributors;
    }

    /// @notice USDC paid for one milestone of one tree.
    /// @dev Milestones 0 to 4 pay perTreeIncentive * share / BPS. Milestone 5 pays the per-tree remainder.
    /// @param milestone Milestone index 0 to 5.
    function milestoneAmount(uint8 milestone) external view returns (uint256) {
        if (milestone >= C.MILESTONE_COUNT) revert InvalidMilestone(milestone);
        return _milestoneAmount(milestone);
    }

    /// @notice The acceptance window of a milestone for a tree, including any flag pause offset.
    /// @param treeId A tree of this campaign.
    /// @param milestone Milestone index 0 to 5.
    /// @return opensAt First second the milestone can be paid.
    /// @return closesAt Last second the milestone can be paid.
    function milestoneWindow(uint256 treeId, uint8 milestone)
        external
        view
        returns (uint256 opensAt, uint256 closesAt)
    {
        return _window(_treeOf(treeId), milestone);
    }

    /// @notice True if a milestone of a tree was paid.
    /// @param treeId The tree id.
    /// @param milestone Milestone index 0 to 5.
    function isMilestonePaid(uint256 treeId, uint8 milestone) external view returns (bool) {
        if (milestone >= C.MILESTONE_COUNT) revert InvalidMilestone(milestone);
        return paidMask[treeId] & (1 << milestone) != 0;
    }

    /// @inheritdoc ICampaign
    function allMilestonesSettled(uint256 treeId) external view returns (bool) {
        return (paidMask[treeId] | forfeitedMask[treeId]) == C.ALL_MILESTONES_MASK;
    }

    /// @notice Incentives still owed to planted trees that are not settled. Upper bound, ignoring future forfeits.
    function unpaidCommittedIncentives() external view returns (uint256) {
        // Each planted tree commits perTreeIncentive. Settled milestones leave the commitment via totalPaid or forfeitedPool.
        return uint256(plantedCount) * perTreeIncentive - totalPaid - forfeitedPool;
    }

    // =======================================================================
    // Internals
    // =======================================================================

    function _activate() internal {
        CampaignConfig storage cfg = _config;
        uint256 target = cfg.fundingTarget;

        uint256 incentives = (target * cfg.split.incentivesBps) / C.BPS;
        uint256 seedlings = (target * cfg.split.seedlingsBps) / C.BPS;
        uint256 verification = (target * cfg.split.verificationBps) / C.BPS;
        uint256 fee = (target * cfg.split.feeBps) / C.BPS;

        status = CampaignStatus.Active;
        // casting to 'uint64' is safe because block timestamps fit in 64 bits for billions of years
        // forge-lint: disable-next-line(unsafe-typecast)
        activatedAt = uint64(block.timestamp);
        incentivePool = incentives;
        reserveAmount = target - incentives - seedlings - verification - fee;
        perTreeIncentive = incentives / cfg.treeTarget;
        incentiveDust = incentives - perTreeIncentive * cfg.treeTarget;

        address treasury = roles.treasury();
        emit Activated(block.timestamp, incentives, perTreeIncentive, reserveAmount);
        emit BucketsReleased(treasury, seedlings, verification, fee);

        uint256 toTreasury = seedlings + verification + fee;
        if (toTreasury > 0) usdc.safeTransfer(treasury, toTreasury);
    }

    /// @dev Amount for a milestone index already known to be < MILESTONE_COUNT.
    function _milestoneAmount(uint8 milestone) internal view returns (uint256) {
        if (milestone < C.MILESTONE_COUNT - 1) {
            return (perTreeIncentive * C.unpack(C.MILESTONE_SHARES_PACKED, milestone)) / C.BPS;
        }
        uint256 earlier = 0;
        for (uint8 i = 0; i < C.MILESTONE_COUNT - 1; ++i) {
            earlier += (perTreeIncentive * C.unpack(C.MILESTONE_SHARES_PACKED, i)) / C.BPS;
        }
        return perTreeIncentive - earlier;
    }

    function _forfeit(uint256 treeId, uint8 milestone) internal {
        uint256 amount = _milestoneAmount(milestone);
        forfeitedMask[treeId] |= uint8(1 << milestone);
        forfeitedPool += amount;
        emit MilestoneForfeited(treeId, milestone, amount);
    }

    function _treeOf(uint256 treeId) internal view returns (Tree memory tree) {
        tree = treeRegistry.getTree(treeId);
        if (tree.campaign != address(this)) revert TreeNotInCampaign(treeId);
    }

    function _requireUnsettled(uint256 treeId, uint8 milestone) internal view {
        if (milestone >= C.MILESTONE_COUNT) revert InvalidMilestone(milestone);
        if ((paidMask[treeId] | forfeitedMask[treeId]) & (1 << milestone) != 0) {
            revert MilestoneAlreadySettled(treeId, milestone);
        }
    }

    function _window(Tree memory tree, uint8 milestone) internal view returns (uint256 opensAt, uint256 closesAt) {
        uint256 unit = _config.timeUnit;
        opensAt = uint256(tree.plantedAt) + tree.pausedDuration + uint256(C.milestoneDueUnits(milestone)) * unit;
        closesAt = opensAt + unit;
    }
}
