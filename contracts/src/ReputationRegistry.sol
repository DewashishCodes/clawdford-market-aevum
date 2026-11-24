// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {VaultBase} from "./vault/VaultBase.sol";

/// @title ReputationRegistry
/// @notice One rating per paid receipt. Only the session owner or its agent can rate, so every rating is backed
///         by a real tUSD8 payment to that stall.
/// @dev Replace with QDay's official ERC-8004 reputation registry if one is published on Aevum.
contract ReputationRegistry {
    VaultBase public immutable vault;

    struct Totals {
        uint64 count;
        uint64 scoreSum;
    }

    mapping(uint256 receiptId => bool) public rated;
    mapping(uint256 stallId => Totals) public totals;

    event Rated(
        uint256 indexed receiptId,
        uint256 indexed stallId,
        address indexed rater,
        uint8 score,
        string commentURI
    );

    error InvalidScore(uint8 score);
    error UnknownReceipt(uint256 receiptId);
    error AlreadyRated(uint256 receiptId);
    error NotReceiptOwner(uint256 receiptId, address caller);

    constructor(VaultBase vault_) {
        vault = vault_;
    }

    function rate(uint256 receiptId, uint8 score, string calldata commentURI) external {
        if (score < 1 || score > 5) revert InvalidScore(score);
        VaultBase.Receipt memory r = vault.getReceipt(receiptId);
        if (r.sessionId == 0) revert UnknownReceipt(receiptId);
        if (rated[receiptId]) revert AlreadyRated(receiptId);
        VaultBase.Session memory s = vault.getSession(r.sessionId);
        if (msg.sender != s.owner && msg.sender != s.agentKey) revert NotReceiptOwner(receiptId, msg.sender);

        rated[receiptId] = true;
        Totals storage t = totals[r.stallId];
        t.count += 1;
        t.scoreSum += score;
        emit Rated(receiptId, r.stallId, msg.sender, score, commentURI);
    }

    /// @notice Average score times 100 (e.g. 450 = 4.50 stars), 0 when unrated.
    function average(uint256 stallId) external view returns (uint256) {
        Totals memory t = totals[stallId];
        return t.count == 0 ? 0 : uint256(t.scoreSum) * 100 / t.count;
    }

    function count(uint256 stallId) external view returns (uint256) {
        return totals[stallId].count;
    }
}
