// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Read/write surface of the CreditRegistry that other contracts depend on.
interface ICreditRegistry {
    /// @dev Borrowing terms derived from a borrower's current credit standing.
    struct Terms {
        uint8 tier;
        uint256 maxAmount;
        uint16 aprBps;
        uint16 collateralBps;
        uint16 effectiveScore;
        bool blocked;
    }

    function getTerms(address borrower) external view returns (Terms memory);

    function recordLoanClosed(
        address borrower,
        uint256 principal,
        uint256 totalRepaid,
        bool onTime,
        bool defaulted
    ) external;
}
