// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {ITUSD8} from "../interfaces/ITUSD8.sol";
import {IStallRegistry} from "../interfaces/IStallRegistry.sol";

/// @title VaultBase
/// @notice Holds every owner's tUSD8 and lets AI agents spend it through session keys under hard, on-chain rules:
///         per-payment cap, daily cap (UTC calendar day), total cap, expiry, allowed categories, optional stall
///         allowlist and instant revoke. Every spend path goes through `_charge`.
abstract contract VaultBase is Ownable2Step, ReentrancyGuard, EIP712 {
    using SafeERC20 for ITUSD8;

    uint16 public constant MAX_FEE_BPS = 1000; // 10%
    uint16 internal constant BPS = 10_000;

    uint8 internal constant MODE_EXACT = 0;
    uint8 internal constant MODE_STREAM = 1;
    uint8 internal constant MODE_TASK = 2;
    uint8 internal constant MODE_LICENSE = 3;

    bytes32 public constant QUOTE_TYPEHASH = keccak256(
        "Quote(uint256 stallId,uint256 amount,bytes32 resourceHash,uint256 buyerSession,uint256 validBefore,bytes32 quoteNonce)"
    );
    bytes32 public constant PAYMENT_INTENT_TYPEHASH =
        keccak256("PaymentIntent(bytes32 quoteHash,uint256 sessionId,uint256 validBefore,uint256 nonce)");

    // ------------------------------------------------------------------ types

    struct Session {
        address owner;
        address agentKey; // the agent holds only this key
        uint128 perPaymentCap;
        uint128 dailyCap; // per UTC calendar day: day = block.timestamp / 1 days
        uint128 totalCap;
        uint128 spentTotal;
        uint128 spentToday;
        uint64 day; // UTC day index spentToday belongs to
        uint64 expiry;
        uint32 categoryMask; // bit i = category i allowed
        bool revoked;
        bool agentCanApprove; // agent may approve task results itself
    }

    struct SessionParams {
        address agentKey;
        uint128 perPaymentCap;
        uint128 dailyCap;
        uint128 totalCap;
        uint64 expiry;
        uint32 categoryMask;
        bool agentCanApprove;
    }

    /// @notice Seller-signed price for one resource. `buyerSession` 0 means any session may pay it.
    struct Quote {
        uint256 stallId;
        uint256 amount;
        bytes32 resourceHash;
        uint256 buyerSession;
        uint256 validBefore;
        bytes32 quoteNonce;
    }

    /// @notice Agent-signed consent to pay one quote from one session.
    struct PaymentIntent {
        bytes32 quoteHash;
        uint256 sessionId;
        uint256 validBefore;
        uint256 nonce;
    }

    struct Receipt {
        uint256 sessionId;
        uint256 stallId;
        uint128 amount;
        uint8 mode;
        uint64 timestamp;
    }

    // ------------------------------------------------------------------ storage

    ITUSD8 public immutable token;
    IStallRegistry public immutable stalls;

    address public treasury;
    address public arbiter;
    uint16 public feeBps;

    mapping(address owner => uint256) public balanceOf;

    /// @dev Session, receipt ids start at 1 so 0 can mean "none".
    uint256 public sessionCount;
    mapping(uint256 sessionId => Session) internal _sessions;
    mapping(uint256 sessionId => uint256) public allowlistCount;
    mapping(uint256 sessionId => mapping(uint256 stallId => bool)) public stallAllowed;
    mapping(uint256 sessionId => mapping(uint256 nonce => bool)) public intentNonceUsed;
    mapping(bytes32 quoteHash => bool) public quoteUsed;

    uint256 public receiptCount;
    mapping(uint256 receiptId => Receipt) internal _receipts;

    mapping(address owner => mapping(uint256 stallId => bool)) public licenses;

    // ------------------------------------------------------------------ events

    event Deposited(address indexed owner, uint256 amount, address indexed payer);
    event Withdrawn(address indexed owner, uint256 amount);
    event SessionCreated(
        uint256 indexed sessionId,
        address indexed owner,
        address indexed agentKey,
        uint64 expiry,
        uint32 categoryMask
    );
    event SessionCapsUpdated(
        uint256 indexed sessionId, uint128 perPaymentCap, uint128 dailyCap, uint128 totalCap, uint64 expiry
    );
    event SessionRevoked(uint256 indexed sessionId);
    event StallAllowedSet(uint256 indexed sessionId, uint256 indexed stallId, bool allowed);
    event Charged(uint256 indexed sessionId, uint256 indexed stallId, uint256 amount);
    event Refunded(uint256 indexed sessionId, uint256 amount);
    event Paid(
        uint256 indexed receiptId,
        uint256 indexed sessionId,
        uint256 indexed stallId,
        uint256 amount,
        bytes32 resourceHash
    );
    event Licensed(address indexed owner, uint256 indexed stallId, uint256 receiptId);
    event FeeBpsSet(uint16 feeBps);
    event TreasurySet(address treasury);
    event ArbiterSet(address arbiter);

    // ------------------------------------------------------------------ errors

    error ZeroAddress();
    error ZeroAmount();
    error FeeTooHigh(uint16 feeBps);
    error InsufficientBalance(uint256 requested, uint256 available);
    error UnknownSession(uint256 sessionId);
    error NotSessionOwner(uint256 sessionId, address caller);
    error RevokedSession(uint256 sessionId);
    error SessionExpired(uint256 sessionId);
    error InvalidExpiry();
    error StallInactive(uint256 stallId);
    error CategoryNotAllowed(uint256 sessionId, uint8 category);
    error StallNotAllowed(uint256 sessionId, uint256 stallId);
    error PerPaymentCapExceeded(uint256 amount, uint256 cap);
    error DailyCapExceeded(uint256 wouldSpend, uint256 cap);
    error TotalCapExceeded(uint256 wouldSpend, uint256 cap);
    error WrongMode(uint256 stallId, uint8 mode);
    error QuoteExpired();
    error IntentExpired();
    error BadQuoteSigner(address signer);
    error BadAgentSigner(address signer);
    error QuoteAlreadyUsed(bytes32 quoteHash);
    error QuoteMismatch();
    error WrongBuyerSession(uint256 expected, uint256 actual);
    error NonceAlreadyUsed(uint256 sessionId, uint256 nonce);
    error NotArbiter(address caller);

    // ------------------------------------------------------------------ setup

    constructor(
        ITUSD8 token_,
        IStallRegistry stalls_,
        address admin,
        address treasury_,
        address arbiter_,
        uint16 feeBps_
    ) Ownable(admin) EIP712("ClawdfordVault", "1") {
        if (address(token_) == address(0) || address(stalls_) == address(0)) {
            revert ZeroAddress();
        }
        if (treasury_ == address(0) || arbiter_ == address(0)) revert ZeroAddress();
        if (feeBps_ > MAX_FEE_BPS) revert FeeTooHigh(feeBps_);
        token = token_;
        stalls = stalls_;
        treasury = treasury_;
        arbiter = arbiter_;
        feeBps = feeBps_;
    }

    function setFeeBps(uint16 feeBps_) external onlyOwner {
        if (feeBps_ > MAX_FEE_BPS) revert FeeTooHigh(feeBps_);
        feeBps = feeBps_;
        emit FeeBpsSet(feeBps_);
    }

    function setTreasury(address treasury_) external onlyOwner {
        if (treasury_ == address(0)) revert ZeroAddress();
        treasury = treasury_;
        emit TreasurySet(treasury_);
    }

    /// @notice The arbiter only splits disputed escrow. It can never touch free balances.
    function setArbiter(address arbiter_) external onlyOwner {
        if (arbiter_ == address(0)) revert ZeroAddress();
        arbiter = arbiter_;
        emit ArbiterSet(arbiter_);
    }

    // ------------------------------------------------------------------ balances

    function deposit(uint256 amount) external nonReentrant {
        _pullDeposit(msg.sender, amount);
    }

    /// @dev Permit is try/caught so a front-run permit does not block the deposit.
    function depositWithPermit(uint256 amount, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
        external
        nonReentrant
    {
        try token.permit(msg.sender, address(this), amount, deadline, v, r, s) {} catch {}
        _pullDeposit(msg.sender, amount);
    }

    /// @notice Gasless funding: `from` signs an EIP-3009 ReceiveWithAuthorization to this vault and anyone
    ///         (normally the facilitator) submits it. The deposit is always credited to `from`.
    function depositWithAuthorization(
        address from,
        uint256 amount,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        token.receiveWithAuthorization(from, address(this), amount, validAfter, validBefore, nonce, v, r, s);
        balanceOf[from] += amount;
        emit Deposited(from, amount, msg.sender);
    }

    function withdraw(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        uint256 bal = balanceOf[msg.sender];
        if (amount > bal) revert InsufficientBalance(amount, bal);
        balanceOf[msg.sender] = bal - amount;
        token.safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, amount);
    }

    function _pullDeposit(address owner, uint256 amount) private {
        if (amount == 0) revert ZeroAmount();
        balanceOf[owner] += amount;
        token.safeTransferFrom(owner, address(this), amount);
        emit Deposited(owner, amount, owner);
    }

    // ------------------------------------------------------------------ sessions

    function createSession(SessionParams calldata p) external returns (uint256 sessionId) {
        if (p.agentKey == address(0)) revert ZeroAddress();
        if (p.expiry <= block.timestamp) revert InvalidExpiry();
        sessionId = ++sessionCount;
        _sessions[sessionId] = Session({
            owner: msg.sender,
            agentKey: p.agentKey,
            perPaymentCap: p.perPaymentCap,
            dailyCap: p.dailyCap,
            totalCap: p.totalCap,
            spentTotal: 0,
            spentToday: 0,
            day: uint64(block.timestamp / 1 days),
            expiry: p.expiry,
            categoryMask: p.categoryMask,
            revoked: false,
            agentCanApprove: p.agentCanApprove
        });
        emit SessionCreated(sessionId, msg.sender, p.agentKey, p.expiry, p.categoryMask);
    }

    /// @notice Change caps or expiry of a live session. Only the owner can call, so loosening is a re-grant.
    ///         A revoked session can never be revived; create a new one instead.
    function updateCaps(
        uint256 sessionId,
        uint128 perPaymentCap,
        uint128 dailyCap,
        uint128 totalCap,
        uint64 expiry
    ) external {
        Session storage s = _ownedLiveSession(sessionId);
        if (expiry <= block.timestamp) revert InvalidExpiry();
        s.perPaymentCap = perPaymentCap;
        s.dailyCap = dailyCap;
        s.totalCap = totalCap;
        s.expiry = expiry;
        emit SessionCapsUpdated(sessionId, perPaymentCap, dailyCap, totalCap, expiry);
    }

    /// @notice Kill switch. Takes effect in the same block: no further charge can pass `_charge`.
    function revokeSession(uint256 sessionId) external {
        Session storage s = _ownedLiveSession(sessionId);
        s.revoked = true;
        emit SessionRevoked(sessionId);
        _afterRevoke(sessionId);
    }

    /// @notice Once any stall is allowlisted for a session, only allowlisted stalls can be paid from it.
    function setStallAllowed(uint256 sessionId, uint256 stallId, bool allowed) external {
        _ownedLiveSession(sessionId);
        if (stallAllowed[sessionId][stallId] == allowed) return;
        stallAllowed[sessionId][stallId] = allowed;
        if (allowed) allowlistCount[sessionId]++;
        else allowlistCount[sessionId]--;
        emit StallAllowedSet(sessionId, stallId, allowed);
    }

    function _ownedLiveSession(uint256 sessionId) internal view returns (Session storage s) {
        s = _sessions[sessionId];
        if (s.owner == address(0)) revert UnknownSession(sessionId);
        if (s.owner != msg.sender) revert NotSessionOwner(sessionId, msg.sender);
        if (s.revoked) revert RevokedSession(sessionId);
    }

    /// @dev Hook for payment modes that hold funds per session (channels close on revoke).
    function _afterRevoke(uint256 sessionId) internal virtual {}

    // ------------------------------------------------------------------ the safety check

    /// @notice Every spend path calls this. It enforces all session rules, then moves `amount` out of the owner's
    ///         free balance and books it against the session's daily and total spend.
    function _charge(
        uint256 sessionId,
        uint256 stallId,
        IStallRegistry.PaymentInfo memory info,
        uint256 amount
    ) internal returns (address owner) {
        Session storage s = _sessions[sessionId];
        owner = s.owner;
        if (owner == address(0)) revert UnknownSession(sessionId);
        if (s.revoked) revert RevokedSession(sessionId);
        if (block.timestamp >= s.expiry) revert SessionExpired(sessionId);
        if (!info.active) revert StallInactive(stallId);
        if (s.categoryMask & (uint32(1) << info.category) == 0) {
            revert CategoryNotAllowed(sessionId, info.category);
        }
        if (allowlistCount[sessionId] != 0 && !stallAllowed[sessionId][stallId]) {
            revert StallNotAllowed(sessionId, stallId);
        }
        if (amount == 0) revert ZeroAmount();
        if (amount > s.perPaymentCap) revert PerPaymentCapExceeded(amount, s.perPaymentCap);

        uint64 today = uint64(block.timestamp / 1 days);
        uint256 spentToday = s.day == today ? s.spentToday : 0;
        if (spentToday + amount > s.dailyCap) revert DailyCapExceeded(spentToday + amount, s.dailyCap);
        if (s.spentTotal + amount > s.totalCap) revert TotalCapExceeded(s.spentTotal + amount, s.totalCap);

        uint256 bal = balanceOf[owner];
        if (amount > bal) revert InsufficientBalance(amount, bal);

        // Casts are safe: both sums were just checked against uint128 caps.
        s.day = today;
        s.spentToday = uint128(spentToday + amount);
        s.spentTotal = uint128(s.spentTotal + amount);
        balanceOf[owner] = bal - amount;
        emit Charged(sessionId, stallId, amount);
    }

    /// @notice Return unspent funds (closed channel, refunded escrow) to the owner and credit the session.
    /// @dev The total is always credited. The daily counter is credited only for what was charged today by the
    ///      same channel or task, so a refund can never open room above the daily cap for today.
    function _refund(uint256 sessionId, uint256 amount, uint64 chargeDay, uint256 chargedThatDay) internal {
        if (amount == 0) return;
        Session storage s = _sessions[sessionId];
        balanceOf[s.owner] += amount;
        s.spentTotal -= uint128(amount); // amount never exceeds what this session was charged
        uint64 today = uint64(block.timestamp / 1 days);
        if (chargeDay == today && s.day == today) {
            uint256 credit = amount < chargedThatDay ? amount : chargedThatDay;
            s.spentToday -= uint128(credit < s.spentToday ? credit : s.spentToday);
        }
        emit Refunded(sessionId, amount);
    }

    // ------------------------------------------------------------------ exact + license

    /// @notice Pay one seller-signed quote with one agent-signed intent. Anyone may submit (normally the facilitator).
    function payExact(
        Quote calldata quote,
        bytes calldata quoteSig,
        PaymentIntent calldata intent,
        bytes calldata intentSig
    ) external nonReentrant returns (uint256 receiptId) {
        IStallRegistry.PaymentInfo memory info = stalls.paymentInfo(quote.stallId);
        if (info.mode != MODE_EXACT && info.mode != MODE_LICENSE) revert WrongMode(quote.stallId, info.mode);

        bytes32 quoteHash = _verifyQuote(quote, quoteSig, info.quoteSigner);
        if (intent.quoteHash != quoteHash) revert QuoteMismatch();
        if (quote.buyerSession != 0 && quote.buyerSession != intent.sessionId) {
            revert WrongBuyerSession(quote.buyerSession, intent.sessionId);
        }
        _useIntent(intent, intentSig);
        quoteUsed[quoteHash] = true;

        address owner = _charge(intent.sessionId, quote.stallId, info, quote.amount);
        receiptId = _payout(intent.sessionId, quote.stallId, info.payee, quote.amount, info.mode);
        emit Paid(receiptId, intent.sessionId, quote.stallId, quote.amount, quote.resourceHash);

        if (info.mode == MODE_LICENSE) {
            licenses[owner][quote.stallId] = true;
            emit Licensed(owner, quote.stallId, receiptId);
        }
    }

    function _verifyQuote(Quote calldata q, bytes calldata sig, address expectedSigner)
        internal
        view
        returns (bytes32 quoteHash)
    {
        if (block.timestamp >= q.validBefore) revert QuoteExpired();
        quoteHash = hashQuote(q);
        if (quoteUsed[quoteHash]) revert QuoteAlreadyUsed(quoteHash);
        address signer = ECDSA.recover(quoteHash, sig);
        if (signer != expectedSigner) revert BadQuoteSigner(signer);
    }

    function _useIntent(PaymentIntent calldata i, bytes calldata sig) internal {
        _useSignedNonce(i.sessionId, i.validBefore, i.nonce, hashIntent(i), sig);
    }

    /// @dev Agent-signed message with a deadline and a per-session nonce. Intents, channel opens, top ups and task
    ///      creation share one nonce space per session.
    function _useSignedNonce(
        uint256 sessionId,
        uint256 validBefore,
        uint256 nonce,
        bytes32 digest,
        bytes calldata agentSig
    ) internal {
        if (block.timestamp >= validBefore) revert IntentExpired();
        if (intentNonceUsed[sessionId][nonce]) revert NonceAlreadyUsed(sessionId, nonce);
        _requireAgent(sessionId, digest, agentSig);
        intentNonceUsed[sessionId][nonce] = true;
    }

    function _requireAgent(uint256 sessionId, bytes32 digest, bytes calldata sig) internal view {
        address agent = _sessions[sessionId].agentKey;
        if (agent == address(0)) revert UnknownSession(sessionId);
        address signer = ECDSA.recover(digest, sig);
        if (signer != agent) revert BadAgentSigner(signer);
    }

    /// @dev Pays `payee` minus the platform fee and writes a receipt.
    function _payout(uint256 sessionId, uint256 stallId, address payee, uint256 amount, uint8 mode)
        internal
        returns (uint256 receiptId)
    {
        uint256 fee = amount * feeBps / BPS;
        if (fee != 0) token.safeTransfer(treasury, fee);
        token.safeTransfer(payee, amount - fee);
        receiptId = ++receiptCount;
        _receipts[receiptId] = Receipt(sessionId, stallId, uint128(amount), mode, uint64(block.timestamp));
    }

    // ------------------------------------------------------------------ views

    function hashQuote(Quote calldata q) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    QUOTE_TYPEHASH,
                    q.stallId,
                    q.amount,
                    q.resourceHash,
                    q.buyerSession,
                    q.validBefore,
                    q.quoteNonce
                )
            )
        );
    }

    function hashIntent(PaymentIntent calldata i) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(abi.encode(PAYMENT_INTENT_TYPEHASH, i.quoteHash, i.sessionId, i.validBefore, i.nonce))
        );
    }

    function getSession(uint256 sessionId) external view returns (Session memory) {
        return _sessions[sessionId];
    }

    /// @notice What the session can still spend right now (0 when revoked or expired). Rolls the day like `_charge`.
    function remaining(uint256 sessionId) external view returns (uint256 today, uint256 total) {
        Session storage s = _sessions[sessionId];
        if (s.owner == address(0) || s.revoked || block.timestamp >= s.expiry) return (0, 0);
        uint256 spentToday = s.day == uint64(block.timestamp / 1 days) ? s.spentToday : 0;
        today = s.dailyCap > spentToday ? s.dailyCap - spentToday : 0;
        total = s.totalCap > s.spentTotal ? s.totalCap - s.spentTotal : 0;
    }

    function getReceipt(uint256 receiptId) external view returns (Receipt memory) {
        return _receipts[receiptId];
    }

    // solhint-disable-next-line func-name-mixedcase
    function DOMAIN_SEPARATOR() external view returns (bytes32) {
        return _domainSeparatorV4();
    }
}
