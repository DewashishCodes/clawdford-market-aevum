// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {MockTUSD8} from "../src/mocks/MockTUSD8.sol";

contract MockTUSD8Test is Test {
    MockTUSD8 internal token;
    uint256 internal alicePk = 0xA11CE;
    address internal alice;
    address internal bob = makeAddr("bob");

    function setUp() public {
        token = new MockTUSD8();
        alice = vm.addr(alicePk);
        token.mint(alice, 10e6);
    }

    function _digest(bytes32 structHash) internal view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", token.DOMAIN_SEPARATOR(), structHash));
    }

    function _authSig(bytes32 typehash, address to, uint256 value, uint256 after_, uint256 before_, bytes32 nonce)
        internal
        view
        returns (uint8 v, bytes32 r, bytes32 s)
    {
        return vm.sign(alicePk, _digest(keccak256(abi.encode(typehash, alice, to, value, after_, before_, nonce))));
    }

    function test_metadataMatchesAevumToken() public view {
        assertEq(token.decimals(), 6);
        assertEq(token.name(), "tUSD8");
        bytes32 expected = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("tUSD8"),
                keccak256("2"),
                block.chainid,
                address(token)
            )
        );
        assertEq(token.DOMAIN_SEPARATOR(), expected);
    }

    function test_permitSetsAllowanceAndBumpsNonce() public {
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 structHash = keccak256(abi.encode(token.PERMIT_TYPEHASH(), alice, bob, 5e6, 0, deadline));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(alicePk, _digest(structHash));
        token.permit(alice, bob, 5e6, deadline, v, r, s);
        assertEq(token.allowance(alice, bob), 5e6);
        assertEq(token.nonces(alice), 1);
    }

    function test_permitRevertsWhenExpiredOrReplayed() public {
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 structHash = keccak256(abi.encode(token.PERMIT_TYPEHASH(), alice, bob, 5e6, 0, deadline));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(alicePk, _digest(structHash));
        token.permit(alice, bob, 5e6, deadline, v, r, s);
        vm.expectPartialRevert(MockTUSD8.InvalidSigner.selector);
        token.permit(alice, bob, 5e6, deadline, v, r, s);

        vm.warp(deadline + 1);
        vm.expectRevert(abi.encodeWithSelector(MockTUSD8.PermitExpired.selector, deadline));
        token.permit(alice, bob, 5e6, deadline, v, r, s);
    }

    function test_transferWithAuthorization() public {
        bytes32 nonce = keccak256("n1");
        (uint8 v, bytes32 r, bytes32 s) =
            _authSig(token.TRANSFER_WITH_AUTHORIZATION_TYPEHASH(), bob, 3e6, 0, block.timestamp + 60, nonce);
        token.transferWithAuthorization(alice, bob, 3e6, 0, block.timestamp + 60, nonce, v, r, s);
        assertEq(token.balanceOf(bob), 3e6);
        assertTrue(token.authorizationState(alice, nonce));

        vm.expectRevert(abi.encodeWithSelector(MockTUSD8.AuthorizationAlreadyUsed.selector, nonce));
        token.transferWithAuthorization(alice, bob, 3e6, 0, block.timestamp + 60, nonce, v, r, s);
    }

    function test_receiveWithAuthorizationOnlyByPayee() public {
        bytes32 nonce = keccak256("n2");
        uint256 before_ = block.timestamp + 60;
        (uint8 v, bytes32 r, bytes32 s) =
            _authSig(token.RECEIVE_WITH_AUTHORIZATION_TYPEHASH(), bob, 1e6, 0, before_, nonce);

        vm.expectRevert(abi.encodeWithSelector(MockTUSD8.CallerMustBePayee.selector, address(this), bob));
        token.receiveWithAuthorization(alice, bob, 1e6, 0, before_, nonce, v, r, s);

        vm.prank(bob);
        token.receiveWithAuthorization(alice, bob, 1e6, 0, before_, nonce, v, r, s);
        assertEq(token.balanceOf(bob), 1e6);
    }

    function test_authorizationWindow() public {
        vm.warp(1000);
        bytes32 nonce = keccak256("n3");
        bytes32 th = token.TRANSFER_WITH_AUTHORIZATION_TYPEHASH();
        (uint8 v, bytes32 r, bytes32 s) = _authSig(th, bob, 1, 1000, 2000, nonce);
        vm.expectRevert(MockTUSD8.AuthorizationNotYetValid.selector);
        token.transferWithAuthorization(alice, bob, 1, 1000, 2000, nonce, v, r, s);

        vm.warp(2000);
        vm.expectRevert(MockTUSD8.AuthorizationExpired.selector);
        token.transferWithAuthorization(alice, bob, 1, 1000, 2000, nonce, v, r, s);
    }

    function test_cancelAuthorizationBlocksUse() public {
        bytes32 nonce = keccak256("n4");
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(alicePk, _digest(keccak256(abi.encode(token.CANCEL_AUTHORIZATION_TYPEHASH(), alice, nonce))));
        token.cancelAuthorization(alice, nonce, v, r, s);
        vm.expectRevert(abi.encodeWithSelector(MockTUSD8.AuthorizationAlreadyUsed.selector, nonce));
        token.cancelAuthorization(alice, nonce, v, r, s);

        (v, r, s) = _authSig(token.TRANSFER_WITH_AUTHORIZATION_TYPEHASH(), bob, 1, 0, block.timestamp + 60, nonce);
        vm.expectRevert(abi.encodeWithSelector(MockTUSD8.AuthorizationAlreadyUsed.selector, nonce));
        token.transferWithAuthorization(alice, bob, 1, 0, block.timestamp + 60, nonce, v, r, s);
    }

    function test_wrongSignerRejected() public {
        bytes32 nonce = keccak256("n5");
        bytes32 structHash = keccak256(
            abi.encode(token.TRANSFER_WITH_AUTHORIZATION_TYPEHASH(), alice, bob, 1, 0, block.timestamp + 60, nonce)
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(0xB0B, _digest(structHash));
        vm.expectPartialRevert(MockTUSD8.InvalidSigner.selector);
        token.transferWithAuthorization(alice, bob, 1, 0, block.timestamp + 60, nonce, v, r, s);
    }
}
