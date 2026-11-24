// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {IdentityRegistry} from "../src/IdentityRegistry.sol";

contract IdentityRegistryTest is Test {
    IdentityRegistry internal reg;
    address internal seller = makeAddr("seller");
    address internal other = makeAddr("other");

    function setUp() public {
        reg = new IdentityRegistry();
    }

    function _register() internal returns (uint256 id) {
        vm.prank(seller);
        id = reg.register("lex.example", "https://lex.example/.well-known/agent-card.json");
    }

    function test_registerAssignsSequentialIdsAndController() public {
        vm.expectEmit(true, true, false, true);
        emit IdentityRegistry.IdentityRegistered(1, seller, "lex.example", "https://lex.example/.well-known/agent-card.json");
        uint256 id = _register();
        assertEq(id, 1);
        assertEq(reg.identityCount(), 1);
        assertEq(reg.controllerOf(id), seller);
        assertEq(reg.idByDomain("lex.example"), 1);

        vm.prank(other);
        assertEq(reg.register("data.example", ""), 2);
    }

    function test_getIdentity() public {
        uint256 id = _register();
        IdentityRegistry.Identity memory i = reg.getIdentity(id);
        assertEq(i.controller, seller);
        assertEq(i.domain, "lex.example");
    }

    function test_revertsOnEmptyOrTakenDomain() public {
        vm.expectRevert(IdentityRegistry.EmptyDomain.selector);
        reg.register("", "x");

        _register();
        vm.prank(other);
        vm.expectRevert(abi.encodeWithSelector(IdentityRegistry.DomainTaken.selector, 1));
        reg.register("lex.example", "x");
    }

    function test_updateOnlyByController() public {
        uint256 id = _register();
        vm.prank(other);
        vm.expectRevert(abi.encodeWithSelector(IdentityRegistry.NotController.selector, id, other));
        reg.update(id, "evil");

        vm.prank(seller);
        reg.update(id, "ipfs://card");
        assertEq(reg.getIdentity(id).agentCardURI, "ipfs://card");
    }

    function test_setControllerTransfersControl() public {
        uint256 id = _register();
        vm.prank(seller);
        vm.expectRevert(IdentityRegistry.ZeroAddress.selector);
        reg.setController(id, address(0));

        vm.prank(seller);
        reg.setController(id, other);
        assertEq(reg.controllerOf(id), other);

        vm.prank(seller);
        vm.expectRevert(abi.encodeWithSelector(IdentityRegistry.NotController.selector, id, seller));
        reg.update(id, "x");
    }

    function test_unknownIdentityReverts() public {
        vm.expectRevert(abi.encodeWithSelector(IdentityRegistry.UnknownIdentity.selector, 7));
        reg.getIdentity(7);
        vm.expectRevert(abi.encodeWithSelector(IdentityRegistry.UnknownIdentity.selector, 7));
        reg.update(7, "x");
    }
}
