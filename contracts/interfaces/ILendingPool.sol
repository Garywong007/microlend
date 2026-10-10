// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Functions of the LendingPool that the LoanManager calls.
interface ILendingPool {
    function availableLiquidity() external view returns (uint256);

    /// @notice Send `amount` of the pool asset to `to` and book it as outstanding principal.
    function disburse(address to, uint256 amount) external;

    /// @notice Book a repayment that has ALREADY been transferred to the pool.
    function recordRepayment(uint256 principal, uint256 interest) external;

    /// @notice Write off unrecoverable principal. Reserve absorbs first, lenders the rest.
    /// @return reserveCovered Amount of the loss absorbed by the reserve.
    function recordLoss(uint256 principalLost) external returns (uint256 reserveCovered);
}
