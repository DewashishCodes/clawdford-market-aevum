// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {VaultFixture} from "./utils/VaultFixture.sol";
import {VaultBase} from "../src/vault/VaultBase.sol";

contract AgentVaultSessionsTest is VaultFixture {
    function test_createSessionStoresRules() public view {
        VaultBase.Session memory s = vault.getSession(sessionId);
        assertEq(s.owner, owner);
        assertEq(s.agentKey, agent);
        assertEq(s.perPaymentCap, 200_000);
        assertEq(s.dailyCap, 1e6);
        assertEq(s.totalCap, 2e6);
        assertEq(s.categoryMask, _allBut(CAT_TOOL));
        assertFalse(s.revoked);
        (uint256 today, uint256 total) = vault.remaining(sessionId);
        assertEq(today, 1e6);
        assertEq(total, 2e6);
    }

    function test_createSessionValidation() public {
        VaultBase.SessionParams memory p = VaultBase.SessionParams(address(0), 1, 1, 1, 0, 1, false);
        p.expiry = uint64(block.timestamp + 1);
        vm.expectRevert(VaultBase.ZeroAddress.selector);
        vault.createSession(p);

        p.agentKey = agent;
        p.expiry = uint64(block.timestamp);
        vm.expectRevert(VaultBase.InvalidExpiry.selector);
        vault.createSession(p);
    }

    function test_updateCapsOwnerOnly() public {
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(VaultBase.NotSessionOwner.selector, sessionId, agent));
        vault.updateCaps(sessionId, 1, 1, 1, uint64(block.timestamp + 1));

        vm.startPrank(owner);
        vm.expectRevert(VaultBase.InvalidExpiry.selector);
        vault.updateCaps(sessionId, 1, 1, 1, uint64(block.timestamp));
        vault.updateCaps(sessionId, 5, 6, 7, uint64(block.timestamp + 60));
        vm.stopPrank();

        VaultBase.Session memory s = vault.getSession(sessionId);
        assertEq(s.perPaymentCap, 5);
        assertEq(s.dailyCap, 6);
        assertEq(s.totalCap, 7);
    }

    function test_revokeIsFinal() public {
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(VaultBase.NotSessionOwner.selector, sessionId, agent));
        vault.revokeSession(sessionId);

        vm.prank(owner);
        vault.revokeSession(sessionId);
        assertTrue(vault.getSession(sessionId).revoked);
        (uint256 today, uint256 total) = vault.remaining(sessionId);
        assertEq(today + total, 0);

        vm.startPrank(owner);
        vm.expectRevert(abi.encodeWithSelector(VaultBase.RevokedSession.selector, sessionId));
        vault.revokeSession(sessionId);
        vm.expectRevert(abi.encodeWithSelector(VaultBase.RevokedSession.selector, sessionId));
        vault.updateCaps(sessionId, 1, 1, 1, uint64(block.timestamp + 60));
        vm.stopPrank();
    }

    function test_unknownSession() public {
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(VaultBase.UnknownSession.selector, 99));
        vault.revokeSession(99);
        (uint256 today, uint256 total) = vault.remaining(99);
        assertEq(today + total, 0);
    }

    function test_allowlistCounting() public {
        vm.startPrank(owner);
        vault.setStallAllowed(sessionId, 5, true);
        vault.setStallAllowed(sessionId, 5, true); // no-op
        vault.setStallAllowed(sessionId, 6, true);
        assertEq(vault.allowlistCount(sessionId), 2);
        vault.setStallAllowed(sessionId, 5, false);
        assertEq(vault.allowlistCount(sessionId), 1);
        vm.stopPrank();
    }

    function test_remainingAfterExpiryIsZero() public {
        vm.warp(block.timestamp + 2 hours);
        (uint256 today, uint256 total) = vault.remaining(sessionId);
        assertEq(today + total, 0);
    }
}
