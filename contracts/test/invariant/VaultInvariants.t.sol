// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {VaultFixture} from "../utils/VaultFixture.sol";
import {VaultHandler} from "./VaultHandler.sol";
import {console} from "forge-std/console.sol";

/// @notice PRD 7.6 invariants: the vault is always fully backed, and a session can never break its rules.
contract VaultInvariants is VaultFixture {
    VaultHandler internal handler;
    uint128 internal constant DAILY = 600_000;
    uint128 internal constant TOTAL = 1_500_000;

    function setUp() public override {
        super.setUp();
        vm.warp(100 days);
        uint256 sid =
            _createSession(250_000, DAILY, TOTAL, uint64(block.timestamp + 30 days), _allBut(CAT_TOOL));
        uint256[4] memory ids = [
            exactStall,
            _createStall(0, 1, 2000), // stream
            _createStall(7, 2, 100_000), // task
            _createStall(CAT_TOOL, 0, 1000) // disallowed category
        ];
        handler = new VaultHandler(vault, token, owner, seller, agentPk, quotePk, sid, ids);
        // The vault's arbiter is the fixture arbiter; the handler pranks it for resolve.
        targetContract(address(handler));
    }

    /// Total vault tUSD8 == free balances + open channel balances + escrow.
    function invariant_vaultIsFullyBacked() public view {
        assertEq(token.balanceOf(address(vault)), vault.balanceOf(owner) + handler.lockedFunds());
    }

    /// Registry tUSD8 == sum of stall stakes.
    function invariant_stakesAreBacked() public view {
        uint256 sum;
        for (uint256 id = 1; id <= stalls.stallCount(); id++) {
            sum += stalls.getStall(id).stake;
        }
        assertEq(token.balanceOf(address(stalls)), sum);
    }

    function invariant_neverAboveTotalCap() public view {
        assertLe(vault.getSession(handler.sessionId()).spentTotal, TOTAL);
    }

    function invariant_neverAboveDailyCap() public view {
        assertLe(handler.maxSpentTodaySeen(), DAILY);
    }

    function invariant_disallowedCategoryNeverPaid() public view {
        assertEq(handler.disallowedPaid(), 0);
    }

    function invariant_revokedSessionNeverCharged() public view {
        assertEq(handler.chargesAfterRevoke(), 0);
    }

    /// Logs how much the handler actually did, so a silent no-op run is visible with -vv.
    function afterInvariant() public view {
        console.log("receipts", vault.receiptCount());
        console.log("channels", handler.channelCount());
        console.log("tasks", handler.taskCount());
        console.log("spentTotal", vault.getSession(handler.sessionId()).spentTotal);
        console.log("revoked", handler.revoked());
    }
}
