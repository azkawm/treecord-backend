// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {RemovalReason, Tree} from "../libraries/TreecordTypes.sol";

/// @title ITreeRegistry
/// @notice Global registry of planted trees and their health, check-ins and flags.
interface ITreeRegistry {
    /// @notice A tree was registered from a verified PLANTED attestation.
    event TreePlanted(
        uint256 indexed treeId,
        address indexed campaign,
        uint256 indexed slotId,
        address planter,
        bytes8 geohash,
        bytes32 evidenceHash,
        uint64 plantedAt
    );
    /// @notice A verified ALIVE check-in was recorded.
    event CheckInRecorded(uint256 indexed treeId, bytes32 evidenceHash, uint32 checkInCount);
    /// @notice A tree was marked dead. It can be replanted until `replantDeadline`.
    event TreeDied(uint256 indexed treeId, bytes32 evidenceHash, uint64 replantDeadline);
    /// @notice A dead tree was replanted and is Alive again.
    event TreeReplanted(uint256 indexed treeId, bytes32 evidenceHash);
    /// @notice A tree was removed. Its unpaid incentives returned to the campaign pool.
    event TreeRemoved(uint256 indexed treeId, RemovalReason reason);
    /// @notice A contributor flagged a tree. Payouts are paused until the flag is resolved.
    event TreeFlagged(uint256 indexed treeId, address indexed flagger, bytes32 reasonHash);
    /// @notice An operator resolved a flag. `pausedSeconds` is added to the tree's schedule when dismissed.
    event FlagResolved(uint256 indexed treeId, bool upheld, bytes32 noteHash, uint64 pausedSeconds);
    /// @notice Every milestone of the tree is settled.
    event TreeCompleted(uint256 indexed treeId);

    /// @notice Registers a tree for a claimed slot. Only callable by the VerificationGateway.
    function registerTree(address campaign, uint256 slotId, address planter, bytes8 geohash, bytes32 evidenceHash)
        external
        returns (uint256 treeId);

    /// @notice Records an ALIVE check-in. Only callable by the VerificationGateway.
    function recordCheckIn(uint256 treeId, bytes32 evidenceHash) external;

    /// @notice Marks a tree dead. Callable by the VerificationGateway or an operator.
    function markDead(uint256 treeId, bytes32 evidenceHash) external;

    /// @notice Marks a dead tree replanted. Only callable by the VerificationGateway.
    function markReplanted(uint256 treeId, bytes32 evidenceHash) external;

    /// @notice Removes a dead tree whose replant deadline passed. Callable by anyone.
    function expireDead(uint256 treeId) external;

    /// @notice Flags a tree. Only contributors of the tree's campaign can flag.
    function flag(uint256 treeId, bytes32 reasonHash) external;

    /// @notice Resolves an active flag. Only callable by an operator.
    function resolveFlag(uint256 treeId, bool uphold, bytes32 noteHash) external;

    /// @notice Marks an Alive tree completed once every milestone is settled. Callable by anyone.
    function markCompleted(uint256 treeId) external;

    /// @notice The full tree record. Returns an empty record (status None) for unknown ids.
    function getTree(uint256 treeId) external view returns (Tree memory);

    /// @notice The tree planted in a campaign slot, or zero.
    function treeOfSlot(address campaign, uint256 slotId) external view returns (uint256);
}
