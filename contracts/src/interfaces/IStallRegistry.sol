// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

interface IStallRegistry {
    /// @notice The fields AgentVault needs to charge a payment, without the strings.
    struct PaymentInfo {
        address owner;
        address payee;
        address quoteSigner;
        uint8 category;
        uint8 mode;
        uint128 unitPrice;
        bool active;
    }

    function paymentInfo(uint256 stallId) external view returns (PaymentInfo memory);
}
