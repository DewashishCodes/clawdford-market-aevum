// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ITUSD8} from "./interfaces/ITUSD8.sol";
import {IIdentityRegistry} from "./interfaces/IIdentityRegistry.sol";
import {IStallRegistry} from "./interfaces/IStallRegistry.sol";

/// @title StallRegistry
/// @notice On-chain listing of paid AI services ("stalls"). Each stall is staked in tUSD8 and tied to an identity.
///         The registered payee is the Confirmation of Payee target buyers check before paying.
contract StallRegistry is IStallRegistry, Ownable2Step, ReentrancyGuard {
    using SafeERC20 for ITUSD8;

    uint8 public constant MAX_CATEGORY = 31; // categoryMask in AgentVault sessions is a uint32
    uint8 public constant MODE_EXACT = 0;
    uint8 public constant MODE_STREAM = 1;
    uint8 public constant MODE_TASK = 2;
    uint8 public constant MODE_LICENSE = 3;

    struct Stall {
        address owner; // seller admin
        address payee; // where money goes (Confirmation of Payee target)
        address quoteSigner; // key that signs 402 quotes
        uint256 identityId;
        uint8 category; // 0 inference, 1 data, 2 tool, 3 knowledge, 4 skill, 5 weights, 6 compute, 7 human, 8 eval, 9 outcome
        uint8 mode; // 0 exact, 1 stream, 2 task, 3 license
        uint128 unitPrice; // tUSD8 base units per unit
        string unit; // "call", "1k tokens", "row", "job", "license"
        string endpoint; // https URL
        string metadataURI; // name, description, tags, example request
        uint128 stake;
        bool active;
    }

    struct StallParams {
        uint256 identityId;
        address payee;
        address quoteSigner;
        uint8 category;
        uint8 mode;
        uint128 unitPrice;
        string unit;
        string endpoint;
        string metadataURI;
        uint128 stake;
    }

    struct Unstake {
        uint128 amount;
        uint64 unlockAt;
    }

    ITUSD8 public immutable token;
    IIdentityRegistry public immutable identities;

    address public arbiter;
    address public treasury;
    uint128 public minStake;
    uint64 public unstakeCooldown;

    /// @dev Stall ids start at 1 so 0 can mean "none".
    uint256 public stallCount;
    mapping(uint256 stallId => Stall) private _stalls;
    mapping(uint256 stallId => Unstake) public pendingUnstake;

    event StallCreated(
        uint256 indexed stallId, address indexed owner, uint256 indexed identityId, uint8 category, uint8 mode
    );
    event StallUpdated(uint256 indexed stallId);
    event PriceUpdated(uint256 indexed stallId, uint128 unitPrice);
    event ActiveSet(uint256 indexed stallId, bool active);
    event StakeAdded(uint256 indexed stallId, uint128 amount, uint128 total);
    event UnstakeRequested(uint256 indexed stallId, uint128 amount, uint64 unlockAt);
    event StakeWithdrawn(uint256 indexed stallId, uint128 amount, uint128 remaining);
    event Slashed(uint256 indexed stallId, uint128 amount, address indexed recipient, string reason);
    event ArbiterSet(address arbiter);
    event TreasurySet(address treasury);
    event MinStakeSet(uint128 minStake);
    event UnstakeCooldownSet(uint64 cooldown);

    error ZeroAddress();
    error NotStallOwner(uint256 stallId, address caller);
    error NotArbiter(address caller);
    error UnknownStall(uint256 stallId);
    error NotIdentityController(uint256 identityId, address caller);
    error StakeTooLow(uint128 stake, uint128 minStake);
    error InvalidCategory(uint8 category);
    error InvalidMode(uint8 mode);
    error ZeroAmount();
    error InsufficientStake(uint128 requested, uint128 available);
    error NothingToWithdraw();
    error CooldownActive(uint64 unlockAt);

    constructor(
        ITUSD8 token_,
        IIdentityRegistry identities_,
        address admin,
        address arbiter_,
        address treasury_,
        uint128 minStake_,
        uint64 unstakeCooldown_
    ) Ownable(admin) {
        if (address(token_) == address(0) || address(identities_) == address(0)) revert ZeroAddress();
        if (arbiter_ == address(0) || treasury_ == address(0)) revert ZeroAddress();
        token = token_;
        identities = identities_;
        arbiter = arbiter_;
        treasury = treasury_;
        minStake = minStake_;
        unstakeCooldown = unstakeCooldown_;
    }

    modifier onlyStallOwner(uint256 stallId) {
        address owner = _stalls[stallId].owner;
        if (owner != msg.sender) {
            if (owner == address(0)) revert UnknownStall(stallId);
            revert NotStallOwner(stallId, msg.sender);
        }
        _;
    }

    // ------------------------------------------------------------------ listing

    /// @notice List a stall, pulling the stake with a prior approve.
    function createStall(StallParams calldata p) external nonReentrant returns (uint256 stallId) {
        stallId = _create(p);
    }

    /// @notice List a stall, pulling the stake with an EIP-2612 permit (no separate approve tx).
    /// @dev The permit is wrapped in try/catch: if someone front-runs it, the allowance is already set and we continue.
    function createStallWithPermit(StallParams calldata p, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
        external
        nonReentrant
        returns (uint256 stallId)
    {
        try token.permit(msg.sender, address(this), p.stake, deadline, v, r, s) {} catch {}
        stallId = _create(p);
    }

    function _create(StallParams calldata p) private returns (uint256 stallId) {
        if (identities.controllerOf(p.identityId) != msg.sender) {
            revert NotIdentityController(p.identityId, msg.sender);
        }
        if (p.payee == address(0) || p.quoteSigner == address(0)) revert ZeroAddress();
        if (p.category > MAX_CATEGORY) revert InvalidCategory(p.category);
        if (p.mode > MODE_LICENSE) revert InvalidMode(p.mode);
        if (p.stake < minStake) revert StakeTooLow(p.stake, minStake);

        stallId = ++stallCount;
        _stalls[stallId] = Stall({
            owner: msg.sender,
            payee: p.payee,
            quoteSigner: p.quoteSigner,
            identityId: p.identityId,
            category: p.category,
            mode: p.mode,
            unitPrice: p.unitPrice,
            unit: p.unit,
            endpoint: p.endpoint,
            metadataURI: p.metadataURI,
            stake: p.stake,
            active: true
        });
        token.safeTransferFrom(msg.sender, address(this), p.stake);
        emit StallCreated(stallId, msg.sender, p.identityId, p.category, p.mode);
        emit StakeAdded(stallId, p.stake, p.stake);
    }

    // ------------------------------------------------------------------ seller admin

    function updatePrice(uint256 stallId, uint128 unitPrice) external onlyStallOwner(stallId) {
        _stalls[stallId].unitPrice = unitPrice;
        emit PriceUpdated(stallId, unitPrice);
    }

    /// @notice Rotate the payee or quote key, or change the endpoint and metadata.
    function updateStall(
        uint256 stallId,
        address payee,
        address quoteSigner,
        string calldata endpoint,
        string calldata metadataURI
    ) external onlyStallOwner(stallId) {
        if (payee == address(0) || quoteSigner == address(0)) revert ZeroAddress();
        Stall storage s = _stalls[stallId];
        s.payee = payee;
        s.quoteSigner = quoteSigner;
        s.endpoint = endpoint;
        s.metadataURI = metadataURI;
        emit StallUpdated(stallId);
    }

    function setActive(uint256 stallId, bool active) external onlyStallOwner(stallId) {
        Stall storage s = _stalls[stallId];
        if (active && s.stake < minStake) revert StakeTooLow(s.stake, minStake);
        s.active = active;
        emit ActiveSet(stallId, active);
    }

    function addStake(uint256 stallId, uint128 amount) external nonReentrant onlyStallOwner(stallId) {
        if (amount == 0) revert ZeroAmount();
        Stall storage s = _stalls[stallId];
        s.stake += amount;
        token.safeTransferFrom(msg.sender, address(this), amount);
        emit StakeAdded(stallId, amount, s.stake);
    }

    /// @notice Start the cooldown for withdrawing `amount`. Replaces any earlier request and restarts the clock.
    ///         Stake under cooldown can still be slashed.
    function requestUnstake(uint256 stallId, uint128 amount) external onlyStallOwner(stallId) {
        if (amount == 0) revert ZeroAmount();
        uint128 stake = _stalls[stallId].stake;
        if (amount > stake) revert InsufficientStake(amount, stake);
        uint64 unlockAt = uint64(block.timestamp) + unstakeCooldown;
        pendingUnstake[stallId] = Unstake(amount, unlockAt);
        emit UnstakeRequested(stallId, amount, unlockAt);
    }

    /// @notice Withdraw the requested stake after the cooldown. If what remains is below minStake the stall goes inactive.
    function withdrawStake(uint256 stallId) external nonReentrant onlyStallOwner(stallId) {
        Unstake memory u = pendingUnstake[stallId];
        if (u.amount == 0) revert NothingToWithdraw();
        if (block.timestamp < u.unlockAt) revert CooldownActive(u.unlockAt);
        delete pendingUnstake[stallId];

        Stall storage s = _stalls[stallId];
        uint128 amount = u.amount > s.stake ? s.stake : u.amount; // a slash may have shrunk the stake
        if (amount == 0) revert NothingToWithdraw();
        s.stake -= amount;
        if (s.active && s.stake < minStake) {
            s.active = false;
            emit ActiveSet(stallId, false);
        }
        token.safeTransfer(msg.sender, amount);
        emit StakeWithdrawn(stallId, amount, s.stake);
    }

    // ------------------------------------------------------------------ arbiter

    /// @notice Slash a stall's stake to the harmed buyer, or to the treasury when `recipient` is zero.
    function slash(uint256 stallId, uint128 amount, address recipient, string calldata reason) external nonReentrant {
        if (msg.sender != arbiter) revert NotArbiter(msg.sender);
        Stall storage s = _stalls[stallId];
        if (s.owner == address(0)) revert UnknownStall(stallId);
        if (amount == 0) revert ZeroAmount();
        if (amount > s.stake) revert InsufficientStake(amount, s.stake);
        s.stake -= amount;
        if (s.active && s.stake < minStake) {
            s.active = false;
            emit ActiveSet(stallId, false);
        }
        address to = recipient == address(0) ? treasury : recipient;
        token.safeTransfer(to, amount);
        emit Slashed(stallId, amount, to, reason);
    }

    // ------------------------------------------------------------------ protocol admin

    function setArbiter(address arbiter_) external onlyOwner {
        if (arbiter_ == address(0)) revert ZeroAddress();
        arbiter = arbiter_;
        emit ArbiterSet(arbiter_);
    }

    function setTreasury(address treasury_) external onlyOwner {
        if (treasury_ == address(0)) revert ZeroAddress();
        treasury = treasury_;
        emit TreasurySet(treasury_);
    }

    function setMinStake(uint128 minStake_) external onlyOwner {
        minStake = minStake_;
        emit MinStakeSet(minStake_);
    }

    function setUnstakeCooldown(uint64 cooldown) external onlyOwner {
        unstakeCooldown = cooldown;
        emit UnstakeCooldownSet(cooldown);
    }

    // ------------------------------------------------------------------ views

    function getStall(uint256 stallId) public view returns (Stall memory s) {
        s = _stalls[stallId];
        if (s.owner == address(0)) revert UnknownStall(stallId);
    }

    function paymentInfo(uint256 stallId) external view returns (PaymentInfo memory) {
        Stall storage s = _stalls[stallId];
        if (s.owner == address(0)) revert UnknownStall(stallId);
        return PaymentInfo(s.owner, s.payee, s.quoteSigner, s.category, s.mode, s.unitPrice, s.active);
    }

    /// @notice Stalls with ids in [offset + 1, offset + limit], clipped to stallCount.
    function listStalls(uint256 offset, uint256 limit) external view returns (Stall[] memory page) {
        if (offset >= stallCount) return new Stall[](0);
        uint256 end = offset + limit > stallCount ? stallCount : offset + limit;
        page = new Stall[](end - offset);
        for (uint256 i = 0; i < page.length; i++) {
            page[i] = _stalls[offset + i + 1];
        }
    }
}
