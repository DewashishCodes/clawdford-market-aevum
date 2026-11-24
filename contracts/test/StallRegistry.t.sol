// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {RegistryFixture} from "./utils/RegistryFixture.sol";
import {StallRegistry} from "../src/StallRegistry.sol";
import {IStallRegistry} from "../src/interfaces/IStallRegistry.sol";
import {ITUSD8} from "../src/interfaces/ITUSD8.sol";

contract StallRegistryTest is RegistryFixture {
    address internal buyer = makeAddr("buyer");

    // ------------------------------------------------------------ constructor

    function test_constructorRejectsZeroAddresses() public {
        vm.expectRevert(StallRegistry.ZeroAddress.selector);
        new StallRegistry(ITUSD8(address(0)), identities, admin, arbiter, treasury, MIN_STAKE, COOLDOWN);
        vm.expectRevert(StallRegistry.ZeroAddress.selector);
        new StallRegistry(ITUSD8(address(token)), identities, admin, address(0), treasury, MIN_STAKE, COOLDOWN);
        vm.expectRevert(StallRegistry.ZeroAddress.selector);
        new StallRegistry(ITUSD8(address(token)), identities, admin, arbiter, address(0), MIN_STAKE, COOLDOWN);
    }

    // ------------------------------------------------------------ create

    function test_createStallPullsStakeAndStoresFields() public {
        uint256 id = _createStall(3, 0, 1000);
        assertEq(id, 1);
        assertEq(stalls.stallCount(), 1);
        assertEq(token.balanceOf(address(stalls)), MIN_STAKE);

        StallRegistry.Stall memory s = stalls.getStall(id);
        assertEq(s.owner, seller);
        assertEq(s.payee, payee);
        assertEq(s.quoteSigner, quoteSigner);
        assertEq(s.identityId, sellerIdentity);
        assertEq(s.category, 3);
        assertEq(s.mode, 0);
        assertEq(s.unitPrice, 1000);
        assertEq(s.stake, MIN_STAKE);
        assertTrue(s.active);

        IStallRegistry.PaymentInfo memory p = stalls.paymentInfo(id);
        assertEq(p.payee, payee);
        assertEq(p.owner, seller);
        assertTrue(p.active);
    }

    function test_createStallWithPermit() public {
        uint256 pk = 0xD00D;
        address newSeller = vm.addr(pk);
        token.mint(newSeller, 1e6);
        vm.prank(newSeller);
        uint256 idn = identities.register("new.example", "");

        StallRegistry.StallParams memory p = _params(1, 1, 500);
        p.identityId = idn;
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 structHash =
            keccak256(abi.encode(token.PERMIT_TYPEHASH(), newSeller, address(stalls), p.stake, 0, deadline));
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(pk, keccak256(abi.encodePacked("\x19\x01", token.DOMAIN_SEPARATOR(), structHash)));

        // A front-runner uses the permit first; creation must still succeed.
        token.permit(newSeller, address(stalls), p.stake, deadline, v, r, s);
        vm.prank(newSeller);
        uint256 id = stalls.createStallWithPermit(p, deadline, v, r, s);
        assertEq(stalls.getStall(id).owner, newSeller);
        assertEq(token.balanceOf(newSeller), 1e6 - p.stake);
    }

    function test_createStallValidation() public {
        StallRegistry.StallParams memory p = _params(0, 0, 1);

        address stranger = makeAddr("stranger");
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(StallRegistry.NotIdentityController.selector, sellerIdentity, stranger));
        stalls.createStall(p);

        p.payee = address(0);
        vm.prank(seller);
        vm.expectRevert(StallRegistry.ZeroAddress.selector);
        stalls.createStall(p);

        p = _params(32, 0, 1);
        vm.prank(seller);
        vm.expectRevert(abi.encodeWithSelector(StallRegistry.InvalidCategory.selector, 32));
        stalls.createStall(p);

        p = _params(0, 4, 1);
        vm.prank(seller);
        vm.expectRevert(abi.encodeWithSelector(StallRegistry.InvalidMode.selector, 4));
        stalls.createStall(p);

        p = _params(0, 0, 1);
        p.stake = MIN_STAKE - 1;
        vm.prank(seller);
        vm.expectRevert(abi.encodeWithSelector(StallRegistry.StakeTooLow.selector, MIN_STAKE - 1, MIN_STAKE));
        stalls.createStall(p);
    }

    // ------------------------------------------------------------ seller admin

    function test_ownerOnlyAdmin() public {
        uint256 id = _createStall(0, 0, 1);
        address stranger = makeAddr("stranger");
        vm.startPrank(stranger);
        vm.expectRevert(abi.encodeWithSelector(StallRegistry.NotStallOwner.selector, id, stranger));
        stalls.updatePrice(id, 2);
        vm.expectRevert(abi.encodeWithSelector(StallRegistry.NotStallOwner.selector, id, stranger));
        stalls.setActive(id, false);
        vm.expectRevert(abi.encodeWithSelector(StallRegistry.UnknownStall.selector, 99));
        stalls.updatePrice(99, 2);
        vm.stopPrank();
    }

    function test_updatePriceAndStall() public {
        uint256 id = _createStall(0, 0, 1);
        vm.startPrank(seller);
        stalls.updatePrice(id, 42);
        address newPayee = makeAddr("newPayee");
        stalls.updateStall(id, newPayee, quoteSigner, "https://new", "ipfs://new");
        vm.expectRevert(StallRegistry.ZeroAddress.selector);
        stalls.updateStall(id, address(0), quoteSigner, "", "");
        vm.stopPrank();

        StallRegistry.Stall memory s = stalls.getStall(id);
        assertEq(s.unitPrice, 42);
        assertEq(s.payee, newPayee);
        assertEq(s.endpoint, "https://new");
        assertEq(s.metadataURI, "ipfs://new");
    }

    function test_setActiveNeedsMinStake() public {
        uint256 id = _createStall(0, 0, 1);
        vm.prank(seller);
        stalls.setActive(id, false);
        assertFalse(stalls.getStall(id).active);

        vm.prank(admin);
        stalls.setMinStake(MIN_STAKE + 1);
        vm.prank(seller);
        vm.expectRevert(abi.encodeWithSelector(StallRegistry.StakeTooLow.selector, MIN_STAKE, MIN_STAKE + 1));
        stalls.setActive(id, true);

        vm.startPrank(seller);
        stalls.addStake(id, 1);
        stalls.setActive(id, true);
        vm.stopPrank();
        assertTrue(stalls.getStall(id).active);
    }

    function test_addStakeRejectsZero() public {
        uint256 id = _createStall(0, 0, 1);
        vm.prank(seller);
        vm.expectRevert(StallRegistry.ZeroAmount.selector);
        stalls.addStake(id, 0);
    }

    // ------------------------------------------------------------ unstake

    function test_unstakeAfterCooldownDeactivatesBelowMin() public {
        uint256 id = _createStall(0, 0, 1);
        uint256 balBefore = token.balanceOf(seller);

        vm.prank(seller);
        stalls.requestUnstake(id, 100_000);
        (, uint64 unlockAt) = stalls.pendingUnstake(id);
        assertEq(unlockAt, block.timestamp + COOLDOWN);

        vm.prank(seller);
        vm.expectRevert(abi.encodeWithSelector(StallRegistry.CooldownActive.selector, unlockAt));
        stalls.withdrawStake(id);

        vm.warp(unlockAt);
        vm.prank(seller);
        stalls.withdrawStake(id);

        assertEq(token.balanceOf(seller), balBefore + 100_000);
        StallRegistry.Stall memory s = stalls.getStall(id);
        assertEq(s.stake, MIN_STAKE - 100_000);
        assertFalse(s.active);

        vm.prank(seller);
        vm.expectRevert(StallRegistry.NothingToWithdraw.selector);
        stalls.withdrawStake(id);
    }

    function test_unstakeValidation() public {
        uint256 id = _createStall(0, 0, 1);
        vm.startPrank(seller);
        vm.expectRevert(StallRegistry.ZeroAmount.selector);
        stalls.requestUnstake(id, 0);
        vm.expectRevert(abi.encodeWithSelector(StallRegistry.InsufficientStake.selector, MIN_STAKE + 1, MIN_STAKE));
        stalls.requestUnstake(id, MIN_STAKE + 1);
        vm.stopPrank();
    }

    function test_withdrawClipsToStakeLeftAfterSlash() public {
        uint256 id = _createStall(0, 0, 1);
        vm.prank(seller);
        stalls.requestUnstake(id, MIN_STAKE);
        vm.prank(arbiter);
        stalls.slash(id, 200_000, address(0), "bad output");

        vm.warp(block.timestamp + COOLDOWN);
        uint256 balBefore = token.balanceOf(seller);
        vm.prank(seller);
        stalls.withdrawStake(id);
        assertEq(token.balanceOf(seller), balBefore + 50_000);
        assertEq(stalls.getStall(id).stake, 0);
    }

    function test_withdrawRevertsWhenStakeFullySlashed() public {
        uint256 id = _createStall(0, 0, 1);
        vm.prank(seller);
        stalls.requestUnstake(id, MIN_STAKE);
        vm.prank(arbiter);
        stalls.slash(id, MIN_STAKE, address(0), "fraud");
        vm.warp(block.timestamp + COOLDOWN);
        vm.prank(seller);
        vm.expectRevert(StallRegistry.NothingToWithdraw.selector);
        stalls.withdrawStake(id);
    }

    // ------------------------------------------------------------ slash

    function test_slashToBuyerOrTreasury() public {
        uint256 id = _createStall(0, 0, 1);
        vm.prank(arbiter);
        stalls.slash(id, 10_000, buyer, "undelivered");
        assertEq(token.balanceOf(buyer), 10_000);

        vm.prank(arbiter);
        stalls.slash(id, 20_000, address(0), "spam");
        assertEq(token.balanceOf(treasury), 20_000);

        StallRegistry.Stall memory s = stalls.getStall(id);
        assertEq(s.stake, MIN_STAKE - 30_000);
        assertFalse(s.active);
    }

    function test_slashValidation() public {
        uint256 id = _createStall(0, 0, 1);
        vm.expectRevert(abi.encodeWithSelector(StallRegistry.NotArbiter.selector, address(this)));
        stalls.slash(id, 1, address(0), "");

        vm.startPrank(arbiter);
        vm.expectRevert(abi.encodeWithSelector(StallRegistry.UnknownStall.selector, 9));
        stalls.slash(9, 1, address(0), "");
        vm.expectRevert(StallRegistry.ZeroAmount.selector);
        stalls.slash(id, 0, address(0), "");
        vm.expectRevert(abi.encodeWithSelector(StallRegistry.InsufficientStake.selector, MIN_STAKE + 1, MIN_STAKE));
        stalls.slash(id, MIN_STAKE + 1, address(0), "");
        vm.stopPrank();
    }

    // ------------------------------------------------------------ protocol admin

    function test_adminSetters() public {
        address a2 = makeAddr("arbiter2");
        address t2 = makeAddr("treasury2");
        vm.startPrank(admin);
        stalls.setArbiter(a2);
        stalls.setTreasury(t2);
        stalls.setMinStake(1);
        stalls.setUnstakeCooldown(60);
        vm.expectRevert(StallRegistry.ZeroAddress.selector);
        stalls.setArbiter(address(0));
        vm.expectRevert(StallRegistry.ZeroAddress.selector);
        stalls.setTreasury(address(0));
        vm.stopPrank();

        assertEq(stalls.arbiter(), a2);
        assertEq(stalls.treasury(), t2);
        assertEq(stalls.minStake(), 1);
        assertEq(stalls.unstakeCooldown(), 60);

        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        stalls.setArbiter(a2);
    }

    // ------------------------------------------------------------ views

    function test_listStallsPaginates() public {
        for (uint8 i = 0; i < 5; i++) {
            _createStall(i, 0, i + 1);
        }
        StallRegistry.Stall[] memory page = stalls.listStalls(1, 2);
        assertEq(page.length, 2);
        assertEq(page[0].unitPrice, 2);
        assertEq(page[1].unitPrice, 3);

        assertEq(stalls.listStalls(4, 10).length, 1);
        assertEq(stalls.listStalls(5, 10).length, 0);
    }

    function test_unknownStallViewsRevert() public {
        vm.expectRevert(abi.encodeWithSelector(StallRegistry.UnknownStall.selector, 1));
        stalls.getStall(1);
        vm.expectRevert(abi.encodeWithSelector(StallRegistry.UnknownStall.selector, 1));
        stalls.paymentInfo(1);
    }

    function testFuzz_stakeAccountingMatchesBalance(uint128 add, uint128 slashAmt) public {
        add = uint128(bound(add, 1, 5e6));
        uint256 id = _createStall(0, 0, 1);
        vm.prank(seller);
        stalls.addStake(id, add);
        uint128 total = MIN_STAKE + add;
        slashAmt = uint128(bound(slashAmt, 1, total));
        vm.prank(arbiter);
        stalls.slash(id, slashAmt, address(0), "");
        assertEq(token.balanceOf(address(stalls)), total - slashAmt);
        assertEq(stalls.getStall(id).stake, total - slashAmt);
    }
}
