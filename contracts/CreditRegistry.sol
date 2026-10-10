// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {ICreditRegistry} from "./interfaces/ICreditRegistry.sol";

/// @title CreditRegistry
/// @notice Portable on-chain credit record for borrowers who have no bank history.
///
///  * An off-chain scoring service (model v1 = logistic regression, see /ml) produces a score.
///    The score is attested by an address holding SCORER_ROLE, either by sending the tx directly
///    or by signing an EIP-712 message that the borrower (or any relayer) submits. The chain only
///    stores the score, its expiry and the model-version hash, never the raw personal data.
///  * Repayment history is written only by the LoanManager and grants a "history bonus" that is
///    added to the attested score. This is what makes credit progressive: a borrower who keeps
///    repaying climbs tiers (lower collateral, higher limit, lower APR) without a new score.
///  * Other lending platforms may read getProfile()/getTerms() to reuse the record.
contract CreditRegistry is AccessControl, EIP712, ICreditRegistry {
    // ---------------------------------------------------------------------
    // Roles & constants
    // ---------------------------------------------------------------------
    bytes32 public constant SCORER_ROLE = keccak256("SCORER_ROLE");
    bytes32 public constant LOAN_MANAGER_ROLE = keccak256("LOAN_MANAGER_ROLE");

    bytes32 private constant SCORE_TYPEHASH =
        keccak256("Score(address borrower,uint16 score,bytes32 modelHash,uint64 expiresAt,uint256 nonce)");

    uint8 public constant TIER_COUNT = 4;
    uint16 public constant MAX_SCORE = 1000;
    uint16 public constant BONUS_ON_TIME = 30;
    uint16 public constant BONUS_LATE = 5;
    uint16 public constant MAX_BONUS = 150;
    uint64 public constant MAX_SCORE_VALIDITY = 180 days;

    // ---------------------------------------------------------------------
    // Storage
    // ---------------------------------------------------------------------
    struct Profile {
        uint16 score; // attested by scorer
        uint16 bonus; // earned from on-chain repayment history
        uint64 scoredAt;
        uint64 expiresAt;
        bytes32 modelHash; // hash of the scoring model version that produced `score`
        uint32 loansRepaid;
        uint32 loansDefaulted;
        uint32 onTimeLoans;
        uint32 lateLoans;
        uint256 totalBorrowed;
        uint256 totalRepaid;
        bool blocked;
    }

    struct Tier {
        uint16 minScore;
        uint256 maxAmount; // in asset units (6 decimals)
        uint16 aprBps; // simple annual interest, basis points
        uint16 collateralBps; // required deposit as a share of principal
    }

    mapping(address => Profile) private _profiles;
    mapping(address => uint256) public nonces;
    Tier[4] private _tiers;

    // ---------------------------------------------------------------------
    // Events & errors
    // ---------------------------------------------------------------------
    event ScoreUpdated(
        address indexed borrower,
        uint16 score,
        bytes32 modelHash,
        uint64 expiresAt,
        address indexed scorer
    );
    event LoanOutcomeRecorded(
        address indexed borrower,
        uint256 principal,
        uint256 totalRepaid,
        bool onTime,
        bool defaulted
    );
    event BorrowerBlockedSet(address indexed borrower, bool blocked);
    event TierConfigured(uint8 indexed index, uint16 minScore, uint256 maxAmount, uint16 aprBps, uint16 collateralBps);

    error InvalidSigner(address recovered);
    error ScoreOutOfRange(uint16 score);
    error InvalidExpiry(uint64 expiresAt);
    error InvalidTierConfig();

    // ---------------------------------------------------------------------
    // Construction
    // ---------------------------------------------------------------------
    constructor(address admin) EIP712("MicroLend CreditRegistry", "1") {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);

        // Amounts use 6 decimals (mUSDC). Higher tiers: bigger limit, cheaper, less collateral.
        _tiers[0] = Tier({minScore: 0, maxAmount: 100e6, aprBps: 2400, collateralBps: 2000});
        _tiers[1] = Tier({minScore: 450, maxAmount: 300e6, aprBps: 2000, collateralBps: 1000});
        _tiers[2] = Tier({minScore: 600, maxAmount: 800e6, aprBps: 1600, collateralBps: 500});
        _tiers[3] = Tier({minScore: 750, maxAmount: 2000e6, aprBps: 1200, collateralBps: 0});
    }

    // ---------------------------------------------------------------------
    // Scoring
    // ---------------------------------------------------------------------

    /// @notice Scorer submits a score directly. (tx type: updateScore)
    function updateScore(
        address borrower,
        uint16 score,
        bytes32 modelHash,
        uint64 expiresAt
    ) external onlyRole(SCORER_ROLE) {
        _setScore(borrower, score, modelHash, expiresAt, msg.sender);
    }

    /// @notice Anyone may submit a score attestation signed (EIP-712) by a SCORER_ROLE holder.
    ///         The borrower normally submits it and pays the gas. (tx type: updateScoreWithSignature)
    function updateScoreWithSignature(
        address borrower,
        uint16 score,
        bytes32 modelHash,
        uint64 expiresAt,
        bytes calldata signature
    ) external {
        uint256 nonce = nonces[borrower]++;
        bytes32 structHash = keccak256(abi.encode(SCORE_TYPEHASH, borrower, score, modelHash, expiresAt, nonce));
        address signer = ECDSA.recover(_hashTypedDataV4(structHash), signature);
        if (!hasRole(SCORER_ROLE, signer)) revert InvalidSigner(signer);
        _setScore(borrower, score, modelHash, expiresAt, signer);
    }

    function _setScore(address borrower, uint16 score, bytes32 modelHash, uint64 expiresAt, address scorer) internal {
        if (score > MAX_SCORE) revert ScoreOutOfRange(score);
        if (expiresAt <= block.timestamp || expiresAt > block.timestamp + MAX_SCORE_VALIDITY) {
            revert InvalidExpiry(expiresAt);
        }
        Profile storage p = _profiles[borrower];
        p.score = score;
        p.scoredAt = uint64(block.timestamp);
        p.expiresAt = expiresAt;
        p.modelHash = modelHash;
        emit ScoreUpdated(borrower, score, modelHash, expiresAt, scorer);
    }

    // ---------------------------------------------------------------------
    // Written by LoanManager
    // ---------------------------------------------------------------------

    /// @inheritdoc ICreditRegistry
    function recordLoanClosed(
        address borrower,
        uint256 principal,
        uint256 totalRepaid,
        bool onTime,
        bool defaulted
    ) external onlyRole(LOAN_MANAGER_ROLE) {
        Profile storage p = _profiles[borrower];
        p.totalBorrowed += principal;
        p.totalRepaid += totalRepaid;

        if (defaulted) {
            p.loansDefaulted += 1;
            p.bonus = 0;
            p.blocked = true;
            emit BorrowerBlockedSet(borrower, true);
        } else {
            p.loansRepaid += 1;
            uint256 add;
            if (onTime) {
                p.onTimeLoans += 1;
                add = BONUS_ON_TIME;
            } else {
                p.lateLoans += 1;
                add = BONUS_LATE;
            }
            uint256 newBonus = uint256(p.bonus) + add;
            p.bonus = newBonus > MAX_BONUS ? MAX_BONUS : uint16(newBonus);
        }
        emit LoanOutcomeRecorded(borrower, principal, totalRepaid, onTime, defaulted);
    }

    // ---------------------------------------------------------------------
    // Admin
    // ---------------------------------------------------------------------

    /// @notice Block or unblock a borrower (e.g. after a default review). (tx type: setBlocked)
    function setBlocked(address borrower, bool blocked) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _profiles[borrower].blocked = blocked;
        emit BorrowerBlockedSet(borrower, blocked);
    }

    /// @notice Reconfigure one tier. minScore must stay strictly ascending across tiers and tier 0 must start at 0.
    function setTier(
        uint8 index,
        uint16 minScore,
        uint256 maxAmount,
        uint16 aprBps,
        uint16 collateralBps
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (index >= TIER_COUNT || aprBps > 10_000 || collateralBps > 10_000 || maxAmount == 0) {
            revert InvalidTierConfig();
        }
        if (index == 0 && minScore != 0) revert InvalidTierConfig();
        if (index > 0 && minScore <= _tiers[index - 1].minScore) revert InvalidTierConfig();
        if (index < TIER_COUNT - 1 && minScore >= _tiers[index + 1].minScore) revert InvalidTierConfig();
        _tiers[index] = Tier(minScore, maxAmount, aprBps, collateralBps);
        emit TierConfigured(index, minScore, maxAmount, aprBps, collateralBps);
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    function getProfile(address borrower) external view returns (Profile memory) {
        return _profiles[borrower];
    }

    function getTier(uint8 index) external view returns (Tier memory) {
        return _tiers[index];
    }

    /// @notice Score actually used for pricing: attested score (if still valid) plus history bonus.
    function effectiveScore(address borrower) public view returns (uint16) {
        return _effectiveScore(_profiles[borrower]);
    }

    /// @inheritdoc ICreditRegistry
    function getTerms(address borrower) external view returns (Terms memory t) {
        Profile storage p = _profiles[borrower];
        uint16 s = _effectiveScore(p);
        uint8 tier = 0;
        for (uint8 i = 1; i < TIER_COUNT; i++) {
            if (s >= _tiers[i].minScore) tier = i;
        }
        Tier storage cfg = _tiers[tier];
        t = Terms({
            tier: tier,
            maxAmount: cfg.maxAmount,
            aprBps: cfg.aprBps,
            collateralBps: cfg.collateralBps,
            effectiveScore: s,
            blocked: p.blocked
        });
    }

    function _effectiveScore(Profile storage p) internal view returns (uint16) {
        // An expired or missing attestation means "unscored" (tier 0); history bonus alone is not enough.
        if (p.scoredAt == 0 || p.expiresAt < block.timestamp) return 0;
        uint256 s = uint256(p.score) + p.bonus;
        return s > MAX_SCORE ? MAX_SCORE : uint16(s);
    }
}
