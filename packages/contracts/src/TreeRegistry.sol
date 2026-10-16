// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {RoleGated, TreecordRoles} from "./TreecordRoles.sol";
import {ICampaign} from "./interfaces/ICampaign.sol";
import {ICampaignFactory} from "./interfaces/ICampaignFactory.sol";
import {ITreeRegistry} from "./interfaces/ITreeRegistry.sol";
import {TreecordConstants as C} from "./libraries/TreecordConstants.sol";
import {
    RemovalReason,
    Tree,
    TreeStatus,
    InvalidSlot,
    MilestonesNotSettled,
    NotContributor,
    ReplantDeadlineNotPassed,
    ReplantDeadlinePassed,
    Unauthorized,
    UnknownCampaign,
    UnknownTree,
    WrongTreeStatus,
    ZeroAddress
} from "./libraries/TreecordTypes.sol";

/// @title TreeRegistry
/// @notice Global registry of every planted tree: identity, health, check-ins and flags.
/// @dev Tree ids are global and sequential, starting at 1. Money moves only in Campaign: this contract calls
///      back into the tree's campaign when a tree is planted, removed or completed.
///
///      Flags freeze the clock (PRODUCT_KNOWLEDGE.md section 15, rules 2 and 3). A tree can be flagged while
///      Alive or Dead. While Flagged, payouts, forfeits and dead-tree expiry are blocked. On dismissal the
///      flagged duration is added to `pausedDuration`, which shifts every milestone window, and to the replant
///      deadline if the tree was Dead.
contract TreeRegistry is ITreeRegistry, RoleGated {
    /// @notice Number of trees registered. Also the latest tree id.
    uint256 public treeCount;

    mapping(uint256 treeId => Tree tree) internal _trees;

    /// @inheritdoc ITreeRegistry
    mapping(address campaign => mapping(uint256 slotId => uint256 treeId)) public treeOfSlot;

    /// @notice Address that raised the current or most recent flag on a tree.
    mapping(uint256 treeId => address flagger) public flaggerOf;

    /// @param roles_ Central role registry.
    constructor(TreecordRoles roles_) RoleGated(roles_) {}

    /// @inheritdoc ITreeRegistry
    /// @dev Gateway only. The campaign must come from the factory. Slot ownership and the not-yet-planted check
    ///      are enforced by the campaign in `onTreePlanted`.
    function registerTree(address campaign, uint256 slotId, address planter, bytes8 geohash, bytes32 evidenceHash)
        external
        onlyGateway
        returns (uint256 treeId)
    {
        if (!ICampaignFactory(roles.factory()).isCampaign(campaign)) revert UnknownCampaign(campaign);
        if (planter == address(0)) revert ZeroAddress();
        if (slotId == 0 || slotId > type(uint32).max) revert InvalidSlot(slotId);

        treeId = ++treeCount;
        uint64 plantedAt = _now64();
        _trees[treeId] = Tree({
            campaign: campaign,
            // casting to 'uint32' is safe because slotId was checked against type(uint32).max above
            // forge-lint: disable-next-line(unsafe-typecast)
            slotId: uint32(slotId),
            status: TreeStatus.Alive,
            statusBeforeFlag: TreeStatus.None,
            planter: planter,
            plantedAt: plantedAt,
            checkInCount: 0,
            geohash: geohash,
            replantDeadline: 0,
            flaggedAt: 0,
            pausedDuration: 0,
            latestEvidenceHash: evidenceHash
        });
        treeOfSlot[campaign][slotId] = treeId;
        emit TreePlanted(treeId, campaign, slotId, planter, geohash, evidenceHash, plantedAt);

        ICampaign(campaign).onTreePlanted(slotId, treeId, planter);
    }

    /// @inheritdoc ITreeRegistry
    /// @dev Gateway only. The tree must be Alive.
    function recordCheckIn(uint256 treeId, bytes32 evidenceHash) external onlyGateway {
        Tree storage tree = _requireStatus(treeId, TreeStatus.Alive);
        tree.checkInCount += 1;
        tree.latestEvidenceHash = evidenceHash;
        emit CheckInRecorded(treeId, evidenceHash, tree.checkInCount);
    }

    /// @inheritdoc ITreeRegistry
    /// @dev Gateway or operator. The tree must be Alive. Replant deadline = now + REPLANT_UNITS time units.
    function markDead(uint256 treeId, bytes32 evidenceHash) external {
        if (msg.sender != roles.gateway() && !_isOperator(msg.sender)) revert Unauthorized(msg.sender);
        Tree storage tree = _requireStatus(treeId, TreeStatus.Alive);

        uint64 deadline = _now64() + C.REPLANT_UNITS * ICampaign(tree.campaign).timeUnit();
        tree.status = TreeStatus.Dead;
        tree.replantDeadline = deadline;
        tree.latestEvidenceHash = evidenceHash;
        emit TreeDied(treeId, evidenceHash, deadline);
    }

    /// @inheritdoc ITreeRegistry
    /// @dev Gateway only. The tree must be Dead and the replant deadline not passed. The milestone schedule
    ///      continues from the original planting time.
    function markReplanted(uint256 treeId, bytes32 evidenceHash) external onlyGateway {
        Tree storage tree = _requireStatus(treeId, TreeStatus.Dead);
        if (block.timestamp > tree.replantDeadline) revert ReplantDeadlinePassed(treeId, tree.replantDeadline);

        tree.status = TreeStatus.Alive;
        tree.replantDeadline = 0;
        tree.latestEvidenceHash = evidenceHash;
        emit TreeReplanted(treeId, evidenceHash);
    }

    /// @inheritdoc ITreeRegistry
    /// @dev Anyone, once a Dead tree's replant deadline has passed. A flagged dead tree cannot expire.
    function expireDead(uint256 treeId) external {
        Tree storage tree = _requireStatus(treeId, TreeStatus.Dead);
        if (block.timestamp <= tree.replantDeadline) revert ReplantDeadlineNotPassed(treeId, tree.replantDeadline);
        _remove(treeId, tree, RemovalReason.ReplantExpired);
    }

    /// @inheritdoc ITreeRegistry
    /// @dev The caller must have contributed to the tree's campaign. Allowed while Alive or Dead. A Flagged
    ///      status means a flag is already active, so a second flag reverts.
    function flag(uint256 treeId, bytes32 reasonHash) external {
        Tree storage tree = _getTree(treeId);
        if (tree.status != TreeStatus.Alive && tree.status != TreeStatus.Dead) {
            revert WrongTreeStatus(treeId, tree.status);
        }
        if (ICampaign(tree.campaign).contributions(msg.sender) == 0) revert NotContributor(msg.sender);

        tree.statusBeforeFlag = tree.status;
        tree.status = TreeStatus.Flagged;
        tree.flaggedAt = _now64();
        flaggerOf[treeId] = msg.sender;
        emit TreeFlagged(treeId, msg.sender, reasonHash);
    }

    /// @inheritdoc ITreeRegistry
    /// @dev Operator only. Uphold removes the tree. Dismiss restores the previous status and adds the flagged
    ///      duration to the tree's pause offset (and to its replant deadline if it was Dead).
    function resolveFlag(uint256 treeId, bool uphold, bytes32 noteHash) external onlyRoleHolder(OPERATOR_ROLE) {
        Tree storage tree = _requireStatus(treeId, TreeStatus.Flagged);
        uint64 paused = _now64() - tree.flaggedAt;
        tree.flaggedAt = 0;

        if (uphold) {
            emit FlagResolved(treeId, true, noteHash, 0);
            _remove(treeId, tree, RemovalReason.FlagUpheld);
            return;
        }

        tree.status = tree.statusBeforeFlag;
        tree.statusBeforeFlag = TreeStatus.None;
        tree.pausedDuration += paused;
        if (tree.status == TreeStatus.Dead) tree.replantDeadline += paused;
        emit FlagResolved(treeId, false, noteHash, paused);
    }

    /// @inheritdoc ITreeRegistry
    /// @dev Anyone. The tree must be Alive and every milestone paid or forfeited in its campaign.
    function markCompleted(uint256 treeId) external {
        Tree storage tree = _requireStatus(treeId, TreeStatus.Alive);
        if (!ICampaign(tree.campaign).allMilestonesSettled(treeId)) revert MilestonesNotSettled(treeId);

        tree.status = TreeStatus.Completed;
        emit TreeCompleted(treeId);
        ICampaign(tree.campaign).onTreeCompleted(treeId);
    }

    /// @inheritdoc ITreeRegistry
    function getTree(uint256 treeId) external view returns (Tree memory) {
        return _trees[treeId];
    }

    /// @notice Current status of a tree (None for unknown ids).
    /// @param treeId The tree id.
    function statusOf(uint256 treeId) external view returns (TreeStatus) {
        return _trees[treeId].status;
    }

    function _remove(uint256 treeId, Tree storage tree, RemovalReason reason) internal {
        tree.status = TreeStatus.Removed;
        tree.replantDeadline = 0;
        emit TreeRemoved(treeId, reason);
        ICampaign(tree.campaign).onTreeRemoved(treeId);
    }

    function _now64() internal view returns (uint64) {
        // casting to 'uint64' is safe because block timestamps fit in 64 bits for billions of years
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint64(block.timestamp);
    }

    function _getTree(uint256 treeId) internal view returns (Tree storage tree) {
        tree = _trees[treeId];
        if (tree.status == TreeStatus.None) revert UnknownTree(treeId);
    }

    function _requireStatus(uint256 treeId, TreeStatus expected) internal view returns (Tree storage tree) {
        tree = _getTree(treeId);
        if (tree.status != expected) revert WrongTreeStatus(treeId, tree.status);
    }
}
