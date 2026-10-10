// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Functions of the CollateralVault that the LoanManager calls.
interface ICollateralVault {
    /// @notice Register collateral that has ALREADY been transferred to the vault.
    function lock(uint256 loanId, address borrower, uint256 amount) external;

    /// @notice Return the full collateral of a loan to its borrower.
    function release(uint256 loanId) external;

    /// @notice Send up to `maxAmount` of the collateral to `to`; any remainder goes back to the borrower.
    /// @return seized Amount actually sent to `to`.
    function seize(uint256 loanId, uint256 maxAmount, address to) external returns (uint256 seized);

    function lockedAmount(uint256 loanId) external view returns (uint256);
}
