// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ITUSD8} from "./interfaces/ITUSD8.sol";
import {IStallRegistry} from "./interfaces/IStallRegistry.sol";
import {VaultBase} from "./vault/VaultBase.sol";

/// @title AgentVault
/// @notice Holds every owner's tUSD8 and lets AI agents spend it through session keys under hard, on-chain rules.
///         Balances, sessions, `_charge` and exact/license payments live in VaultBase.
contract AgentVault is VaultBase {
    constructor(
        ITUSD8 token_,
        IStallRegistry stalls_,
        address admin,
        address treasury_,
        address arbiter_,
        uint16 feeBps_
    ) VaultBase(token_, stalls_, admin, treasury_, arbiter_, feeBps_) {}
}
