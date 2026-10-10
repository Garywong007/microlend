// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ICreditRegistry} from "./interfaces/ICreditRegistry.sol";
import {ILendingPool} from "./interfaces/ILendingPool.sol";
import {ICollateralVault} from "./interfaces/ICollateralVault.sol";

/// @title LoanManager
/// @notice Loan lifecycle state machine that orchestrates the other three contracts.
///
///   Pending --approve--> Approved --disburse--> Active --repay(full)--> Repaid
///      |                    |                     |
///      |--reject/cancel-----|                     |--markDefault (after due + grace)--> Defaulted
///
///  Roles: DEFAULT_ADMIN_ROLE (admin), OFFICER_ROLE (credit officer: KYC + approval),
///         AUDITOR_ROLE (read-only oversight, can attach audit notes), PAUSER_ROLE.
///  Borrowers and lenders are not roles: any wallet can act as one.
///
///  Pricing: terms (APR, collateral %, limit) come from the borrower's CreditRegistry tier at approval
///  time. Interest is simple, flat for the whole term: principal * apr * termDays / 365.
///  Borrowers approve this contract once for the asset; it pulls collateral and repayments directly.
contract LoanManager is AccessControl, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant OFFICER_ROLE = keccak256("OFFICER_ROLE");
    bytes32 public constant AUDITOR_ROLE = keccak256("AUDITOR_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    uint32 public constant MIN_TERM_DAYS = 7;
    uint32 public constant MAX_TERM_DAYS = 180;
    uint256 public constant GRACE_PERIOD = 7 days;
    uint256 public constant APPROVAL_VALIDITY = 7 days;

    enum Status {
        None,
        Pending,
        Approved,
        Active,
        Repaid,
        Defaulted,
        Rejected,
        Cancelled
    }

    struct Loan {
        address borrower;
        Status status;
        uint8 tier;
        uint16 aprBps;
        uint32 termDays;
        bool collateralPosted;
        uint256 requested;
        uint256 principal;
        uint256 collateralRequired;
        uint256 interestTotal;
        uint256 principalPaid;
        uint256 interestPaid;
        uint64 createdAt;
        uint64 approvedAt;
        uint64 disbursedAt;
        uint64 dueAt;
        uint64 closedAt;
        bytes32 purposeHash;
    }

    IERC20 public immutable asset;
    ICreditRegistry public immutable registry;
    ILendingPool public immutable pool;
    ICollateralVault public immutable vault;

    uint256 public loanCount;
    mapping(address => uint256) public openLoanOf; // 0 = none; one open loan per borrower
    mapping(uint256 => uint256) public auditNoteCount;
    mapping(uint256 => Loan) private _loans;
    mapping(address => uint256[]) private _loansOf;

    // ---------------------------------------------------------------------
    // Events & errors
    // ---------------------------------------------------------------------
    event LoanApplied(
        uint256 indexed loanId,
        address indexed borrower,
        uint256 amount,
        uint32 termDays,
        bytes32 purposeHash
    );
    event LoanApproved(
        uint256 indexed loanId,
        address indexed borrower,
        uint256 principal,
        uint16 aprBps,
        uint256 collateralRequired,
        uint256 interestTotal,
        address officer
    );
    event LoanRejected(uint256 indexed loanId, address indexed borrower, bytes32 reasonHash, address officer);
    event LoanCancelled(uint256 indexed loanId, address indexed borrower);
    event CollateralDeposited(uint256 indexed loanId, address indexed borrower, uint256 amount);
    event LoanDisbursed(uint256 indexed loanId, address indexed borrower, uint256 principal, uint64 dueAt);
    event LoanRepaid(
        uint256 indexed loanId,
        address indexed borrower,
        uint256 amount,
        uint256 principalPart,
        uint256 interestPart,
        uint256 remaining
    );
    event LoanClosed(uint256 indexed loanId, address indexed borrower, bool onTime);
    event LoanDefaulted(
        uint256 indexed loanId,
        address indexed borrower,
        uint256 collateralRecovered,
        uint256 principalLoss,
        uint256 reserveCovered
    );
    event AuditNoteAdded(uint256 indexed loanId, address indexed auditor, bytes32 noteHash);

    error InvalidStatus(Status current);
    error NotBorrower();
    error NotAuthorized();
    error SelfApproval();
    error BorrowerBlocked();
    error OpenLoanExists();
    error AmountOutOfRange(uint256 amount, uint256 max);
    error InvalidTerm(uint32 termDays);
    error ZeroAmount();
    error NoCollateralRequired();
    error CollateralAlreadyPosted();
    error CollateralMissing();
    error ApprovalExpired();
    error NotDefaultable(uint256 availableAt);
    error UnknownLoan();

    constructor(address asset_, address registry_, address pool_, address vault_, address admin) {
        asset = IERC20(asset_);
        registry = ICreditRegistry(registry_);
        pool = ILendingPool(pool_);
        vault = ICollateralVault(vault_);
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(PAUSER_ROLE, admin);
    }

    // ---------------------------------------------------------------------
    // Borrower actions
    // ---------------------------------------------------------------------

    /// @notice Apply for a loan. The amount is capped by the borrower's current tier. (tx type: applyLoan)
    function applyLoan(uint256 amount, uint32 termDays, bytes32 purposeHash)
        external
        whenNotPaused
        returns (uint256 loanId)
    {
        ICreditRegistry.Terms memory t = registry.getTerms(msg.sender);
        if (t.blocked) revert BorrowerBlocked();
        if (openLoanOf[msg.sender] != 0) revert OpenLoanExists();
        if (amount == 0 || amount > t.maxAmount) revert AmountOutOfRange(amount, t.maxAmount);
        if (termDays < MIN_TERM_DAYS || termDays > MAX_TERM_DAYS) revert InvalidTerm(termDays);

        loanId = ++loanCount;
        Loan storage l = _loans[loanId];
        l.borrower = msg.sender;
        l.status = Status.Pending;
        l.requested = amount;
        l.termDays = termDays;
        l.purposeHash = purposeHash;
        l.createdAt = uint64(block.timestamp);

        openLoanOf[msg.sender] = loanId;
        _loansOf[msg.sender].push(loanId);
        emit LoanApplied(loanId, msg.sender, amount, termDays, purposeHash);
    }

    /// @notice Withdraw an application, or an approval that has not been disbursed yet. Returns any collateral.
    ///         (tx type: cancelLoan)
    function cancelLoan(uint256 loanId) external nonReentrant {
        Loan storage l = _loan(loanId);
        if (msg.sender != l.borrower) revert NotBorrower();
        if (l.status != Status.Pending && l.status != Status.Approved) revert InvalidStatus(l.status);

        _closeUnfunded(loanId, l, Status.Cancelled);
        emit LoanCancelled(loanId, msg.sender);
    }

    /// @notice Deposit the security deposit required at approval. Needs a prior asset approval for this contract.
    ///         (tx type: depositCollateral)
    function depositCollateral(uint256 loanId) external whenNotPaused nonReentrant {
        Loan storage l = _loan(loanId);
        if (msg.sender != l.borrower) revert NotBorrower();
        if (l.status != Status.Approved) revert InvalidStatus(l.status);
        if (block.timestamp > uint256(l.approvedAt) + APPROVAL_VALIDITY) revert ApprovalExpired();
        if (l.collateralRequired == 0) revert NoCollateralRequired();
        if (l.collateralPosted) revert CollateralAlreadyPosted();

        l.collateralPosted = true;
        asset.safeTransferFrom(msg.sender, address(vault), l.collateralRequired);
        vault.lock(loanId, msg.sender, l.collateralRequired);
        emit CollateralDeposited(loanId, msg.sender, l.collateralRequired);
    }

    /// @notice Release the approved principal from the pool. Callable by the borrower or an officer.
    ///         (tx type: disburse)
    function disburse(uint256 loanId) external whenNotPaused nonReentrant {
        Loan storage l = _loan(loanId);
        if (msg.sender != l.borrower && !hasRole(OFFICER_ROLE, msg.sender)) revert NotAuthorized();
        if (l.status != Status.Approved) revert InvalidStatus(l.status);
        if (block.timestamp > uint256(l.approvedAt) + APPROVAL_VALIDITY) revert ApprovalExpired();
        if (l.collateralRequired > 0 && !l.collateralPosted) revert CollateralMissing();

        l.status = Status.Active;
        l.disbursedAt = uint64(block.timestamp);
        l.dueAt = uint64(block.timestamp + uint256(l.termDays) * 1 days);

        pool.disburse(l.borrower, l.principal);
        emit LoanDisbursed(loanId, l.borrower, l.principal, l.dueAt);
    }

    /// @notice Repay part or all of an active loan. Interest is paid before principal.
    ///         Repayment stays open while the contract is paused. (tx type: repay)
    function repay(uint256 loanId, uint256 amount) external nonReentrant {
        Loan storage l = _loan(loanId);
        if (msg.sender != l.borrower) revert NotBorrower();
        if (l.status != Status.Active) revert InvalidStatus(l.status);
        if (amount == 0) revert ZeroAmount();

        uint256 owedInterest = l.interestTotal - l.interestPaid;
        uint256 owedPrincipal = l.principal - l.principalPaid;
        uint256 totalOwed = owedInterest + owedPrincipal;
        if (amount > totalOwed) amount = totalOwed;

        uint256 toInterest = amount < owedInterest ? amount : owedInterest;
        uint256 toPrincipal = amount - toInterest;
        l.interestPaid += toInterest;
        l.principalPaid += toPrincipal;

        uint256 remaining = totalOwed - amount;
        // effects before interactions: a fully repaid loan is closed in storage before any external call
        if (remaining == 0) _markRepaid(l);

        asset.safeTransferFrom(msg.sender, address(pool), amount);
        pool.recordRepayment(toPrincipal, toInterest);

        emit LoanRepaid(loanId, msg.sender, amount, toPrincipal, toInterest, remaining);

        if (remaining == 0) _settleRepaid(loanId, l);
    }

    // ---------------------------------------------------------------------
    // Credit officer actions
    // ---------------------------------------------------------------------

    /// @notice Approve (possibly for less than requested). Pricing and collateral are fixed from the borrower's
    ///         current tier at this moment. (tx type: approveLoan)
    function approveLoan(uint256 loanId, uint256 approvedAmount) external onlyRole(OFFICER_ROLE) whenNotPaused {
        Loan storage l = _loan(loanId);
        if (l.status != Status.Pending) revert InvalidStatus(l.status);
        if (l.borrower == msg.sender) revert SelfApproval();

        ICreditRegistry.Terms memory t = registry.getTerms(l.borrower);
        if (t.blocked) revert BorrowerBlocked();
        if (approvedAmount == 0 || approvedAmount > l.requested || approvedAmount > t.maxAmount) {
            revert AmountOutOfRange(approvedAmount, l.requested < t.maxAmount ? l.requested : t.maxAmount);
        }

        l.principal = approvedAmount;
        l.tier = t.tier;
        l.aprBps = t.aprBps;
        l.collateralRequired = (approvedAmount * t.collateralBps) / 10_000;
        l.interestTotal = (approvedAmount * t.aprBps * l.termDays) / (365 * 10_000);
        l.status = Status.Approved;
        l.approvedAt = uint64(block.timestamp);

        emit LoanApproved(loanId, l.borrower, approvedAmount, t.aprBps, l.collateralRequired, l.interestTotal, msg.sender);
    }

    /// @notice Reject a pending or approved (not yet disbursed) loan. (tx type: rejectLoan)
    function rejectLoan(uint256 loanId, bytes32 reasonHash) external onlyRole(OFFICER_ROLE) nonReentrant {
        Loan storage l = _loan(loanId);
        if (l.status != Status.Pending && l.status != Status.Approved) revert InvalidStatus(l.status);

        _closeUnfunded(loanId, l, Status.Rejected);
        emit LoanRejected(loanId, l.borrower, reasonHash, msg.sender);
    }

    // ---------------------------------------------------------------------
    // Default handling (permissionless once the grace period has passed)
    // ---------------------------------------------------------------------

    /// @notice Declare a loan defaulted once `dueAt + GRACE_PERIOD` has passed and run the loss waterfall:
    ///         collateral -> reserve -> lenders. Anyone can call it. (tx type: markDefault)
    function markDefault(uint256 loanId) external nonReentrant {
        Loan storage l = _loan(loanId);
        if (l.status != Status.Active) revert InvalidStatus(l.status);
        {
            uint256 availableAt = uint256(l.dueAt) + GRACE_PERIOD;
            if (block.timestamp <= availableAt) revert NotDefaultable(availableAt);
        }

        l.status = Status.Defaulted;
        l.closedAt = uint64(block.timestamp);
        openLoanOf[l.borrower] = 0;

        uint256 owedInterest = l.interestTotal - l.interestPaid;
        uint256 owedPrincipal = l.principal - l.principalPaid;

        // 1. Collateral: seized up to what is owed, any surplus goes back to the borrower.
        uint256 recovered = l.collateralPosted ? vault.seize(loanId, owedInterest + owedPrincipal, address(pool)) : 0;
        uint256 toInterest = recovered < owedInterest ? recovered : owedInterest;
        uint256 toPrincipal = recovered - toInterest;
        if (recovered > 0) pool.recordRepayment(toPrincipal, toInterest);
        l.interestPaid += toInterest;
        l.principalPaid += toPrincipal;

        // 2 + 3. Remaining principal is a loss: reserve absorbs first, lenders take the rest.
        uint256 principalLoss = owedPrincipal - toPrincipal;
        uint256 reserveCovered = principalLoss > 0 ? pool.recordLoss(principalLoss) : 0;

        registry.recordLoanClosed(l.borrower, l.principal, l.principalPaid + l.interestPaid, false, true);
        emit LoanDefaulted(loanId, l.borrower, recovered, principalLoss, reserveCovered);
    }

    // ---------------------------------------------------------------------
    // Auditor / admin actions
    // ---------------------------------------------------------------------

    /// @notice Attach an immutable audit note (hash of an off-chain document) to a loan. (tx type: addAuditNote)
    function addAuditNote(uint256 loanId, bytes32 noteHash) external onlyRole(AUDITOR_ROLE) {
        _loan(loanId);
        auditNoteCount[loanId] += 1;
        emit AuditNoteAdded(loanId, msg.sender, noteHash);
    }

    /// @notice Pause new applications, approvals, collateral deposits and disbursements.
    ///         Repayment, cancellation and default handling stay available.
    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    function getLoan(uint256 loanId) external view returns (Loan memory) {
        return _loan(loanId);
    }

    function loansOf(address borrower) external view returns (uint256[] memory) {
        return _loansOf[borrower];
    }

    /// @return principalOwed Unpaid principal
    /// @return interestOwed Unpaid interest
    function amountOwed(uint256 loanId) external view returns (uint256 principalOwed, uint256 interestOwed) {
        Loan storage l = _loan(loanId);
        if (l.status != Status.Active) return (0, 0);
        return (l.principal - l.principalPaid, l.interestTotal - l.interestPaid);
    }

    function isDefaultable(uint256 loanId) external view returns (bool) {
        Loan storage l = _loan(loanId);
        return l.status == Status.Active && block.timestamp > uint256(l.dueAt) + GRACE_PERIOD;
    }

    // ---------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------

    function _loan(uint256 loanId) internal view returns (Loan storage l) {
        l = _loans[loanId];
        if (l.status == Status.None) revert UnknownLoan();
    }

    /// @dev Shared exit for Rejected / Cancelled before funds were lent: frees the borrower slot and
    ///      returns collateral if it was posted.
    function _closeUnfunded(uint256 loanId, Loan storage l, Status newStatus) internal {
        l.status = newStatus;
        l.closedAt = uint64(block.timestamp);
        openLoanOf[l.borrower] = 0;
        if (l.collateralPosted) vault.release(loanId);
    }

    /// @dev Storage part of closing a repaid loan (no external calls).
    function _markRepaid(Loan storage l) internal {
        l.status = Status.Repaid;
        l.closedAt = uint64(block.timestamp);
        openLoanOf[l.borrower] = 0;
    }

    /// @dev External part of closing a repaid loan: release collateral and update the credit record.
    function _settleRepaid(uint256 loanId, Loan storage l) internal {
        if (l.collateralPosted) vault.release(loanId);

        bool onTime = block.timestamp <= l.dueAt;
        registry.recordLoanClosed(l.borrower, l.principal, l.principalPaid + l.interestPaid, onTime, false);
        emit LoanClosed(loanId, l.borrower, onTime);
    }
}
