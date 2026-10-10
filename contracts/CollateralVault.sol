// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ICollateralVault} from "./interfaces/ICollateralVault.sol";

/// @title CollateralVault
/// @notice Escrows the small security deposits that back each loan. Collateral requirements are
///         risk-based (see CreditRegistry tiers) and shrink to zero for borrowers with a proven record.
///         Only the LoanManager can move funds, and only along three paths: lock, release, seize.
contract CollateralVault is AccessControl, ICollateralVault {
    using SafeERC20 for IERC20;

    bytes32 public constant LOAN_MANAGER_ROLE = keccak256("LOAN_MANAGER_ROLE");

    enum Status {
        None,
        Locked,
        Released,
        Seized
    }

    struct Position {
        address borrower;
        uint256 amount;
        Status status;
    }

    IERC20 public immutable asset;
    mapping(uint256 => Position) public positions;
    /// @notice Sum of all collateral currently in `Locked` state.
    uint256 public totalLocked;

    event CollateralLocked(uint256 indexed loanId, address indexed borrower, uint256 amount);
    event CollateralReleased(uint256 indexed loanId, address indexed borrower, uint256 amount);
    event CollateralSeized(uint256 indexed loanId, address indexed borrower, uint256 seized, uint256 returned);

    error ZeroAmount();
    error AlreadyUsed();
    error NotLocked();
    error NotFunded();

    constructor(address asset_, address admin) {
        asset = IERC20(asset_);
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    /// @inheritdoc ICollateralVault
    function lock(uint256 loanId, address borrower, uint256 amount) external onlyRole(LOAN_MANAGER_ROLE) {
        if (amount == 0) revert ZeroAmount();
        Position storage p = positions[loanId];
        if (p.status != Status.None) revert AlreadyUsed();
        // The manager transfers first; make sure the vault really holds the funds it is about to book.
        if (asset.balanceOf(address(this)) < totalLocked + amount) revert NotFunded();

        p.borrower = borrower;
        p.amount = amount;
        p.status = Status.Locked;
        totalLocked += amount;
        emit CollateralLocked(loanId, borrower, amount);
    }

    /// @inheritdoc ICollateralVault
    function release(uint256 loanId) external onlyRole(LOAN_MANAGER_ROLE) {
        Position storage p = positions[loanId];
        if (p.status != Status.Locked) revert NotLocked();
        p.status = Status.Released;
        totalLocked -= p.amount;
        emit CollateralReleased(loanId, p.borrower, p.amount);
        asset.safeTransfer(p.borrower, p.amount);
    }

    /// @inheritdoc ICollateralVault
    function seize(
        uint256 loanId,
        uint256 maxAmount,
        address to
    ) external onlyRole(LOAN_MANAGER_ROLE) returns (uint256 seized) {
        Position storage p = positions[loanId];
        if (p.status != Status.Locked) revert NotLocked();

        seized = p.amount < maxAmount ? p.amount : maxAmount;
        uint256 remainder = p.amount - seized;

        p.status = Status.Seized;
        totalLocked -= p.amount;

        emit CollateralSeized(loanId, p.borrower, seized, remainder);
        if (seized > 0) asset.safeTransfer(to, seized);
        if (remainder > 0) asset.safeTransfer(p.borrower, remainder);
    }

    /// @inheritdoc ICollateralVault
    function lockedAmount(uint256 loanId) external view returns (uint256) {
        Position storage p = positions[loanId];
        return p.status == Status.Locked ? p.amount : 0;
    }
}
