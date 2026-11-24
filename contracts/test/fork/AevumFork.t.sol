// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {AgentVault} from "../../src/AgentVault.sol";
import {VaultBase} from "../../src/vault/VaultBase.sol";
import {IdentityRegistry} from "../../src/IdentityRegistry.sol";
import {StallRegistry} from "../../src/StallRegistry.sol";
import {ITUSD8} from "../../src/interfaces/ITUSD8.sol";

/// @notice Runs against a fork of Aevum with the real tUSD8. Opt in with AEVUM_FORK=1 (needs network).
///         `forge test --match-path test/fork/*` with AEVUM_FORK=1 AEVUM_RPC_URL=https://rpc-test.qday.info
contract AevumForkTest is Test {
    ITUSD8 internal constant TUSD8 = ITUSD8(0x456569838f1d43009A91ebA4263147Afd7233483);
    bytes32 internal constant RECEIVE_TYPEHASH = keccak256(
        "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );
    bytes32 internal constant PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");

    AgentVault internal vault;
    StallRegistry internal stalls;
    IdentityRegistry internal identities;

    uint256 internal ownerPk = 0x0123;
    address internal owner;
    uint256 internal agentPk = 0xA6E47;
    uint256 internal quotePk = 0x0907E;
    address internal seller = makeAddr("seller");
    address internal payee = makeAddr("payee");
    address internal treasury = makeAddr("treasury");
    bool internal enabled;

    function setUp() public {
        enabled = vm.envOr("AEVUM_FORK", false);
        if (!enabled) return;
        vm.createSelectFork(vm.envOr("AEVUM_RPC_URL", string("https://rpc-test.qday.info")));
        owner = vm.addr(ownerPk);

        identities = new IdentityRegistry();
        stalls =
            new StallRegistry(TUSD8, identities, address(this), address(this), treasury, 250_000, 1 hours);
        vault = new AgentVault(TUSD8, stalls, address(this), treasury, address(this), 300);

        deal(address(TUSD8), owner, 5e6);
        deal(address(TUSD8), seller, 1e6);
    }

    function _digest(bytes32 structHash) internal view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", TUSD8.DOMAIN_SEPARATOR(), structHash));
    }

    function test_fork_realTokenDomain() public {
        vm.skip(!enabled);
        assertEq(block.chainid, 44005);
        bytes32 expected = keccak256(
            abi.encode(
                keccak256(
                    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
                ),
                keccak256("tUSD8"),
                keccak256("2"),
                uint256(44005),
                address(TUSD8)
            )
        );
        assertEq(TUSD8.DOMAIN_SEPARATOR(), expected);
    }

    function test_fork_depositWithPermit() public {
        vm.skip(!enabled);
        uint256 deadline = block.timestamp + 1 hours;
        uint256 nonce = TUSD8.nonces(owner);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(
            ownerPk,
            _digest(keccak256(abi.encode(PERMIT_TYPEHASH, owner, address(vault), 2e6, nonce, deadline)))
        );
        vm.prank(owner);
        vault.depositWithPermit(2e6, deadline, v, r, s);
        assertEq(vault.balanceOf(owner), 2e6);
        assertEq(TUSD8.balanceOf(address(vault)), 2e6);
    }

    function test_fork_gaslessDepositWithAuthorization() public {
        vm.skip(!enabled);
        bytes32 nonce = keccak256("fork-fund-1");
        uint256 validBefore = block.timestamp + 10 minutes;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(
            ownerPk,
            _digest(
                keccak256(abi.encode(RECEIVE_TYPEHASH, owner, address(vault), 3e6, 0, validBefore, nonce))
            )
        );
        vm.prank(makeAddr("facilitator"));
        vault.depositWithAuthorization(owner, 3e6, 0, validBefore, nonce, v, r, s);
        assertEq(vault.balanceOf(owner), 3e6);
    }

    function test_fork_exactPaymentEndToEnd() public {
        vm.skip(!enabled);
        // Owner funds and grants a session.
        vm.startPrank(owner);
        TUSD8.approve(address(vault), 1e6);
        vault.deposit(1e6);
        uint256 sid = vault.createSession(
            VaultBase.SessionParams(
                vm.addr(agentPk),
                200_000,
                1e6,
                2e6,
                uint64(block.timestamp + 2 hours),
                type(uint32).max,
                false
            )
        );
        vm.stopPrank();

        // Seller lists a stall with the real token as stake.
        vm.startPrank(seller);
        uint256 idn = identities.register("fork.example", "");
        TUSD8.approve(address(stalls), 250_000);
        uint256 stallId = stalls.createStall(
            StallRegistry.StallParams(
                idn, payee, vm.addr(quotePk), 3, 0, 1000, "query", "https://x", "", 250_000
            )
        );
        vm.stopPrank();

        VaultBase.Quote memory q =
            VaultBase.Quote(stallId, 1000, keccak256("q"), 0, block.timestamp + 60, keccak256("n"));
        bytes32 qh = vault.hashQuote(q);
        VaultBase.PaymentIntent memory i = VaultBase.PaymentIntent(qh, sid, block.timestamp + 60, 1);
        (uint8 v1, bytes32 r1, bytes32 s1) = vm.sign(quotePk, qh);
        (uint8 v2, bytes32 r2, bytes32 s2) = vm.sign(agentPk, vault.hashIntent(i));
        vault.payExact(q, abi.encodePacked(r1, s1, v1), i, abi.encodePacked(r2, s2, v2));

        assertEq(TUSD8.balanceOf(payee), 970);
        assertEq(TUSD8.balanceOf(treasury), 30);
    }
}
