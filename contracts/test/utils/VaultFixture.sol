// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {RegistryFixture} from "./RegistryFixture.sol";
import {AgentVault} from "../../src/AgentVault.sol";
import {ITUSD8} from "../../src/interfaces/ITUSD8.sol";

/// @notice Registry fixture plus a vault, a funded owner, an agent session and an `exact` stall.
abstract contract VaultFixture is RegistryFixture {
    uint16 internal constant FEE_BPS = 300;
    uint8 internal constant CAT_KNOWLEDGE = 3;
    uint8 internal constant CAT_TOOL = 2;

    AgentVault internal vault;

    uint256 internal ownerPk = 0x0123;
    address internal owner;
    uint256 internal agentPk = 0xA6E47;
    address internal agent;
    address internal relayer = makeAddr("relayer");

    uint256 internal sessionId;
    uint256 internal exactStall;
    uint256 internal nextNonce;

    function setUp() public virtual override {
        super.setUp();
        owner = vm.addr(ownerPk);
        agent = vm.addr(agentPk);
        vault = new AgentVault(ITUSD8(address(token)), stalls, admin, treasury, arbiter, FEE_BPS);

        token.mint(owner, 10e6);
        vm.startPrank(owner);
        token.approve(address(vault), type(uint256).max);
        vault.deposit(3e6);
        vm.stopPrank();

        exactStall = _createStall(CAT_KNOWLEDGE, 0, 1000);
        sessionId = _createSession(200_000, 1e6, 2e6, uint64(block.timestamp + 2 hours), _allBut(CAT_TOOL));
    }

    function _allBut(uint8 category) internal pure returns (uint32) {
        return type(uint32).max & ~(uint32(1) << category);
    }

    function _createSession(uint128 per, uint128 daily, uint128 total, uint64 expiry, uint32 mask)
        internal
        returns (uint256 id)
    {
        vm.prank(owner);
        id = vault.createSession(
            AgentVault.SessionParams({
                agentKey: agent,
                perPaymentCap: per,
                dailyCap: daily,
                totalCap: total,
                expiry: expiry,
                categoryMask: mask,
                agentCanApprove: false
            })
        );
    }

    function _sign(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _quote(uint256 stallId, uint256 amount) internal returns (AgentVault.Quote memory q) {
        q = AgentVault.Quote({
            stallId: stallId,
            amount: amount,
            resourceHash: keccak256("POST /s/search"),
            buyerSession: 0,
            validBefore: block.timestamp + 5 minutes,
            quoteNonce: keccak256(abi.encode(nextNonce++))
        });
    }

    function _intentFor(AgentVault.Quote memory q, uint256 sid)
        internal
        returns (AgentVault.PaymentIntent memory)
    {
        return AgentVault.PaymentIntent({
            quoteHash: vault.hashQuote(q),
            sessionId: sid,
            validBefore: block.timestamp + 5 minutes,
            nonce: nextNonce++
        });
    }

    /// @dev Full happy-path payment of `amount` to `stallId` from `sid`, relayed by `relayer`.
    function _pay(uint256 stallId, uint256 amount, uint256 sid) internal returns (uint256 receiptId) {
        AgentVault.Quote memory q = _quote(stallId, amount);
        AgentVault.PaymentIntent memory i = _intentFor(q, sid);
        bytes memory qs = _sign(quotePk, vault.hashQuote(q));
        bytes memory is_ = _sign(agentPk, vault.hashIntent(i));
        vm.prank(relayer);
        receiptId = vault.payExact(q, qs, i, is_);
    }
}
