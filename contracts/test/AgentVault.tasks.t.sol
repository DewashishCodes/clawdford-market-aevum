// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {VaultFixture} from "./utils/VaultFixture.sol";
import {VaultBase} from "../src/vault/VaultBase.sol";
import {VaultTasks} from "../src/vault/VaultTasks.sol";

contract AgentVaultTasksTest is VaultFixture {
    uint256 internal taskStall;
    bytes32 internal constant SPEC = keccak256("review this NDA");

    function setUp() public override {
        super.setUp();
        taskStall = _createStall(7, 2, 100_000); // human, task, 0.1 per task
    }

    function _hash(bytes32 structHash) internal view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", vault.DOMAIN_SEPARATOR(), structHash));
    }

    function _createSig(
        uint256 sid,
        uint256 stallId,
        uint256 amount,
        uint256 deadline,
        uint256 vb,
        uint256 nonce
    ) internal view returns (bytes memory) {
        return _sign(
            agentPk,
            _hash(
                keccak256(
                    abi.encode(vault.CREATE_TASK_TYPEHASH(), sid, stallId, amount, SPEC, deadline, vb, nonce)
                )
            )
        );
    }

    function _create(uint256 sid, uint256 amount) internal returns (uint256 taskId) {
        uint256 deadline = block.timestamp + 1 days;
        uint256 vb = block.timestamp + 5 minutes;
        uint256 nonce = nextNonce++;
        bytes memory sig = _createSig(sid, taskStall, amount, deadline, vb, nonce);
        vm.prank(relayer);
        taskId = vault.createTask(sid, taskStall, amount, SPEC, deadline, vb, nonce, sig);
    }

    function _submit(uint256 taskId) internal {
        vm.prank(seller);
        vault.submitResult(taskId, keccak256("memo"), "ipfs://memo");
    }

    // ------------------------------------------------------------ create

    function test_createEscrowsAndCharges() public {
        uint256 tid = _create(sessionId, 100_000);
        VaultTasks.Task memory t = vault.getTask(tid);
        assertEq(uint8(t.status), uint8(VaultTasks.TaskStatus.Open));
        assertEq(t.payee, payee);
        assertEq(t.seller, seller);
        assertEq(t.amount, 100_000);
        assertEq(t.specHash, SPEC);
        assertEq(vault.balanceOf(owner), 3e6 - 100_000);
        assertEq(vault.getSession(sessionId).spentTotal, 100_000);
    }

    function test_createValidation() public {
        uint256 vb = block.timestamp + 60;
        uint256 deadline = block.timestamp + 1 days;
        bytes memory sig = _createSig(sessionId, exactStall, 1000, deadline, vb, 1);
        vm.expectRevert(abi.encodeWithSelector(VaultBase.WrongMode.selector, exactStall, 0));
        vault.createTask(sessionId, exactStall, 1000, SPEC, deadline, vb, 1, sig);

        sig = _createSig(sessionId, taskStall, 1000, block.timestamp, vb, 1);
        vm.expectRevert(VaultTasks.InvalidDeadline.selector);
        vault.createTask(sessionId, taskStall, 1000, SPEC, block.timestamp, vb, 1, sig);

        sig = _createSig(sessionId, taskStall, 300_000, deadline, vb, 1);
        vm.expectRevert(abi.encodeWithSelector(VaultBase.PerPaymentCapExceeded.selector, 300_000, 200_000));
        vault.createTask(sessionId, taskStall, 300_000, SPEC, deadline, vb, 1, sig);
    }

    // ------------------------------------------------------------ submit / approve

    function test_ownerApprovesAndSellerIsPaid() public {
        uint256 tid = _create(sessionId, 100_000);
        _submit(tid);
        VaultTasks.Task memory t = vault.getTask(tid);
        assertEq(uint8(t.status), uint8(VaultTasks.TaskStatus.Submitted));
        assertEq(t.resultURI, "ipfs://memo");
        assertEq(t.reviewEnd, block.timestamp + 1 hours);

        vm.prank(owner);
        vault.approve(tid);
        assertEq(uint8(vault.getTask(tid).status), uint8(VaultTasks.TaskStatus.Released));
        assertEq(token.balanceOf(payee), 97_000);
        assertEq(vault.getReceipt(vault.receiptCount()).mode, 2);
    }

    function test_submitRules() public {
        uint256 tid = _create(sessionId, 100_000);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(VaultTasks.NotTaskSeller.selector, tid, owner));
        vault.submitResult(tid, bytes32(0), "");

        uint64 deadline = vault.getTask(tid).deadline;
        vm.warp(deadline);
        vm.prank(payee);
        vm.expectRevert(abi.encodeWithSelector(VaultTasks.DeadlinePassed.selector, deadline));
        vault.submitResult(tid, bytes32(0), "");
    }

    function test_agentApprovalNeedsSessionFlag() public {
        uint256 tid = _create(sessionId, 100_000);
        _submit(tid);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(VaultTasks.NotTaskApprover.selector, tid, agent));
        vault.approve(tid);

        bytes memory sig = _sign(agentPk, _hash(keccak256(abi.encode(vault.APPROVE_TASK_TYPEHASH(), tid))));
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(VaultTasks.NotTaskApprover.selector, tid, relayer));
        vault.approveWithSig(tid, sig);
    }

    function test_agentMayApproveWhenAllowed() public {
        vm.prank(owner);
        uint256 sid = vault.createSession(
            VaultBase.SessionParams(
                agent, 200_000, 1e6, 2e6, uint64(block.timestamp + 1 hours), type(uint32).max, true
            )
        );
        uint256 a = _create(sid, 100_000);
        uint256 b = _create(sid, 50_000);
        _submit(a);
        _submit(b);

        vm.prank(agent);
        vault.approve(a);

        bytes memory sig = _sign(agentPk, _hash(keccak256(abi.encode(vault.APPROVE_TASK_TYPEHASH(), b))));
        vm.prank(relayer);
        vault.approveWithSig(b, sig);
        assertEq(token.balanceOf(payee), 97_000 + 48_500);
    }

    function test_autoReleaseAfterWindow() public {
        uint256 tid = _create(sessionId, 100_000);
        _submit(tid);
        uint64 reviewEnd = vault.getTask(tid).reviewEnd;
        vm.expectRevert(abi.encodeWithSelector(VaultTasks.ReviewWindowOpen.selector, reviewEnd));
        vault.autoRelease(tid);
        vm.warp(reviewEnd);
        vault.autoRelease(tid);
        assertEq(uint8(vault.getTask(tid).status), uint8(VaultTasks.TaskStatus.Released));

        vm.expectRevert(
            abi.encodeWithSelector(VaultTasks.WrongTaskStatus.selector, tid, VaultTasks.TaskStatus.Released)
        );
        vault.autoRelease(tid);
    }

    // ------------------------------------------------------------ dispute / resolve

    function test_disputeAndResolveSplit() public {
        uint256 tid = _create(sessionId, 100_000);
        _submit(tid);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(VaultTasks.NotTaskApprover.selector, tid, agent));
        vault.dispute(tid);

        vm.prank(owner);
        vault.dispute(tid);

        vm.expectRevert(abi.encodeWithSelector(VaultBase.NotArbiter.selector, address(this)));
        vault.resolve(tid, 5000);
        vm.prank(arbiter);
        vm.expectRevert(abi.encodeWithSelector(VaultTasks.InvalidBps.selector, 10_001));
        vault.resolve(tid, 10_001);

        vm.prank(arbiter);
        vault.resolve(tid, 6000);
        assertEq(vault.balanceOf(owner), 3e6 - 40_000);
        assertEq(vault.getSession(sessionId).spentTotal, 40_000);
        assertEq(token.balanceOf(payee), 40_000 - 1_200);
        assertEq(uint8(vault.getTask(tid).status), uint8(VaultTasks.TaskStatus.Resolved));
    }

    function test_fullBuyerRefundOnResolve() public {
        uint256 tid = _create(sessionId, 100_000);
        _submit(tid);
        vm.prank(owner);
        vault.dispute(tid);
        vm.prank(arbiter);
        vault.resolve(tid, 10_000);
        assertEq(vault.balanceOf(owner), 3e6);
        assertEq(token.balanceOf(payee), 0);
    }

    function test_disputeClosedAfterWindow() public {
        uint256 tid = _create(sessionId, 100_000);
        _submit(tid);
        uint64 reviewEnd = vault.getTask(tid).reviewEnd;
        vm.warp(reviewEnd);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(VaultTasks.ReviewWindowClosed.selector, reviewEnd));
        vault.dispute(tid);
    }

    // ------------------------------------------------------------ cancel

    function test_cancelRefundsUndeliveredTask() public {
        uint256 tid = _create(sessionId, 100_000);
        uint64 deadline = vault.getTask(tid).deadline;
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(VaultTasks.DeadlineNotPassed.selector, deadline));
        vault.cancel(tid);

        vm.prank(payee);
        vm.expectRevert(abi.encodeWithSelector(VaultTasks.NotTaskApprover.selector, tid, payee));
        vault.cancel(tid);

        vm.warp(deadline);
        vm.prank(agent);
        vault.cancel(tid);
        assertEq(vault.balanceOf(owner), 3e6);
        assertEq(vault.getSession(sessionId).spentTotal, 0);
        assertEq(uint8(vault.getTask(tid).status), uint8(VaultTasks.TaskStatus.Refunded));
    }

    function test_unknownTask() public {
        vm.expectRevert(abi.encodeWithSelector(VaultTasks.UnknownTask.selector, 42));
        vault.autoRelease(42);
    }

    function test_setReviewWindow() public {
        vm.prank(admin);
        vault.setReviewWindow(60);
        assertEq(vault.reviewWindow(), 60);
    }
}
