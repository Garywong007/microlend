// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ILendingPool} from "./interfaces/ILendingPool.sol";

/// @title LendingPool
/// @notice Transparent liquidity pool funded by lenders. Lenders hold shares; the share price rises
///         as interest is repaid and falls when loans default and losses exceed the reserve.
///
///  Accounting (all in asset units):
///      cash            = asset.balanceOf(pool)
///      lenderAssets    = cash - reserve + outstandingPrincipal
///      share price     = lenderAssets / totalShares
///
///  Loss waterfall for a defaulted loan (orchestrated by LoanManager):
///      1. collateral seized (vault) -> repays interest first, then principal
///      2. remaining principal loss is absorbed by `reserve`
///      3. whatever is left reduces lenderAssets, i.e. is shared pro-rata by all lenders
contract LendingPool is AccessControl, Pausable, ReentrancyGuard, ILendingPool {
    using SafeERC20 for IERC20;

    bytes32 public constant LOAN_MANAGER_ROLE = keccak256("LOAN_MANAGER_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    /// @dev Shares permanently locked by the first depositor to make share-price inflation attacks uneconomic.
    uint256 public constant MINIMUM_SHARES = 1000;
    uint16 public constant MAX_RESERVE_BPS = 5000;

    IERC20 public immutable asset;

    uint256 public totalShares;
    mapping(address => uint256) public sharesOf;

    uint256 public outstandingPrincipal;
    uint256 public reserve;
    uint256 public totalInterestEarned;
    uint256 public totalLosses;

    /// @notice Share of every interest payment that is diverted to the reserve (basis points).
    uint16 public reserveBps = 1000;
    /// @notice Maximum outstanding principal as a share of lenderAssets (basis points).
    uint16 public maxUtilizationBps = 9000;

    event Deposited(address indexed lender, uint256 assets, uint256 shares);
    event Withdrawn(address indexed lender, uint256 assets, uint256 shares);
    event Disbursed(address indexed to, uint256 amount);
    event RepaymentRecorded(uint256 principal, uint256 interest, uint256 toReserve);
    event LossRecorded(uint256 principalLost, uint256 reserveCovered, uint256 lenderLoss);
    event ReserveFunded(address indexed funder, uint256 amount);
    event ReserveBpsSet(uint16 bps);
    event MaxUtilizationSet(uint16 bps);

    error ZeroAmount();
    error ZeroShares();
    error InvalidShares();
    error PoolInsolvent();
    error InsufficientLiquidity(uint256 requested, uint256 available);
    error UtilizationTooHigh();
    error AccountingMismatch();
    error InvalidBps();

    constructor(address asset_, address admin) {
        asset = IERC20(asset_);
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(PAUSER_ROLE, admin);
    }

    // ---------------------------------------------------------------------
    // Lenders
    // ---------------------------------------------------------------------

    /// @notice Deposit `amount` of the asset and receive pool shares. (tx type: deposit)
    function deposit(uint256 amount) external whenNotPaused nonReentrant returns (uint256 shares) {
        if (amount == 0) revert ZeroAmount();
        uint256 assetsBefore = lenderAssets();

        if (totalShares == 0) {
            if (amount <= MINIMUM_SHARES) revert ZeroShares();
            shares = amount - MINIMUM_SHARES;
            totalShares = MINIMUM_SHARES; // locked forever, owned by nobody
        } else {
            if (assetsBefore == 0) revert PoolInsolvent();
            shares = (amount * totalShares) / assetsBefore;
        }
        if (shares == 0) revert ZeroShares();

        totalShares += shares;
        sharesOf[msg.sender] += shares;
        asset.safeTransferFrom(msg.sender, address(this), amount);
        emit Deposited(msg.sender, amount, shares);
    }

    /// @notice Burn `shares` and receive the corresponding assets, if enough idle liquidity exists.
    ///         Remains available while the pool is paused. (tx type: withdraw)
    function withdraw(uint256 shares) external nonReentrant returns (uint256 assets) {
        if (shares == 0 || shares > sharesOf[msg.sender]) revert InvalidShares();
        assets = (shares * lenderAssets()) / totalShares;
        uint256 liquid = availableLiquidity();
        if (assets > liquid) revert InsufficientLiquidity(assets, liquid);

        sharesOf[msg.sender] -= shares;
        totalShares -= shares;
        asset.safeTransfer(msg.sender, assets);
        emit Withdrawn(msg.sender, assets, shares);
    }

    // ---------------------------------------------------------------------
    // LoanManager hooks
    // ---------------------------------------------------------------------

    /// @inheritdoc ILendingPool
    function disburse(address to, uint256 amount) external onlyRole(LOAN_MANAGER_ROLE) whenNotPaused nonReentrant {
        if (amount == 0) revert ZeroAmount();
        uint256 liquid = availableLiquidity();
        if (amount > liquid) revert InsufficientLiquidity(amount, liquid);
        // lenderAssets is unchanged by a disbursement (cash down, outstanding up)
        if ((outstandingPrincipal + amount) * 10_000 > lenderAssets() * maxUtilizationBps) {
            revert UtilizationTooHigh();
        }
        outstandingPrincipal += amount;
        asset.safeTransfer(to, amount);
        emit Disbursed(to, amount);
    }

    /// @inheritdoc ILendingPool
    function recordRepayment(uint256 principal, uint256 interest) external onlyRole(LOAN_MANAGER_ROLE) {
        if (principal > outstandingPrincipal) revert AccountingMismatch();
        outstandingPrincipal -= principal;

        uint256 cut = (interest * reserveBps) / 10_000;
        reserve += cut;
        totalInterestEarned += interest;

        // The funds must really be in the pool (LoanManager transfers before calling).
        if (asset.balanceOf(address(this)) < reserve) revert AccountingMismatch();
        emit RepaymentRecorded(principal, interest, cut);
    }

    /// @inheritdoc ILendingPool
    function recordLoss(uint256 principalLost) external onlyRole(LOAN_MANAGER_ROLE) returns (uint256 reserveCovered) {
        if (principalLost > outstandingPrincipal) revert AccountingMismatch();
        outstandingPrincipal -= principalLost;

        reserveCovered = principalLost < reserve ? principalLost : reserve;
        reserve -= reserveCovered;
        totalLosses += principalLost;
        emit LossRecorded(principalLost, reserveCovered, principalLost - reserveCovered);
    }

    // ---------------------------------------------------------------------
    // Admin
    // ---------------------------------------------------------------------

    /// @notice Top up the first-loss reserve from the caller's wallet. (tx type: fundReserve)
    function fundReserve(uint256 amount) external onlyRole(DEFAULT_ADMIN_ROLE) nonReentrant {
        if (amount == 0) revert ZeroAmount();
        reserve += amount;
        asset.safeTransferFrom(msg.sender, address(this), amount);
        emit ReserveFunded(msg.sender, amount);
    }

    function setReserveBps(uint16 bps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (bps > MAX_RESERVE_BPS) revert InvalidBps();
        reserveBps = bps;
        emit ReserveBpsSet(bps);
    }

    function setMaxUtilizationBps(uint16 bps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (bps == 0 || bps > 10_000) revert InvalidBps();
        maxUtilizationBps = bps;
        emit MaxUtilizationSet(bps);
    }

    /// @notice Pause deposits and new disbursements (withdrawals and repayments keep working).
    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    function cash() public view returns (uint256) {
        return asset.balanceOf(address(this));
    }

    /// @notice Value that belongs to lenders (excludes the reserve).
    function lenderAssets() public view returns (uint256) {
        return cash() - reserve + outstandingPrincipal;
    }

    /// @notice Idle cash that can be lent out or withdrawn (excludes the reserve).
    function availableLiquidity() public view returns (uint256) {
        uint256 c = cash();
        return c > reserve ? c - reserve : 0;
    }

    function utilizationBps() external view returns (uint256) {
        uint256 la = lenderAssets();
        return la == 0 ? 0 : (outstandingPrincipal * 10_000) / la;
    }

    /// @notice Asset value of one whole share scaled by 1e18 (1e18 = 1.0).
    function sharePrice() external view returns (uint256) {
        return totalShares == 0 ? 1e18 : (lenderAssets() * 1e18) / totalShares;
    }

    function convertToShares(uint256 assets) external view returns (uint256) {
        if (totalShares == 0) return assets > MINIMUM_SHARES ? assets - MINIMUM_SHARES : 0;
        uint256 la = lenderAssets();
        return la == 0 ? 0 : (assets * totalShares) / la;
    }

    function convertToAssets(uint256 shares) public view returns (uint256) {
        return totalShares == 0 ? 0 : (shares * lenderAssets()) / totalShares;
    }

    /// @notice Current value of a lender's position.
    function assetsOf(address lender) external view returns (uint256) {
        return convertToAssets(sharesOf[lender]);
    }

    /// @notice What the lender could withdraw right now, given pool liquidity.
    function maxWithdrawable(address lender) external view returns (uint256) {
        uint256 value = convertToAssets(sharesOf[lender]);
        uint256 liquid = availableLiquidity();
        return value < liquid ? value : liquid;
    }
}
