// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ITUSD8} from "./interfaces/ITUSD8.sol";
import {IStallRegistry} from "./interfaces/IStallRegistry.sol";
import {VaultBase} from "./vault/VaultBase.sol";
import {VaultChannels} from "./vault/VaultChannels.sol";
import {VaultTasks} from "./vault/VaultTasks.sol";

/// @title AgentVault
/// @notice Holds every owner's tUSD8 and lets AI agents spend it through session keys under hard, on-chain rules.
///         Balances, sessions, `_charge` and exact/license payments live in VaultBase; stream channels in
///         VaultChannels; task escrow in VaultTasks.
contract AgentVault is VaultChannels, VaultTasks {
    constructor(
        ITUSD8 token_,
        IStallRegistry stalls_,
        address admin,
        address treasury_,
        address arbiter_,
        uint16 feeBps_
    ) VaultBase(token_, stalls_, admin, treasury_, arbiter_, feeBps_) {}

    function _afterRevoke(uint256 sessionId) internal override(VaultBase, VaultChannels) {
        VaultChannels._afterRevoke(sessionId);
    }
}
