// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {VaultFixture} from "./utils/VaultFixture.sol";
import {ReputationRegistry} from "../src/ReputationRegistry.sol";

contract ReputationRegistryTest is VaultFixture {
    ReputationRegistry internal rep;

    function setUp() public override {
        super.setUp();
        rep = new ReputationRegistry(vault);
    }

    function test_ownerAndAgentCanRateOncePerReceipt() public {
        uint256 r1 = _pay(exactStall, 1000, sessionId);
        uint256 r2 = _pay(exactStall, 1000, sessionId);

        vm.prank(owner);
        rep.rate(r1, 5, "ipfs://great");
        vm.prank(agent);
        rep.rate(r2, 4, "");

        assertEq(rep.count(exactStall), 2);
        assertEq(rep.average(exactStall), 450);
        assertTrue(rep.rated(r1));

        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(ReputationRegistry.AlreadyRated.selector, r1));
        rep.rate(r1, 1, "");
    }

    function test_strangersCannotRate() public {
        uint256 r1 = _pay(exactStall, 1000, sessionId);
        vm.prank(seller);
        vm.expectRevert(abi.encodeWithSelector(ReputationRegistry.NotReceiptOwner.selector, r1, seller));
        rep.rate(r1, 5, "");
    }

    function test_validation() public {
        vm.expectRevert(abi.encodeWithSelector(ReputationRegistry.InvalidScore.selector, 0));
        rep.rate(1, 0, "");
        vm.expectRevert(abi.encodeWithSelector(ReputationRegistry.InvalidScore.selector, 6));
        rep.rate(1, 6, "");
        vm.expectRevert(abi.encodeWithSelector(ReputationRegistry.UnknownReceipt.selector, 1));
        rep.rate(1, 3, "");
    }

    function test_unratedAverageIsZero() public view {
        assertEq(rep.average(exactStall), 0);
    }
}
