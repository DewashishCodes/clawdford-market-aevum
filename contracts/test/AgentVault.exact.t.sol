// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {VaultFixture} from "./utils/VaultFixture.sol";
import {VaultBase} from "../src/vault/VaultBase.sol";

/// @notice Signature and replay protection on payExact, plus license mode.
contract AgentVaultExactTest is VaultFixture {
    function _submit(
        VaultBase.Quote memory q,
        bytes memory qs,
        VaultBase.PaymentIntent memory i,
        bytes memory is_,
        bytes memory err
    ) internal {
        vm.prank(relayer);
        if (err.length != 0) vm.expectRevert(err);
        vault.payExact(q, qs, i, is_);
    }

    function test_replayedIntentNonceRejected() public {
        (VaultBase.Quote memory q, bytes memory qs, VaultBase.PaymentIntent memory i, bytes memory is_) =
            _signedPayment(exactStall, 1000, sessionId);
        _submit(q, qs, i, is_, "");
        // Same intent again: the quote is spent first, so the quote check trips.
        _submit(
            q, qs, i, is_, abi.encodeWithSelector(VaultBase.QuoteAlreadyUsed.selector, vault.hashQuote(q))
        );

        // Fresh quote but the old intent nonce.
        VaultBase.Quote memory q2 = _quote(exactStall, 1000);
        VaultBase.PaymentIntent memory i2 =
            VaultBase.PaymentIntent(vault.hashQuote(q2), sessionId, i.validBefore, i.nonce);
        _submit(
            q2,
            _sign(quotePk, vault.hashQuote(q2)),
            i2,
            _sign(agentPk, vault.hashIntent(i2)),
            abi.encodeWithSelector(VaultBase.NonceAlreadyUsed.selector, sessionId, i.nonce)
        );
    }

    function test_expiredQuoteAndIntent() public {
        (VaultBase.Quote memory q, bytes memory qs, VaultBase.PaymentIntent memory i, bytes memory is_) =
            _signedPayment(exactStall, 1000, sessionId);
        vm.warp(q.validBefore);
        _submit(q, qs, i, is_, abi.encodeWithSelector(VaultBase.QuoteExpired.selector));

        vm.warp(1);
        q = _quote(exactStall, 1000);
        i = _intentFor(q, sessionId);
        i.validBefore = block.timestamp;
        _submit(
            q,
            _sign(quotePk, vault.hashQuote(q)),
            i,
            _sign(agentPk, vault.hashIntent(i)),
            abi.encodeWithSelector(VaultBase.IntentExpired.selector)
        );
    }

    function test_quoteSignedByWrongKey() public {
        VaultBase.Quote memory q = _quote(exactStall, 1000);
        VaultBase.PaymentIntent memory i = _intentFor(q, sessionId);
        address impostor = vm.addr(0xBAD);
        _submit(
            q,
            _sign(0xBAD, vault.hashQuote(q)),
            i,
            _sign(agentPk, vault.hashIntent(i)),
            abi.encodeWithSelector(VaultBase.BadQuoteSigner.selector, impostor)
        );
    }

    function test_intentSignedByWrongKey() public {
        VaultBase.Quote memory q = _quote(exactStall, 1000);
        VaultBase.PaymentIntent memory i = _intentFor(q, sessionId);
        _submit(
            q,
            _sign(quotePk, vault.hashQuote(q)),
            i,
            _sign(ownerPk, vault.hashIntent(i)),
            abi.encodeWithSelector(VaultBase.BadAgentSigner.selector, owner)
        );
    }

    function test_signaturesFromAnotherChainRejected() public {
        (VaultBase.Quote memory q, bytes memory qs, VaultBase.PaymentIntent memory i, bytes memory is_) =
            _signedPayment(exactStall, 1000, sessionId);
        vm.chainId(44005 + 1);
        address recovered = ECDSA.recover(vault.hashQuote(q), qs);
        _submit(q, qs, i, is_, abi.encodeWithSelector(VaultBase.BadQuoteSigner.selector, recovered));
    }

    function test_intentMustBindTheQuote() public {
        VaultBase.Quote memory q = _quote(exactStall, 1000);
        VaultBase.Quote memory cheaper = _quote(exactStall, 1);
        VaultBase.PaymentIntent memory i = _intentFor(cheaper, sessionId);
        _submit(
            q,
            _sign(quotePk, vault.hashQuote(q)),
            i,
            _sign(agentPk, vault.hashIntent(i)),
            abi.encodeWithSelector(VaultBase.QuoteMismatch.selector)
        );
    }

    function test_buyerSessionBinding() public {
        uint256 other = _createSession(1e6, 1e6, 1e6, uint64(block.timestamp + 1 hours), type(uint32).max);
        VaultBase.Quote memory q = _quote(exactStall, 1000);
        q.buyerSession = sessionId;
        VaultBase.PaymentIntent memory i = _intentFor(q, other);
        _submit(
            q,
            _sign(quotePk, vault.hashQuote(q)),
            i,
            _sign(agentPk, vault.hashIntent(i)),
            abi.encodeWithSelector(VaultBase.WrongBuyerSession.selector, sessionId, other)
        );
        i = _intentFor(q, sessionId);
        _submit(q, _sign(quotePk, vault.hashQuote(q)), i, _sign(agentPk, vault.hashIntent(i)), "");
    }

    function test_unknownSessionInIntent() public {
        VaultBase.Quote memory q = _quote(exactStall, 1000);
        VaultBase.PaymentIntent memory i = _intentFor(q, 77);
        _submit(
            q,
            _sign(quotePk, vault.hashQuote(q)),
            i,
            _sign(agentPk, vault.hashIntent(i)),
            abi.encodeWithSelector(VaultBase.UnknownSession.selector, 77)
        );
    }

    function test_streamStallRejectedByPayExact() public {
        uint256 streamStall = _createStall(CAT_KNOWLEDGE, 1, 1000);
        _payReverts(
            streamStall, 1000, sessionId, abi.encodeWithSelector(VaultBase.WrongMode.selector, streamStall, 1)
        );
    }

    function test_licenseModeRecordsLicense() public {
        uint256 skill = _createStall(4, 3, 200_000);
        assertFalse(vault.licenses(owner, skill));
        vm.expectEmit(true, true, false, false);
        emit VaultBase.Licensed(owner, skill, 1);
        uint256 rid = _pay(skill, 200_000, sessionId);
        assertTrue(vault.licenses(owner, skill));
        assertEq(vault.getReceipt(rid).mode, 3);
    }

    function test_paidEventCarriesResourceHash() public {
        vm.expectEmit(true, true, true, true);
        emit VaultBase.Paid(1, sessionId, exactStall, 1000, keccak256("POST /s/search"));
        _pay(exactStall, 1000, sessionId);
    }

    function test_zeroFeeSendsEverythingToPayee() public {
        vm.prank(admin);
        vault.setFeeBps(0);
        _pay(exactStall, 1000, sessionId);
        assertEq(token.balanceOf(payee), 1000);
        assertEq(token.balanceOf(treasury), 0);
    }
}
