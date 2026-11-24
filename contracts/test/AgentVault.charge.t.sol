// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {VaultFixture} from "./utils/VaultFixture.sol";
import {VaultBase} from "../src/vault/VaultBase.sol";

/// @notice Every rule `_charge` enforces, exercised through payExact.
contract AgentVaultChargeTest is VaultFixture {
    function test_happyPathBooksSpendAndPaysPayeeMinusFee() public {
        uint256 rid = _pay(exactStall, 100_000, sessionId);

        assertEq(vault.balanceOf(owner), 3e6 - 100_000);
        assertEq(token.balanceOf(payee), 97_000);
        assertEq(token.balanceOf(treasury), 3_000);
        VaultBase.Session memory s = vault.getSession(sessionId);
        assertEq(s.spentTotal, 100_000);
        assertEq(s.spentToday, 100_000);

        VaultBase.Receipt memory r = vault.getReceipt(rid);
        assertEq(r.sessionId, sessionId);
        assertEq(r.stallId, exactStall);
        assertEq(r.amount, 100_000);
        assertEq(r.mode, 0);
    }

    function test_revokedSessionCannotPay() public {
        vm.prank(owner);
        vault.revokeSession(sessionId);
        _payReverts(
            exactStall, 1000, sessionId, abi.encodeWithSelector(VaultBase.RevokedSession.selector, sessionId)
        );
    }

    function test_expiredSessionCannotPay() public {
        vm.warp(block.timestamp + 2 hours);
        _payReverts(
            exactStall, 1000, sessionId, abi.encodeWithSelector(VaultBase.SessionExpired.selector, sessionId)
        );
    }

    function test_inactiveStallCannotBePaid() public {
        vm.prank(seller);
        stalls.setActive(exactStall, false);
        _payReverts(
            exactStall, 1000, sessionId, abi.encodeWithSelector(VaultBase.StallInactive.selector, exactStall)
        );
    }

    function test_disallowedCategory() public {
        uint256 toolStall = _createStall(CAT_TOOL, 0, 1000);
        _payReverts(
            toolStall,
            1000,
            sessionId,
            abi.encodeWithSelector(VaultBase.CategoryNotAllowed.selector, sessionId, CAT_TOOL)
        );
    }

    function test_allowlistRestrictsToListedStalls() public {
        uint256 other = _createStall(CAT_KNOWLEDGE, 0, 1000);
        vm.prank(owner);
        vault.setStallAllowed(sessionId, other, true);

        _payReverts(
            exactStall,
            1000,
            sessionId,
            abi.encodeWithSelector(VaultBase.StallNotAllowed.selector, sessionId, exactStall)
        );
        _pay(other, 1000, sessionId);
    }

    function test_perPaymentCap() public {
        _payReverts(
            exactStall,
            200_001,
            sessionId,
            abi.encodeWithSelector(VaultBase.PerPaymentCapExceeded.selector, 200_001, 200_000)
        );
        _pay(exactStall, 200_000, sessionId);
    }

    function test_zeroAmountRejected() public {
        _payReverts(exactStall, 0, sessionId, abi.encodeWithSelector(VaultBase.ZeroAmount.selector));
    }

    function test_dailyCapResetsAtUtcMidnight() public {
        vm.warp(10 days + 1 hours);
        uint256 sid =
            _createSession(200_000, 300_000, 2e6, uint64(block.timestamp + 3 days), type(uint32).max);
        _pay(exactStall, 200_000, sid);
        _pay(exactStall, 100_000, sid);
        _payReverts(
            exactStall, 1, sid, abi.encodeWithSelector(VaultBase.DailyCapExceeded.selector, 300_001, 300_000)
        );

        vm.warp(11 days); // next UTC day
        (uint256 today,) = vault.remaining(sid);
        assertEq(today, 300_000);
        _pay(exactStall, 200_000, sid);
        assertEq(vault.getSession(sid).spentToday, 200_000);
    }

    function test_totalCap() public {
        uint256 sid =
            _createSession(200_000, 1e6, 250_000, uint64(block.timestamp + 1 hours), type(uint32).max);
        _pay(exactStall, 200_000, sid);
        _payReverts(
            exactStall,
            50_001,
            sid,
            abi.encodeWithSelector(VaultBase.TotalCapExceeded.selector, 250_001, 250_000)
        );
        _pay(exactStall, 50_000, sid);
        (, uint256 total) = vault.remaining(sid);
        assertEq(total, 0);
    }

    function test_ownerBalanceLimitsSpend() public {
        vm.prank(owner);
        vault.withdraw(3e6 - 1000);
        _payReverts(
            exactStall,
            1001,
            sessionId,
            abi.encodeWithSelector(VaultBase.InsufficientBalance.selector, 1001, 1000)
        );
    }

    function test_capsUpdateAppliesImmediately() public {
        vm.prank(owner);
        vault.updateCaps(sessionId, 10, 1e6, 2e6, uint64(block.timestamp + 1 hours));
        _payReverts(
            exactStall,
            11,
            sessionId,
            abi.encodeWithSelector(VaultBase.PerPaymentCapExceeded.selector, 11, 10)
        );
    }

    /// @dev Fuzz: whatever the agent tries, it never exceeds any cap.
    function testFuzz_neverExceedsCaps(uint256[8] memory amounts, uint8[8] memory dayHops) public {
        vm.warp(30 days);
        uint256 sid =
            _createSession(150_000, 400_000, 900_000, uint64(block.timestamp + 20 days), type(uint32).max);
        uint256 dayStart = block.timestamp / 1 days;
        uint256 spentInDay;
        uint256 spentTotal;
        for (uint256 k = 0; k < amounts.length; k++) {
            vm.warp(block.timestamp + uint256(dayHops[k] % 3) * 12 hours);
            if (block.timestamp / 1 days != dayStart) {
                dayStart = block.timestamp / 1 days;
                spentInDay = 0;
            }
            uint256 amt = bound(amounts[k], 1, 300_000);
            try this.payExternal(exactStall, amt, sid) {
                spentInDay += amt;
                spentTotal += amt;
            } catch {}
            assertLe(spentInDay, 400_000);
            assertLe(spentTotal, 900_000);
            assertEq(vault.getSession(sid).spentTotal, spentTotal);
        }
    }

    function payExternal(uint256 stallId, uint256 amount, uint256 sid) external {
        _pay(stallId, amount, sid);
    }
}
