// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {MockTUSD8} from "../../src/mocks/MockTUSD8.sol";
import {IdentityRegistry} from "../../src/IdentityRegistry.sol";
import {StallRegistry} from "../../src/StallRegistry.sol";
import {ITUSD8} from "../../src/interfaces/ITUSD8.sol";

/// @notice Shared setup: token, identity and stall registries, one funded seller with an identity.
abstract contract RegistryFixture is Test {
    uint128 internal constant MIN_STAKE = 250_000; // 0.25 tUSD8
    uint64 internal constant COOLDOWN = 1 hours;

    MockTUSD8 internal token;
    IdentityRegistry internal identities;
    StallRegistry internal stalls;

    address internal admin = makeAddr("admin");
    address internal arbiter = makeAddr("arbiter");
    address internal treasury = makeAddr("treasury");

    uint256 internal sellerPk = 0x5E11E4;
    address internal seller;
    address internal payee = makeAddr("payee");
    uint256 internal quotePk = 0x0907E;
    address internal quoteSigner;
    uint256 internal sellerIdentity;

    function setUp() public virtual {
        seller = vm.addr(sellerPk);
        quoteSigner = vm.addr(quotePk);
        token = new MockTUSD8();
        identities = new IdentityRegistry();
        stalls = new StallRegistry(
            ITUSD8(address(token)), identities, admin, arbiter, treasury, MIN_STAKE, COOLDOWN
        );

        token.mint(seller, 10e6);
        vm.prank(seller);
        sellerIdentity = identities.register("lex.example", "https://lex.example/.well-known/agent-card.json");
        vm.prank(seller);
        token.approve(address(stalls), type(uint256).max);
    }

    function _params(uint8 category, uint8 mode, uint128 unitPrice)
        internal
        view
        returns (StallRegistry.StallParams memory)
    {
        return StallRegistry.StallParams({
            identityId: sellerIdentity,
            payee: payee,
            quoteSigner: quoteSigner,
            category: category,
            mode: mode,
            unitPrice: unitPrice,
            unit: "call",
            endpoint: "https://lex.example/s/test",
            metadataURI: "ipfs://meta",
            stake: MIN_STAKE
        });
    }

    function _createStall(uint8 category, uint8 mode, uint128 unitPrice) internal returns (uint256 stallId) {
        vm.prank(seller);
        stallId = stalls.createStall(_params(category, mode, unitPrice));
    }
}
