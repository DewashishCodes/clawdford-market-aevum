// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {AgentVault} from "../../src/AgentVault.sol";
import {VaultBase} from "../../src/vault/VaultBase.sol";
import {VaultTasks} from "../../src/vault/VaultTasks.sol";
import {MockTUSD8} from "../../src/mocks/MockTUSD8.sol";

/// @notice Drives random sequences of every vault action for the invariant suite and keeps ghost counters.
contract VaultHandler is Test {
    AgentVault public vault;
    MockTUSD8 public token;

    address public owner;
    address public seller;
    uint256 internal agentPk;
    uint256 internal quotePk;

    uint256 public sessionId;
    uint256 public exactStall;
    uint256 public streamStall;
    uint256 public taskStall;
    uint256 public toolStall; // category the session does not allow

    uint256[] public channels;
    uint256[] public tasks;
    mapping(uint256 channelId => uint256) public signedCumulative;

    uint256 internal nonce = 1_000_000;

    // ghost state
    bool public revoked;
    uint256 public chargesAfterRevoke;
    uint256 public disallowedPaid;
    uint256 public maxSpentTodaySeen;
    uint256 public calls;

    constructor(
        AgentVault vault_,
        MockTUSD8 token_,
        address owner_,
        address seller_,
        uint256 agentPk_,
        uint256 quotePk_,
        uint256 sessionId_,
        uint256[4] memory stalls_
    ) {
        vault = vault_;
        token = token_;
        owner = owner_;
        seller = seller_;
        agentPk = agentPk_;
        quotePk = quotePk_;
        sessionId = sessionId_;
        exactStall = stalls_[0];
        streamStall = stalls_[1];
        taskStall = stalls_[2];
        toolStall = stalls_[3];
    }

    // ------------------------------------------------------------ helpers

    function _sig(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _typed(bytes32 structHash) internal view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", vault.DOMAIN_SEPARATOR(), structHash));
    }

    function _spentTotal() internal view returns (uint256) {
        return vault.getSession(sessionId).spentTotal;
    }

    function _track(uint256 spentBefore) internal {
        VaultBase.Session memory s = vault.getSession(sessionId);
        if (revoked && s.spentTotal > spentBefore) chargesAfterRevoke++;
        if (s.spentToday > maxSpentTodaySeen) maxSpentTodaySeen = s.spentToday;
        calls++;
    }

    function _payQuote(uint256 stallId, uint256 amount) internal returns (bool ok) {
        VaultBase.Quote memory q = VaultBase.Quote(
            stallId, amount, keccak256("r"), 0, block.timestamp + 60, keccak256(abi.encode(nonce++))
        );
        bytes32 qh = vault.hashQuote(q);
        VaultBase.PaymentIntent memory i =
            VaultBase.PaymentIntent(qh, sessionId, block.timestamp + 60, nonce++);
        bytes memory qs = _sig(quotePk, qh);
        bytes memory is_ = _sig(agentPk, vault.hashIntent(i));
        try vault.payExact(q, qs, i, is_) {
            ok = true;
        } catch {}
    }

    // ------------------------------------------------------------ actions

    function payExact(uint256 amount) external {
        uint256 before = _spentTotal();
        _payQuote(exactStall, bound(amount, 1, 300_000));
        _track(before);
    }

    function payDisallowed(uint256 amount) external {
        uint256 before = _spentTotal();
        if (_payQuote(toolStall, bound(amount, 1, 100_000))) disallowedPaid++;
        _track(before);
    }

    function openChannel(uint256 deposit) external {
        uint256 before = _spentTotal();
        deposit = bound(deposit, 1, 250_000);
        uint256 vb = block.timestamp + 60;
        uint256 n = nonce++;
        bytes memory sig = _sig(
            agentPk,
            _typed(
                keccak256(abi.encode(vault.OPEN_CHANNEL_TYPEHASH(), sessionId, streamStall, deposit, vb, n))
            )
        );
        try vault.openChannel(sessionId, streamStall, deposit, vb, n, sig) returns (uint256 cid) {
            channels.push(cid);
        } catch {}
        _track(before);
    }

    function topUp(uint256 seed, uint256 amount) external {
        if (channels.length == 0) return;
        uint256 before = _spentTotal();
        uint256 cid = channels[seed % channels.length];
        amount = bound(amount, 1, 100_000);
        uint256 vb = block.timestamp + 60;
        uint256 n = nonce++;
        bytes memory sig =
            _sig(agentPk, _typed(keccak256(abi.encode(vault.TOP_UP_TYPEHASH(), cid, amount, vb, n))));
        try vault.topUp(cid, amount, vb, n, sig) {} catch {}
        _track(before);
    }

    function claim(uint256 seed, uint256 step) external {
        if (channels.length == 0) return;
        uint256 cid = channels[seed % channels.length];
        uint256 dep = vault.getChannel(cid).deposit;
        uint256 next = signedCumulative[cid] + bound(step, 1, 50_000);
        if (next > dep) next = dep;
        signedCumulative[cid] = next;
        bytes memory sig = _sig(agentPk, vault.hashVoucher(cid, next));
        try vault.claim(cid, next, sig) {} catch {}
        calls++;
    }

    function requestClose(uint256 seed) external {
        if (channels.length == 0) return;
        vm.prank(owner);
        try vault.requestClose(channels[seed % channels.length]) {} catch {}
        calls++;
    }

    function finalizeClose(uint256 seed) external {
        if (channels.length == 0) return;
        try vault.finalizeClose(channels[seed % channels.length]) {} catch {}
        calls++;
    }

    function createTask(uint256 amount) external {
        uint256 before = _spentTotal();
        amount = bound(amount, 1, 250_000);
        uint256 deadline = block.timestamp + 1 hours;
        uint256 vb = block.timestamp + 60;
        uint256 n = nonce++;
        bytes32 spec = keccak256("spec");
        bytes memory sig = _sig(
            agentPk,
            _typed(
                keccak256(
                    abi.encode(
                        vault.CREATE_TASK_TYPEHASH(), sessionId, taskStall, amount, spec, deadline, vb, n
                    )
                )
            )
        );
        try vault.createTask(sessionId, taskStall, amount, spec, deadline, vb, n, sig) returns (uint256 tid) {
            tasks.push(tid);
        } catch {}
        _track(before);
    }

    function progressTask(uint256 seed, uint8 action, uint16 bps) external {
        if (tasks.length == 0) return;
        uint256 tid = tasks[seed % tasks.length];
        action = action % 6;
        if (action == 0) {
            vm.prank(seller);
            try vault.submitResult(tid, keccak256("res"), "uri") {} catch {}
        } else if (action == 1) {
            vm.prank(owner);
            try vault.approve(tid) {} catch {}
        } else if (action == 2) {
            try vault.autoRelease(tid) {} catch {}
        } else if (action == 3) {
            vm.prank(owner);
            try vault.dispute(tid) {} catch {}
        } else if (action == 4) {
            vm.prank(vault.arbiter());
            try vault.resolve(tid, uint16(bound(bps, 0, 10_000))) {} catch {}
        } else {
            vm.prank(owner);
            try vault.cancel(tid) {} catch {}
        }
        calls++;
    }

    function deposit(uint256 amount) external {
        amount = bound(amount, 1, 1e6);
        token.mint(owner, amount);
        vm.prank(owner);
        vault.deposit(amount);
        calls++;
    }

    function withdraw(uint256 amount) external {
        uint256 bal = vault.balanceOf(owner);
        if (bal == 0) return;
        vm.prank(owner);
        vault.withdraw(bound(amount, 1, bal));
        calls++;
    }

    function warp(uint256 secs) external {
        vm.warp(block.timestamp + bound(secs, 1, 6 hours));
        calls++;
    }

    function revoke(uint256 dice) external {
        if (revoked || dice % 50 != 0) return; // rare, so most runs explore a live session
        vm.prank(owner);
        vault.revokeSession(sessionId);
        revoked = true;
        calls++;
    }

    // ------------------------------------------------------------ views for invariants

    function channelCount() external view returns (uint256) {
        return channels.length;
    }

    function taskCount() external view returns (uint256) {
        return tasks.length;
    }

    /// @notice Sum of funds the vault must still hold for channels and escrow.
    function lockedFunds() external view returns (uint256 total) {
        for (uint256 k = 0; k < channels.length; k++) {
            if (!vault.getChannel(channels[k]).finalized) {
                total += vault.getChannel(channels[k]).deposit - vault.getChannel(channels[k]).claimed;
            }
        }
        for (uint256 k = 0; k < tasks.length; k++) {
            VaultTasks.Task memory t = vault.getTask(tasks[k]);
            if (
                t.status == VaultTasks.TaskStatus.Open || t.status == VaultTasks.TaskStatus.Submitted
                    || t.status == VaultTasks.TaskStatus.Disputed
            ) total += t.amount;
        }
    }
}
