// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {VaultFixture} from "./utils/VaultFixture.sol";
import {VaultBase} from "../src/vault/VaultBase.sol";
import {VaultChannels} from "../src/vault/VaultChannels.sol";

contract AgentVaultChannelsTest is VaultFixture {
    uint256 internal streamStall;

    function setUp() public override {
        super.setUp();
        streamStall = _createStall(0, 1, 2000); // inference, stream, 0.002 per 1k tokens
    }

    function _hash(bytes32 structHash) internal view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", vault.DOMAIN_SEPARATOR(), structHash));
    }

    function _openSig(uint256 sid, uint256 stallId, uint256 deposit, uint256 validBefore, uint256 nonce)
        internal
        view
        returns (bytes memory)
    {
        return _sign(
            agentPk,
            _hash(
                keccak256(
                    abi.encode(vault.OPEN_CHANNEL_TYPEHASH(), sid, stallId, deposit, validBefore, nonce)
                )
            )
        );
    }

    function _open(uint256 deposit) internal returns (uint256 channelId) {
        uint256 nonce = nextNonce++;
        uint256 vb = block.timestamp + 5 minutes;
        bytes memory sig = _openSig(sessionId, streamStall, deposit, vb, nonce);
        vm.prank(relayer);
        channelId = vault.openChannel(sessionId, streamStall, deposit, vb, nonce, sig);
    }

    function _voucher(uint256 channelId, uint256 cumulative) internal view returns (bytes memory) {
        return _sign(agentPk, vault.hashVoucher(channelId, cumulative));
    }

    function _topUpSig(uint256 channelId, uint256 amount, uint256 vb, uint256 nonce)
        internal
        view
        returns (bytes memory)
    {
        return _sign(
            agentPk, _hash(keccak256(abi.encode(vault.TOP_UP_TYPEHASH(), channelId, amount, vb, nonce)))
        );
    }

    // ------------------------------------------------------------ open

    function test_openChargesDepositAgainstCaps() public {
        uint256 cid = _open(50_000);
        VaultChannels.Channel memory c = vault.getChannel(cid);
        assertEq(c.sessionId, sessionId);
        assertEq(c.payee, payee);
        assertEq(c.deposit, 50_000);
        assertEq(vault.balanceOf(owner), 3e6 - 50_000);
        assertEq(vault.getSession(sessionId).spentTotal, 50_000);
        assertEq(vault.openChannelsOf(sessionId).length, 1);
    }

    function test_openRejectsNonStreamStallAndBadSigs() public {
        uint256 vb = block.timestamp + 60;
        bytes memory sig = _openSig(sessionId, exactStall, 1000, vb, 1);
        vm.expectRevert(abi.encodeWithSelector(VaultBase.WrongMode.selector, exactStall, 0));
        vault.openChannel(sessionId, exactStall, 1000, vb, 1, sig);

        sig = _openSig(sessionId, streamStall, 1000, vb, 1);
        vm.expectRevert(); // signed for 1000, submitted for 2000
        vault.openChannel(sessionId, streamStall, 2000, vb, 1, sig);

        vm.warp(vb);
        vm.expectRevert(VaultBase.IntentExpired.selector);
        vault.openChannel(sessionId, streamStall, 1000, vb, 1, sig);
    }

    function test_openRespectsPerPaymentCap() public {
        uint256 vb = block.timestamp + 60;
        bytes memory sig = _openSig(sessionId, streamStall, 200_001, vb, 1);
        vm.expectRevert(abi.encodeWithSelector(VaultBase.PerPaymentCapExceeded.selector, 200_001, 200_000));
        vault.openChannel(sessionId, streamStall, 200_001, vb, 1, sig);
    }

    function test_openNonceCannotBeReused() public {
        uint256 vb = block.timestamp + 60;
        bytes memory sig = _openSig(sessionId, streamStall, 1000, vb, 7);
        vault.openChannel(sessionId, streamStall, 1000, vb, 7, sig);
        vm.expectRevert(abi.encodeWithSelector(VaultBase.NonceAlreadyUsed.selector, sessionId, 7));
        vault.openChannel(sessionId, streamStall, 1000, vb, 7, sig);
    }

    function test_maxOpenChannels() public {
        vm.prank(owner);
        vault.updateCaps(sessionId, 200_000, 3e6, 3e6, uint64(block.timestamp + 1 hours));
        for (uint256 k = 0; k < vault.MAX_OPEN_CHANNELS(); k++) {
            _open(1000);
        }
        uint256 vb = block.timestamp + 60;
        bytes memory sig = _openSig(sessionId, streamStall, 1000, vb, 999);
        vm.expectRevert(abi.encodeWithSelector(VaultChannels.TooManyOpenChannels.selector, sessionId));
        vault.openChannel(sessionId, streamStall, 1000, vb, 999, sig);
    }

    // ------------------------------------------------------------ claim

    function test_claimInBatchesPaysDeltaMinusFee() public {
        uint256 cid = _open(50_000);
        vm.prank(payee);
        vault.claim(cid, 10_000, _voucher(cid, 10_000));
        vault.claim(cid, 25_000, _voucher(cid, 25_000)); // anyone may submit for the seller

        assertEq(vault.getChannel(cid).claimed, 25_000);
        assertEq(token.balanceOf(payee), 25_000 - 750);
        assertEq(token.balanceOf(treasury), 750);
        assertEq(vault.receiptCount(), 2);
        assertEq(vault.getReceipt(2).amount, 15_000);
        assertEq(vault.getReceipt(2).mode, 1);
    }

    function test_claimValidation() public {
        uint256 cid = _open(50_000);
        bytes memory preSig1 = _voucher(cid, 50_001);
        vm.expectRevert(abi.encodeWithSelector(VaultChannels.VoucherTooLarge.selector, 50_001, 50_000));
        vault.claim(cid, 50_001, preSig1);

        vault.claim(cid, 10_000, _voucher(cid, 10_000));
        bytes memory preSig2 = _voucher(cid, 10_000);
        vm.expectRevert(abi.encodeWithSelector(VaultChannels.VoucherNotIncreasing.selector, 10_000, 10_000));
        vault.claim(cid, 10_000, preSig2);

        // Voucher signed for another channel.
        uint256 other = _open(50_000);
        bytes memory wrong = _voucher(other, 20_000);
        vm.expectRevert();
        vault.claim(cid, 20_000, wrong);

        // Voucher signed by the seller instead of the agent.
        bytes memory preSig3 = _sign(quotePk, vault.hashVoucher(cid, 20_000));
        vm.expectRevert(abi.encodeWithSelector(VaultBase.BadAgentSigner.selector, quoteSigner));
        vault.claim(cid, 20_000, preSig3);

        vm.expectRevert(abi.encodeWithSelector(VaultChannels.UnknownChannel.selector, 99));
        vault.claim(99, 1, "");
    }

    // ------------------------------------------------------------ top up

    function test_topUpIsChargedAndBlockedWhileClosing() public {
        uint256 cid = _open(50_000);
        uint256 vb = block.timestamp + 60;
        vault.topUp(cid, 20_000, vb, 100, _topUpSig(cid, 20_000, vb, 100));
        assertEq(vault.getChannel(cid).deposit, 70_000);
        assertEq(vault.getSession(sessionId).spentTotal, 70_000);

        vm.prank(owner);
        vault.requestClose(cid);
        bytes memory preSig4 = _topUpSig(cid, 1000, vb, 101);
        vm.expectRevert(abi.encodeWithSelector(VaultChannels.ChannelClosing.selector, cid));
        vault.topUp(cid, 1000, vb, 101, preSig4);
    }

    function test_topUpOnLaterDayTracksNewDay() public {
        vm.warp(5 days + 23 hours);
        vm.prank(owner);
        vault.updateCaps(sessionId, 200_000, 1e6, 2e6, uint64(block.timestamp + 2 days));
        uint256 cid = _open(50_000);
        vm.warp(6 days + 1 hours);
        uint256 vb = block.timestamp + 60;
        vault.topUp(cid, 20_000, vb, 100, _topUpSig(cid, 20_000, vb, 100));
        VaultChannels.Channel memory c = vault.getChannel(cid);
        assertEq(c.chargedOnDay, 20_000);
        assertEq(c.chargeDay, 6);
    }

    // ------------------------------------------------------------ close

    function test_closeAfterWindowRefundsAndCreditsSession() public {
        uint256 cid = _open(50_000);
        vault.claim(cid, 12_000, _voucher(cid, 12_000));

        vm.prank(agent);
        vault.requestClose(cid);
        uint64 closeAt = vault.getChannel(cid).closeAt;
        assertEq(closeAt, block.timestamp + 10 minutes);

        vm.expectRevert(abi.encodeWithSelector(VaultChannels.ChallengeWindowActive.selector, closeAt));
        vault.finalizeClose(cid);

        // Seller may still claim inside the window.
        vault.claim(cid, 20_000, _voucher(cid, 20_000));

        vm.warp(closeAt);
        vault.finalizeClose(cid);

        assertEq(vault.balanceOf(owner), 3e6 - 20_000);
        assertEq(vault.getSession(sessionId).spentTotal, 20_000);
        assertEq(vault.getSession(sessionId).spentToday, 20_000);
        assertEq(vault.openChannelsOf(sessionId).length, 0);

        bytes memory preSig5 = _voucher(cid, 30_000);
        vm.expectRevert(abi.encodeWithSelector(VaultChannels.ChannelFinalized_.selector, cid));
        vault.claim(cid, 30_000, preSig5);
    }

    function test_refundOnLaterDayDoesNotReopenTodaysCap() public {
        vm.warp(10 days + 23 hours);
        vm.prank(owner);
        vault.updateCaps(sessionId, 200_000, 1e6, 2e6, uint64(block.timestamp + 2 days));
        uint256 cid = _open(100_000);
        vm.prank(owner);
        vault.requestClose(cid);

        vm.warp(11 days + 1 hours);
        _pay(exactStall, 50_000, sessionId);
        vault.finalizeClose(cid);
        assertEq(vault.getSession(sessionId).spentToday, 50_000); // yesterday's deposit not credited to today
        assertEq(vault.getSession(sessionId).spentTotal, 50_000);
    }

    function test_closeOnlyByParties() public {
        uint256 cid = _open(10_000);
        vm.prank(payee);
        vm.expectRevert(abi.encodeWithSelector(VaultChannels.NotChannelParty.selector, cid, payee));
        vault.requestClose(cid);
    }

    function test_closeWithAgentSignature() public {
        uint256 cid = _open(10_000);
        bytes memory sig = _sign(agentPk, _hash(keccak256(abi.encode(vault.CLOSE_CHANNEL_TYPEHASH(), cid))));
        vm.prank(relayer);
        vault.requestCloseWithSig(cid, sig);
        uint64 closeAt = vault.getChannel(cid).closeAt;
        assertGt(closeAt, 0);

        // Second request never extends the window.
        vm.warp(block.timestamp + 5 minutes);
        vm.prank(owner);
        vault.requestClose(cid);
        assertEq(vault.getChannel(cid).closeAt, closeAt);
    }

    function test_revokeStartsCloseOnAllOpenChannels() public {
        uint256 a = _open(10_000);
        uint256 b = _open(20_000);
        vm.prank(owner);
        vault.revokeSession(sessionId);
        assertGt(vault.getChannel(a).closeAt, 0);
        assertGt(vault.getChannel(b).closeAt, 0);

        // Already signed vouchers stay claimable during the window.
        vault.claim(a, 5_000, _voucher(a, 5_000));

        // New channels and top ups are blocked.
        uint256 vb = block.timestamp + 60;
        bytes memory sig = _openSig(sessionId, streamStall, 1000, vb, 555);
        vm.expectRevert(abi.encodeWithSelector(VaultBase.RevokedSession.selector, sessionId));
        vault.openChannel(sessionId, streamStall, 1000, vb, 555, sig);

        vm.warp(block.timestamp + 10 minutes);
        vault.finalizeClose(b);
        vault.finalizeClose(a);
        assertEq(vault.balanceOf(owner), 3e6 - 5_000);
        assertEq(vault.openChannelsOf(sessionId).length, 0);
    }

    function test_setChallengeWindow() public {
        vm.prank(admin);
        vault.setChallengeWindow(30);
        assertEq(vault.challengeWindow(), 30);
    }
}
