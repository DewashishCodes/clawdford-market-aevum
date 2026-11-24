// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IStallRegistry} from "../interfaces/IStallRegistry.sol";
import {VaultBase} from "./VaultBase.sol";

/// @title VaultTasks
/// @notice `task` mode: escrow until the buyer accepts the delivery. The seller submits a result, the owner (or the
///         agent, if the session allows it) approves, or it auto-releases after the review window. The owner can
///         dispute inside the window and the arbiter splits the escrow. The buyer is refunded if the seller never
///         delivers by the deadline.
abstract contract VaultTasks is VaultBase {
    bytes32 public constant CREATE_TASK_TYPEHASH = keccak256(
        "CreateTask(uint256 sessionId,uint256 stallId,uint256 amount,bytes32 specHash,uint256 deadline,uint256 validBefore,uint256 nonce)"
    );
    bytes32 public constant APPROVE_TASK_TYPEHASH = keccak256("ApproveTask(uint256 taskId)");

    enum TaskStatus {
        None,
        Open,
        Submitted,
        Disputed,
        Released,
        Refunded,
        Resolved
    }

    struct Task {
        uint256 sessionId;
        uint256 stallId;
        address payee; // fixed at creation
        address seller; // stall owner at creation, may submit results
        uint128 amount;
        uint64 chargeDay;
        uint64 deadline; // seller must submit before this
        uint64 reviewEnd; // set on submit
        TaskStatus status;
        bytes32 specHash;
        bytes32 resultHash;
        string resultURI;
    }

    uint64 public reviewWindow = 1 hours;
    uint256 public taskCount;
    mapping(uint256 taskId => Task) internal _tasks;

    event TaskCreated(
        uint256 indexed taskId,
        uint256 indexed sessionId,
        uint256 indexed stallId,
        uint256 amount,
        bytes32 specHash
    );
    event TaskSubmitted(uint256 indexed taskId, bytes32 resultHash, string resultURI, uint64 reviewEnd);
    event TaskReleased(uint256 indexed taskId, uint256 indexed receiptId, address by);
    event TaskDisputed(uint256 indexed taskId);
    event TaskResolved(uint256 indexed taskId, uint16 buyerBps, uint256 refunded, uint256 paid);
    event TaskCancelled(uint256 indexed taskId);
    event ReviewWindowSet(uint64 window);

    error UnknownTask(uint256 taskId);
    error WrongTaskStatus(uint256 taskId, TaskStatus status);
    error NotTaskSeller(uint256 taskId, address caller);
    error NotTaskApprover(uint256 taskId, address caller);
    error InvalidDeadline();
    error DeadlinePassed(uint64 deadline);
    error DeadlineNotPassed(uint64 deadline);
    error ReviewWindowOpen(uint64 reviewEnd);
    error ReviewWindowClosed(uint64 reviewEnd);
    error InvalidBps(uint16 bps);

    function setReviewWindow(uint64 window) external onlyOwner {
        reviewWindow = window;
        emit ReviewWindowSet(window);
    }

    /// @notice Escrow `amount` for a task from an agent-signed CreateTask message. Anyone may relay it.
    function createTask(
        uint256 sessionId,
        uint256 stallId,
        uint256 amount,
        bytes32 specHash,
        uint256 deadline,
        uint256 validBefore,
        uint256 nonce,
        bytes calldata agentSig
    ) external nonReentrant returns (uint256 taskId) {
        IStallRegistry.PaymentInfo memory info = stalls.paymentInfo(stallId);
        if (info.mode != MODE_TASK) revert WrongMode(stallId, info.mode);
        if (deadline <= block.timestamp || deadline > type(uint64).max) revert InvalidDeadline();
        bytes32 digest = _hashTypedDataV4(
            keccak256(
                abi.encode(
                    CREATE_TASK_TYPEHASH, sessionId, stallId, amount, specHash, deadline, validBefore, nonce
                )
            )
        );
        _useSignedNonce(sessionId, validBefore, nonce, digest, agentSig);

        _charge(sessionId, stallId, info, amount);

        taskId = ++taskCount;
        Task storage t = _tasks[taskId];
        t.sessionId = sessionId;
        t.stallId = stallId;
        t.payee = info.payee;
        t.seller = info.owner;
        t.amount = uint128(amount);
        t.chargeDay = uint64(block.timestamp / 1 days);
        t.deadline = uint64(deadline);
        t.status = TaskStatus.Open;
        t.specHash = specHash;
        emit TaskCreated(taskId, sessionId, stallId, amount, specHash);
    }

    /// @notice Seller (stall owner or payee) delivers before the deadline. Starts the review window.
    function submitResult(uint256 taskId, bytes32 resultHash, string calldata resultURI) external {
        Task storage t = _taskIn(taskId, TaskStatus.Open);
        if (msg.sender != t.seller && msg.sender != t.payee) revert NotTaskSeller(taskId, msg.sender);
        if (block.timestamp >= t.deadline) revert DeadlinePassed(t.deadline);
        t.resultHash = resultHash;
        t.resultURI = resultURI;
        t.reviewEnd = uint64(block.timestamp) + reviewWindow;
        t.status = TaskStatus.Submitted;
        emit TaskSubmitted(taskId, resultHash, resultURI, t.reviewEnd);
    }

    /// @notice Owner accepts the result, or the agent itself when the session has `agentCanApprove`.
    function approve(uint256 taskId) external nonReentrant {
        Task storage t = _taskIn(taskId, TaskStatus.Submitted);
        Session storage s = _sessions[t.sessionId];
        bool agentOk = s.agentCanApprove && msg.sender == s.agentKey;
        if (msg.sender != s.owner && !agentOk) revert NotTaskApprover(taskId, msg.sender);
        _release(taskId, t);
    }

    /// @notice Gasless approval by the agent (needs `agentCanApprove`), relayed by anyone.
    function approveWithSig(uint256 taskId, bytes calldata agentSig) external nonReentrant {
        Task storage t = _taskIn(taskId, TaskStatus.Submitted);
        if (!_sessions[t.sessionId].agentCanApprove) revert NotTaskApprover(taskId, msg.sender);
        _requireAgent(
            t.sessionId, _hashTypedDataV4(keccak256(abi.encode(APPROVE_TASK_TYPEHASH, taskId))), agentSig
        );
        _release(taskId, t);
    }

    /// @notice Anyone may release a submitted task once the review window passes without a dispute.
    function autoRelease(uint256 taskId) external nonReentrant {
        Task storage t = _taskIn(taskId, TaskStatus.Submitted);
        if (block.timestamp < t.reviewEnd) revert ReviewWindowOpen(t.reviewEnd);
        _release(taskId, t);
    }

    /// @notice Owner disputes inside the review window. Funds stay in escrow until the arbiter resolves.
    function dispute(uint256 taskId) external {
        Task storage t = _taskIn(taskId, TaskStatus.Submitted);
        if (msg.sender != _sessions[t.sessionId].owner) revert NotTaskApprover(taskId, msg.sender);
        if (block.timestamp >= t.reviewEnd) revert ReviewWindowClosed(t.reviewEnd);
        t.status = TaskStatus.Disputed;
        emit TaskDisputed(taskId);
    }

    /// @notice Arbiter splits a disputed escrow: `buyerBps` back to the owner, the rest to the payee minus the fee.
    function resolve(uint256 taskId, uint16 buyerBps) external nonReentrant {
        if (msg.sender != arbiter) revert NotArbiter(msg.sender);
        if (buyerBps > BPS) revert InvalidBps(buyerBps);
        Task storage t = _taskIn(taskId, TaskStatus.Disputed);
        t.status = TaskStatus.Resolved;
        uint256 refund = uint256(t.amount) * buyerBps / BPS;
        uint256 paid = t.amount - refund;
        _refund(t.sessionId, refund, t.chargeDay, t.amount);
        if (paid != 0) _payout(t.sessionId, t.stallId, t.payee, paid, MODE_TASK);
        emit TaskResolved(taskId, buyerBps, refund, paid);
    }

    /// @notice Refund the buyer when the seller never submitted by the deadline. Owner or agent may call.
    function cancel(uint256 taskId) external nonReentrant {
        Task storage t = _taskIn(taskId, TaskStatus.Open);
        Session storage s = _sessions[t.sessionId];
        if (msg.sender != s.owner && msg.sender != s.agentKey) revert NotTaskApprover(taskId, msg.sender);
        if (block.timestamp < t.deadline) revert DeadlineNotPassed(t.deadline);
        t.status = TaskStatus.Refunded;
        _refund(t.sessionId, t.amount, t.chargeDay, t.amount);
        emit TaskCancelled(taskId);
    }

    function _release(uint256 taskId, Task storage t) private {
        t.status = TaskStatus.Released;
        uint256 receiptId = _payout(t.sessionId, t.stallId, t.payee, t.amount, MODE_TASK);
        emit TaskReleased(taskId, receiptId, msg.sender);
    }

    function _taskIn(uint256 taskId, TaskStatus expected) internal view returns (Task storage t) {
        t = _tasks[taskId];
        if (t.status == TaskStatus.None) revert UnknownTask(taskId);
        if (t.status != expected) revert WrongTaskStatus(taskId, t.status);
    }

    function getTask(uint256 taskId) external view returns (Task memory) {
        return _tasks[taskId];
    }
}
