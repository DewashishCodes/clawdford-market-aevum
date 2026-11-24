// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

interface IIdentityRegistry {
    function controllerOf(uint256 identityId) external view returns (address);
}
