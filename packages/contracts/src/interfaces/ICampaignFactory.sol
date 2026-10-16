// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {CampaignConfig} from "../libraries/TreecordTypes.sol";

/// @title ICampaignFactory
/// @notice Deploys campaigns as minimal proxy clones and records which addresses are genuine campaigns.
interface ICampaignFactory {
    /// @notice A campaign clone was deployed and initialized.
    event CampaignCreated(address indexed campaign, address indexed creator, CampaignConfig config);

    /// @notice Validates `cfg`, deploys a campaign clone, and initializes it.
    function createCampaign(CampaignConfig calldata cfg) external returns (address campaign);

    /// @notice True if `campaign` was deployed by this factory.
    function isCampaign(address campaign) external view returns (bool);

    /// @notice Number of campaigns deployed.
    function campaignCount() external view returns (uint256);

    /// @notice Campaign at an index, in creation order.
    function campaignAt(uint256 index) external view returns (address);
}
