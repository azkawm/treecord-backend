// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BudgetSplit, InvalidMilestone} from "./TreecordTypes.sol";

/// @title TreecordConstants
/// @notice Protocol defaults from PRODUCT_KNOWLEDGE.md section 3. Mirrored in packages/shared/src/constants.ts.
library TreecordConstants {
    /// @notice Basis point denominator.
    uint256 internal constant BPS = 10_000;

    // Default budget split (sums to BPS).
    uint16 internal constant DEFAULT_INCENTIVES_BPS = 7000;
    uint16 internal constant DEFAULT_SEEDLINGS_BPS = 1000;
    uint16 internal constant DEFAULT_VERIFICATION_BPS = 500;
    uint16 internal constant DEFAULT_RESERVE_BPS = 1000;
    uint16 internal constant DEFAULT_FEE_BPS = 500;

    // Campaign defaults.
    uint16 internal constant DEFAULT_ANCHOR_BPS = 2500;
    uint16 internal constant DEFAULT_PER_PLANTER_CAP = 50;
    uint16 internal constant MIN_COMMITMENT_UNITS = 36;

    /// @notice Time units a dead tree has to be replanted before it can be removed.
    uint64 internal constant REPLANT_UNITS = 2;

    /// @notice Number of incentive milestones per tree.
    uint8 internal constant MILESTONE_COUNT = 6;

    /// @notice Bitmask with one bit set per milestone.
    uint8 internal constant ALL_MILESTONES_MASK = 0x3F;

    /// @notice Decimals of carbon amounts in CarbonLedger (1000 = 1 tCO2e).
    uint8 internal constant CARBON_DECIMALS = 3;

    /// @notice Milestone due times in time units after planting, 16 bits per milestone: 0, 3, 6, 12, 24, 36.
    /// @dev Fixed regardless of commitmentUnits (PRODUCT_KNOWLEDGE.md section 15, rule 11).
    uint256 internal constant MILESTONE_DUE_UNITS_PACKED = (3 << 16) | (6 << 32) | (12 << 48) | (24 << 64) | (36 << 80);

    /// @notice Milestone shares of the per-tree incentive in bps, 16 bits per milestone: 1000, 1000, 1000, 1500, 1500, 4000.
    uint256 internal constant MILESTONE_SHARES_PACKED =
        1000 | (1000 << 16) | (1000 << 32) | (1500 << 48) | (1500 << 64) | (4000 << 80);

    /// @notice Time units after planting at which a milestone becomes due.
    function milestoneDueUnits(uint8 milestone) internal pure returns (uint64) {
        if (milestone >= MILESTONE_COUNT) revert InvalidMilestone(milestone);
        // casting to 'uint64' is safe because each packed entry is masked to 16 bits
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint64(unpack(MILESTONE_DUE_UNITS_PACKED, milestone));
    }

    /// @notice Reads the 16-bit entry at `index` from a packed schedule. Does not bounds-check.
    function unpack(uint256 packed, uint8 index) internal pure returns (uint256) {
        return (packed >> (uint256(index) * 16)) & 0xFFFF;
    }

    /// @notice The default budget split.
    function defaultSplit() internal pure returns (BudgetSplit memory) {
        return BudgetSplit({
            incentivesBps: DEFAULT_INCENTIVES_BPS,
            seedlingsBps: DEFAULT_SEEDLINGS_BPS,
            verificationBps: DEFAULT_VERIFICATION_BPS,
            reserveBps: DEFAULT_RESERVE_BPS,
            feeBps: DEFAULT_FEE_BPS
        });
    }
}
