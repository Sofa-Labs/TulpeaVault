// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title TrancheTypes
 * @notice Shared library for tranche-related data structures
 * @dev Used across PortfolioMaster, PortfolioNFT, and PropertyVault contracts
 *
 * TRANCHE WATERFALL ORDER (CRITICAL - DO NOT MODIFY):
 * - SENIOR (0): First to receive repayments, lowest risk, lowest yield
 * - MEZZANINE (1): Second priority, medium risk, medium yield
 * - JUNIOR (2): Last priority, highest risk, highest yield
 *
 * The enum values MUST remain in this order as waterfall logic depends on it.
 */
library TrancheTypes {
    /**
     * @notice Tranche type enum - defines risk/yield tiers
     * @dev CRITICAL: Enum values determine waterfall priority
     *      SENIOR=0 gets paid first, JUNIOR=2 gets paid last
     */
    enum TrancheType {
        SENIOR,     // 0 - First priority, lowest risk/yield
        MEZZANINE,  // 1 - Second priority, medium risk/yield
        JUNIOR      // 2 - Last priority, highest risk/yield
    }

    /**
     * @notice Configuration for a single tranche within a property
     * @dev Each property can have up to 3 tranches (Senior, Mezzanine, Junior)
     *
     * @param trancheType Which tranche this config is for (SENIOR, MEZZANINE, JUNIOR)
     * @param targetBps Target percentage of property funding in basis points (e.g., 7000 = 70%)
     * @param yieldCapBps Maximum total yield over lock period in basis points (e.g., 4000 = 40%)
     * @param annualYieldBps Annual yield rate in basis points (e.g., 800 = 8% annual)
     * @param currentDeposits Current total USDT deposited in this tranche
     * @param maxCapacity Maximum USDT this tranche can accept (calculated from targetBps * propertyPrice)
     */
    struct TrancheConfig {
        TrancheType trancheType;
        uint256 targetBps;
        uint256 yieldCapBps;
        uint256 annualYieldBps;
        uint256 currentDeposits;
        uint256 maxCapacity;
    }

    /**
     * @notice Maximum basis points (100%)
     */
    uint256 constant BPS_DENOMINATOR = 10000;

    /**
     * @notice Number of tranche types
     */
    uint256 constant NUM_TRANCHES = 3;

    /**
     * @notice Validate that a TrancheType value is valid
     * @param tranche The tranche type to validate
     * @return valid True if the tranche type is valid
     */
    function isValidTranche(TrancheType tranche) internal pure returns (bool valid) {
        // Enum values are 0, 1, 2 - anything else would revert on cast
        // This function provides explicit validation
        return uint8(tranche) <= uint8(TrancheType.JUNIOR);
    }

    /**
     * @notice Get the next tranche in the waterfall (for repayment distribution)
     * @param current The current tranche
     * @return next The next tranche in waterfall order (or JUNIOR if already at JUNIOR)
     * @return hasNext True if there is a next tranche
     */
    function getNextTranche(TrancheType current) internal pure returns (TrancheType next, bool hasNext) {
        if (current == TrancheType.SENIOR) {
            return (TrancheType.MEZZANINE, true);
        } else if (current == TrancheType.MEZZANINE) {
            return (TrancheType.JUNIOR, true);
        } else {
            return (TrancheType.JUNIOR, false);
        }
    }

    /**
     * @notice Get tranche priority (lower = higher priority)
     * @param tranche The tranche type
     * @return priority Priority value (0 = highest, 2 = lowest)
     */
    function getTranchePriority(TrancheType tranche) internal pure returns (uint256 priority) {
        return uint256(tranche);
    }

    /**
     * @notice Check if tranche A has higher repayment priority than tranche B
     * @param a First tranche
     * @param b Second tranche
     * @return True if A has higher priority (gets paid first)
     */
    function hasHigherPriority(TrancheType a, TrancheType b) internal pure returns (bool) {
        return uint256(a) < uint256(b);
    }
}
