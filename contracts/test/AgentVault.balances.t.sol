// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {VaultFixture} from "./utils/VaultFixture.sol";
import {AgentVault} from "../src/AgentVault.sol";
import {VaultBase} from "../src/vault/VaultBase.sol";
import {ITUSD8} from "../src/interfaces/ITUSD8.sol";

contract AgentVaultBalancesTest is VaultFixture {
    function test_constructorValidation() public {
        vm.expectRevert(VaultBase.ZeroAddress.selector);
        new AgentVault(ITUSD8(address(0)), stalls, admin, treasury, arbiter, FEE_BPS);
        vm.expectRevert(VaultBase.ZeroAddress.selector);
        new AgentVault(ITUSD8(address(token)), stalls, admin, address(0), arbiter, FEE_BPS);
        vm.expectRevert(abi.encodeWithSelector(VaultBase.FeeTooHigh.selector, 1001));
        new AgentVault(ITUSD8(address(token)), stalls, admin, treasury, arbiter, 1001);
    }

    function test_depositAndWithdraw() public {
        assertEq(vault.balanceOf(owner), 3e6);
        assertEq(token.balanceOf(address(vault)), 3e6);

        vm.prank(owner);
        vault.withdraw(1e6);
        assertEq(vault.balanceOf(owner), 2e6);
        assertEq(token.balanceOf(owner), 8e6);

        vm.startPrank(owner);
        vm.expectRevert(abi.encodeWithSelector(VaultBase.InsufficientBalance.selector, 3e6, 2e6));
        vault.withdraw(3e6);
        vm.expectRevert(VaultBase.ZeroAmount.selector);
        vault.withdraw(0);
        vm.expectRevert(VaultBase.ZeroAmount.selector);
        vault.deposit(0);
        vm.stopPrank();
    }

    function test_depositWithPermit() public {
        uint256 pk = 0xF00D;
        address o = vm.addr(pk);
        token.mint(o, 1e6);
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 structHash =
            keccak256(abi.encode(token.PERMIT_TYPEHASH(), o, address(vault), 1e6, 0, deadline));
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(pk, keccak256(abi.encodePacked("\x19\x01", token.DOMAIN_SEPARATOR(), structHash)));
        vm.prank(o);
        vault.depositWithPermit(1e6, deadline, v, r, s);
        assertEq(vault.balanceOf(o), 1e6);
    }

    function test_depositWithAuthorizationIsGaslessForOwner() public {
        uint256 pk = 0xBEEF;
        address o = vm.addr(pk);
        token.mint(o, 1e6);
        bytes32 nonce = keccak256("fund-1");
        uint256 validBefore = block.timestamp + 10 minutes;
        bytes32 structHash = keccak256(
            abi.encode(
                token.RECEIVE_WITH_AUTHORIZATION_TYPEHASH(), o, address(vault), 5e5, 0, validBefore, nonce
            )
        );
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(pk, keccak256(abi.encodePacked("\x19\x01", token.DOMAIN_SEPARATOR(), structHash)));

        vm.prank(relayer); // facilitator pays gas, owner never sends a tx
        vault.depositWithAuthorization(o, 5e5, 0, validBefore, nonce, v, r, s);
        assertEq(vault.balanceOf(o), 5e5);
        assertEq(vault.balanceOf(relayer), 0);

        vm.expectRevert(VaultBase.ZeroAmount.selector);
        vault.depositWithAuthorization(o, 0, 0, validBefore, nonce, v, r, s);
    }

    function test_adminSetters() public {
        vm.startPrank(admin);
        vault.setFeeBps(1000);
        vm.expectRevert(abi.encodeWithSelector(VaultBase.FeeTooHigh.selector, 1001));
        vault.setFeeBps(1001);
        vault.setTreasury(address(1));
        vault.setArbiter(address(2));
        vm.expectRevert(VaultBase.ZeroAddress.selector);
        vault.setTreasury(address(0));
        vm.expectRevert(VaultBase.ZeroAddress.selector);
        vault.setArbiter(address(0));
        vm.stopPrank();
        assertEq(vault.feeBps(), 1000);
        assertEq(vault.treasury(), address(1));
        assertEq(vault.arbiter(), address(2));

        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        vault.setFeeBps(0);
    }
}
