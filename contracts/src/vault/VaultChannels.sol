// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ITUSD8} from "../interfaces/ITUSD8.sol";
import {IStallRegistry} from "../interfaces/IStallRegistry.sol";
import {VaultBase} from "./VaultBase.sol";

/// @title VaultChannels
/// @notice `stream` mode: payment channels with cumulative agent-signed vouchers, settled by the seller in batches.
///         Opening and topping up are charged against session caps. Closing has a challenge window in which the
///         seller can still claim; the remainder goes back to the owner and is credited to the session.
abstract contract VaultChannels is VaultBase {
    using SafeERC20 for ITUSD8;

    uint256 public constant MAX_OPEN_CHANNELS = 16; // bounds the loop in revokeSession

    bytes32 public constant OPEN_CHANNEL_TYPEHASH = keccak256(
        "OpenChannel(uint256 sessionId,uint256 stallId,uint256 deposit,uint256 validBefore,uint256 nonce)"
    );
    bytes32 public constant TOP_UP_TYPEHASH =
        keccak256("TopUp(uint256 channelId,uint256 amount,uint256 validBefore,uint256 nonce)");
    bytes32 public constant VOUCHER_TYPEHASH =
        keccak256("Voucher(uint256 channelId,uint256 cumulativeAmount)");
    bytes32 public constant CLOSE_CHANNEL_TYPEHASH = keccak256("CloseChannel(uint256 channelId)");

    struct Channel {
        uint256 sessionId;
        uint256 stallId;
        address payee; // fixed at open: later payee changes on the stall cannot redirect this channel
        uint128 deposit;
        uint128 claimed;
        uint128 chargedOnDay; // charged into this channel on `chargeDay`
        uint64 chargeDay;
        uint64 closeAt; // 0 while open
        bool finalized;
    }

    uint64 public challengeWindow = 10 minutes;
    uint256 public channelCount;
    mapping(uint256 channelId => Channel) internal _channels;
    mapping(uint256 sessionId => uint256[]) internal _openChannels;
    mapping(uint256 channelId => uint256) internal _openIndex; // index + 1 in _openChannels

    event ChannelOpened(
        uint256 indexed channelId,
        uint256 indexed sessionId,
        uint256 indexed stallId,
        address payee,
        uint256 deposit
    );
    event ChannelToppedUp(uint256 indexed channelId, uint256 amount, uint256 deposit);
    event ChannelClaimed(
        uint256 indexed channelId, uint256 indexed receiptId, uint256 amount, uint256 cumulative
    );
    event ChannelCloseRequested(uint256 indexed channelId, uint64 closeAt);
    event ChannelFinalized(uint256 indexed channelId, uint256 refunded);
    event ChallengeWindowSet(uint64 window);

    error UnknownChannel(uint256 channelId);
    error ChannelClosing(uint256 channelId);
    error ChannelFinalized_(uint256 channelId);
    error ChallengeWindowActive(uint64 closeAt);
    error VoucherTooLarge(uint256 cumulative, uint256 deposit);
    error VoucherNotIncreasing(uint256 cumulative, uint256 claimed);
    error NotChannelParty(uint256 channelId, address caller);
    error TooManyOpenChannels(uint256 sessionId);

    function setChallengeWindow(uint64 window) external onlyOwner {
        challengeWindow = window;
        emit ChallengeWindowSet(window);
    }

    // ------------------------------------------------------------------ open / top up

    /// @notice Open a channel from an agent-signed OpenChannel message. Anyone may relay it.
    function openChannel(
        uint256 sessionId,
        uint256 stallId,
        uint256 deposit,
        uint256 validBefore,
        uint256 nonce,
        bytes calldata agentSig
    ) external nonReentrant returns (uint256 channelId) {
        IStallRegistry.PaymentInfo memory info = stalls.paymentInfo(stallId);
        if (info.mode != MODE_STREAM) revert WrongMode(stallId, info.mode);
        bytes32 digest = _hashTypedDataV4(
            keccak256(abi.encode(OPEN_CHANNEL_TYPEHASH, sessionId, stallId, deposit, validBefore, nonce))
        );
        _useSignedNonce(sessionId, validBefore, nonce, digest, agentSig);
        if (_openChannels[sessionId].length >= MAX_OPEN_CHANNELS) revert TooManyOpenChannels(sessionId);

        _charge(sessionId, stallId, info, deposit);

        channelId = ++channelCount;
        _channels[channelId] = Channel({
            sessionId: sessionId,
            stallId: stallId,
            payee: info.payee,
            deposit: uint128(deposit),
            claimed: 0,
            chargedOnDay: uint128(deposit),
            chargeDay: uint64(block.timestamp / 1 days),
            closeAt: 0,
            finalized: false
        });
        _openChannels[sessionId].push(channelId);
        _openIndex[channelId] = _openChannels[sessionId].length;
        emit ChannelOpened(channelId, sessionId, stallId, info.payee, deposit);
    }

    /// @notice Add funds to an open channel from an agent-signed TopUp message. Charged against session caps.
    function topUp(
        uint256 channelId,
        uint256 amount,
        uint256 validBefore,
        uint256 nonce,
        bytes calldata agentSig
    ) external nonReentrant {
        Channel storage c = _liveChannel(channelId);
        if (c.closeAt != 0) revert ChannelClosing(channelId);
        bytes32 digest =
            _hashTypedDataV4(keccak256(abi.encode(TOP_UP_TYPEHASH, channelId, amount, validBefore, nonce)));
        _useSignedNonce(c.sessionId, validBefore, nonce, digest, agentSig);

        _charge(c.sessionId, c.stallId, stalls.paymentInfo(c.stallId), amount);

        uint64 today = uint64(block.timestamp / 1 days);
        c.chargedOnDay = c.chargeDay == today ? c.chargedOnDay + uint128(amount) : uint128(amount);
        c.chargeDay = today;
        c.deposit += uint128(amount);
        emit ChannelToppedUp(channelId, amount, c.deposit);
    }

    // ------------------------------------------------------------------ claim

    /// @notice Settle the latest voucher. Pays `cumulative - claimed` to the channel payee minus the fee.
    ///         Works while the channel is open or closing, so a revoke never strands signed vouchers.
    function claim(uint256 channelId, uint256 cumulativeAmount, bytes calldata voucherSig)
        external
        nonReentrant
        returns (uint256 receiptId)
    {
        Channel storage c = _liveChannel(channelId);
        if (cumulativeAmount > c.deposit) revert VoucherTooLarge(cumulativeAmount, c.deposit);
        if (cumulativeAmount <= c.claimed) revert VoucherNotIncreasing(cumulativeAmount, c.claimed);
        _requireAgent(c.sessionId, hashVoucher(channelId, cumulativeAmount), voucherSig);

        uint256 delta = cumulativeAmount - c.claimed;
        c.claimed = uint128(cumulativeAmount);
        receiptId = _payout(c.sessionId, c.stallId, c.payee, delta, MODE_STREAM);
        emit ChannelClaimed(channelId, receiptId, delta, cumulativeAmount);
    }

    // ------------------------------------------------------------------ close

    /// @notice Owner or agent starts the challenge window.
    function requestClose(uint256 channelId) external {
        Channel storage c = _liveChannel(channelId);
        Session storage s = _sessions[c.sessionId];
        if (msg.sender != s.owner && msg.sender != s.agentKey) revert NotChannelParty(channelId, msg.sender);
        _startClose(channelId, c);
    }

    /// @notice Gasless close: the agent signs CloseChannel and anyone relays it.
    function requestCloseWithSig(uint256 channelId, bytes calldata agentSig) external {
        Channel storage c = _liveChannel(channelId);
        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(CLOSE_CHANNEL_TYPEHASH, channelId)));
        _requireAgent(c.sessionId, digest, agentSig);
        _startClose(channelId, c);
    }

    /// @notice After the challenge window, refund what the seller did not claim to the owner. Anyone may call.
    function finalizeClose(uint256 channelId) external nonReentrant {
        Channel storage c = _liveChannel(channelId);
        if (c.closeAt == 0 || block.timestamp < c.closeAt) revert ChallengeWindowActive(c.closeAt);
        c.finalized = true;
        _removeOpen(c.sessionId, channelId);
        uint256 refund = c.deposit - c.claimed;
        _refund(c.sessionId, refund, c.chargeDay, c.chargedOnDay);
        emit ChannelFinalized(channelId, refund);
    }

    function _startClose(uint256 channelId, Channel storage c) private {
        if (c.closeAt != 0) return; // already closing; never extend the window
        c.closeAt = uint64(block.timestamp) + challengeWindow;
        emit ChannelCloseRequested(channelId, c.closeAt);
    }

    /// @dev Revoking a session starts the close window on all its open channels. Sellers keep the window to
    ///      claim vouchers the agent already signed; the rest returns to the owner. Fair to both sides.
    function _afterRevoke(uint256 sessionId) internal virtual override {
        uint256[] storage open = _openChannels[sessionId];
        for (uint256 k = 0; k < open.length; k++) {
            _startClose(open[k], _channels[open[k]]);
        }
    }

    // ------------------------------------------------------------------ helpers

    function _liveChannel(uint256 channelId) internal view returns (Channel storage c) {
        c = _channels[channelId];
        if (c.sessionId == 0) revert UnknownChannel(channelId);
        if (c.finalized) revert ChannelFinalized_(channelId);
    }

    function _removeOpen(uint256 sessionId, uint256 channelId) private {
        uint256[] storage open = _openChannels[sessionId];
        uint256 idx = _openIndex[channelId] - 1;
        uint256 last = open[open.length - 1];
        open[idx] = last;
        _openIndex[last] = idx + 1;
        open.pop();
        delete _openIndex[channelId];
    }

    /// @dev Agent-signed message with a deadline and a per-session nonce (shared with payment intents).
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

    // ------------------------------------------------------------------ views

    function hashVoucher(uint256 channelId, uint256 cumulativeAmount) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(VOUCHER_TYPEHASH, channelId, cumulativeAmount)));
    }

    function getChannel(uint256 channelId) external view returns (Channel memory) {
        return _channels[channelId];
    }

    function openChannelsOf(uint256 sessionId) external view returns (uint256[] memory) {
        return _openChannels[sessionId];
    }
}
