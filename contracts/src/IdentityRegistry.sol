// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IIdentityRegistry} from "./interfaces/IIdentityRegistry.sol";

/// @title IdentityRegistry
/// @notice Minimal ERC-8004-style identity: a seller claims a domain and points to its agent card,
///         served at https://<domain>/.well-known/agent-card.json with { identityId, name, payee, stalls[] }.
/// @dev Replace with QDay's official ERC-8004 registry if one is published on Aevum (see docs/QDAY_NOTES.md).
contract IdentityRegistry is IIdentityRegistry {
    struct Identity {
        address controller;
        string domain;
        string agentCardURI;
    }

    /// @dev Identity ids start at 1 so 0 can mean "none".
    uint256 public identityCount;
    mapping(uint256 id => Identity) private _identities;
    mapping(bytes32 domainHash => uint256 id) public idByDomainHash;

    event IdentityRegistered(
        uint256 indexed identityId, address indexed controller, string domain, string agentCardURI
    );
    event AgentCardUpdated(uint256 indexed identityId, string agentCardURI);
    event ControllerChanged(uint256 indexed identityId, address indexed previous, address indexed next);

    error EmptyDomain();
    error DomainTaken(uint256 identityId);
    error NotController(uint256 identityId, address caller);
    error UnknownIdentity(uint256 identityId);
    error ZeroAddress();

    modifier onlyController(uint256 identityId) {
        if (_identities[identityId].controller != msg.sender) {
            if (_identities[identityId].controller == address(0)) revert UnknownIdentity(identityId);
            revert NotController(identityId, msg.sender);
        }
        _;
    }

    /// @notice Claim a domain. Domains are case-sensitive here; clients should lowercase before registering.
    function register(string calldata domain, string calldata agentCardURI)
        external
        returns (uint256 identityId)
    {
        if (bytes(domain).length == 0) revert EmptyDomain();
        bytes32 domainHash = keccak256(bytes(domain));
        uint256 existing = idByDomainHash[domainHash];
        if (existing != 0) revert DomainTaken(existing);

        identityId = ++identityCount;
        _identities[identityId] = Identity(msg.sender, domain, agentCardURI);
        idByDomainHash[domainHash] = identityId;
        emit IdentityRegistered(identityId, msg.sender, domain, agentCardURI);
    }

    function update(uint256 identityId, string calldata agentCardURI) external onlyController(identityId) {
        _identities[identityId].agentCardURI = agentCardURI;
        emit AgentCardUpdated(identityId, agentCardURI);
    }

    function setController(uint256 identityId, address next) external onlyController(identityId) {
        if (next == address(0)) revert ZeroAddress();
        emit ControllerChanged(identityId, msg.sender, next);
        _identities[identityId].controller = next;
    }

    function controllerOf(uint256 identityId) external view returns (address) {
        return _identities[identityId].controller;
    }

    function getIdentity(uint256 identityId) external view returns (Identity memory identity) {
        identity = _identities[identityId];
        if (identity.controller == address(0)) revert UnknownIdentity(identityId);
    }

    function idByDomain(string calldata domain) external view returns (uint256) {
        return idByDomainHash[keccak256(bytes(domain))];
    }
}
