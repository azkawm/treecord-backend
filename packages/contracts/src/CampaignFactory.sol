// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";

import {RoleGated, TreecordRoles} from "./TreecordRoles.sol";
import {ICampaign} from "./interfaces/ICampaign.sol";
import {ICampaignFactory} from "./interfaces/ICampaignFactory.sol";
import {TreecordConstants as C} from "./libraries/TreecordConstants.sol";
import {
    CampaignConfig,
    CommitmentTooShort,
    InvalidAnchorBps,
    InvalidDeadlines,
    InvalidFundingTarget,
    InvalidPerPlanterCap,
    InvalidSplit,
    InvalidTimeUnit,
    InvalidTreeTarget,
    Unauthorized,
    ZeroAddress
} from "./libraries/TreecordTypes.sol";

/// @title CampaignFactory
/// @notice Validates campaign configs and deploys each campaign as a minimal proxy clone of one Campaign implementation.
contract CampaignFactory is ICampaignFactory, RoleGated {
    /// @notice The Campaign implementation every clone delegates to.
    address public immutable implementation;

    /// @inheritdoc ICampaignFactory
    mapping(address campaign => bool deployed) public isCampaign;

    address[] internal _campaigns;

    /// @param roles_ Central role registry.
    /// @param implementation_ Campaign implementation (constructed with the same roles registry).
    constructor(TreecordRoles roles_, address implementation_) RoleGated(roles_) {
        if (implementation_ == address(0)) revert ZeroAddress();
        implementation = implementation_;
    }

    /// @inheritdoc ICampaignFactory
    /// @dev `cfg.creator` must be the caller, unless the caller is an operator creating on a donor's behalf.
    function createCampaign(CampaignConfig calldata cfg) external returns (address campaign) {
        if (cfg.creator != msg.sender && !_isOperator(msg.sender)) revert Unauthorized(msg.sender);
        validateConfig(cfg);

        campaign = Clones.clone(implementation);
        isCampaign[campaign] = true;
        _campaigns.push(campaign);
        // The only external interaction before this event is deploying our own clone, which runs no code.
        // forge-lint: disable-next-line(reentrancy-events)
        emit CampaignCreated(campaign, cfg.creator, cfg);

        ICampaign(campaign).initialize(cfg);
    }

    /// @notice Reverts with a specific error if `cfg` is invalid. Exposed so the backend can preflight a config.
    /// @dev Rules: split sums to 10000, commitment at least 36 units, anchorBps at most 10000, deadlines in the
    ///      future with claimDeadline >= fundingDeadline, treeTarget > 0, timeUnit > 0, perPlanterCap > 0, and a
    ///      funding target large enough that every tree gets a non-zero incentive.
    /// @param cfg The campaign configuration to check.
    function validateConfig(CampaignConfig calldata cfg) public view {
        if (cfg.creator == address(0)) revert ZeroAddress();

        uint256 sum = uint256(cfg.split.incentivesBps) + cfg.split.seedlingsBps + cfg.split.verificationBps
            + cfg.split.reserveBps + cfg.split.feeBps;
        if (sum != C.BPS) revert InvalidSplit(sum);

        if (cfg.commitmentUnits < C.MIN_COMMITMENT_UNITS) {
            revert CommitmentTooShort(cfg.commitmentUnits, C.MIN_COMMITMENT_UNITS);
        }
        if (cfg.anchorBps > C.BPS) revert InvalidAnchorBps(cfg.anchorBps);
        if (cfg.fundingDeadline <= block.timestamp || cfg.claimDeadline < cfg.fundingDeadline) {
            revert InvalidDeadlines();
        }
        if (cfg.treeTarget == 0) revert InvalidTreeTarget();
        if (cfg.timeUnit == 0) revert InvalidTimeUnit();
        if (cfg.perPlanterCap == 0) revert InvalidPerPlanterCap();

        uint256 incentivePool = (cfg.fundingTarget * cfg.split.incentivesBps) / C.BPS;
        if (incentivePool / cfg.treeTarget == 0) revert InvalidFundingTarget();
    }

    /// @inheritdoc ICampaignFactory
    function campaignCount() external view returns (uint256) {
        return _campaigns.length;
    }

    /// @inheritdoc ICampaignFactory
    function campaignAt(uint256 index) external view returns (address) {
        return _campaigns[index];
    }

    /// @notice All campaigns, in creation order.
    function campaigns() external view returns (address[] memory) {
        return _campaigns;
    }
}
