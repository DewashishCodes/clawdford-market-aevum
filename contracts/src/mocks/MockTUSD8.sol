// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {Nonces} from "@openzeppelin/contracts/utils/Nonces.sol";

/// @title MockTUSD8
/// @notice Local stand-in for Aevum's tUSD8: 6 decimals, EIP-712 domain ("tUSD8", "2"),
///         EIP-2612 permit and EIP-3009 transfer/receive with authorization. Test only: anyone can mint.
contract MockTUSD8 is ERC20, EIP712, Nonces {
    bytes32 public constant PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");
    bytes32 public constant TRANSFER_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );
    bytes32 public constant RECEIVE_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );
    bytes32 public constant CANCEL_AUTHORIZATION_TYPEHASH =
        keccak256("CancelAuthorization(address authorizer,bytes32 nonce)");

    mapping(address authorizer => mapping(bytes32 nonce => bool used)) public authorizationState;

    event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce);
    event AuthorizationCanceled(address indexed authorizer, bytes32 indexed nonce);

    error PermitExpired(uint256 deadline);
    error InvalidSigner(address signer, address expected);
    error AuthorizationNotYetValid();
    error AuthorizationExpired();
    error AuthorizationAlreadyUsed(bytes32 nonce);
    error CallerMustBePayee(address caller, address payee);

    constructor() ERC20("tUSD8", "tUSD8") EIP712("tUSD8", "2") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    // solhint-disable-next-line func-name-mixedcase
    function DOMAIN_SEPARATOR() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    function nonces(address owner) public view override returns (uint256) {
        return super.nonces(owner);
    }

    // ---------------------------------------------------------------- EIP-2612

    function permit(
        address owner,
        address spender,
        uint256 value,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        if (block.timestamp > deadline) revert PermitExpired(deadline);
        bytes32 structHash =
            keccak256(abi.encode(PERMIT_TYPEHASH, owner, spender, value, _useNonce(owner), deadline));
        _requireSigner(structHash, owner, v, r, s);
        _approve(owner, spender, value);
    }

    // ---------------------------------------------------------------- EIP-3009

    function transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        _useAuthorization(
            TRANSFER_WITH_AUTHORIZATION_TYPEHASH, from, to, value, validAfter, validBefore, nonce, v, r, s
        );
        _transfer(from, to, value);
    }

    /// @dev Only the payee may submit, which stops front-runners from consuming the authorization.
    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        if (msg.sender != to) revert CallerMustBePayee(msg.sender, to);
        _useAuthorization(
            RECEIVE_WITH_AUTHORIZATION_TYPEHASH, from, to, value, validAfter, validBefore, nonce, v, r, s
        );
        _transfer(from, to, value);
    }

    function cancelAuthorization(address authorizer, bytes32 nonce, uint8 v, bytes32 r, bytes32 s) external {
        if (authorizationState[authorizer][nonce]) revert AuthorizationAlreadyUsed(nonce);
        _requireSigner(
            keccak256(abi.encode(CANCEL_AUTHORIZATION_TYPEHASH, authorizer, nonce)), authorizer, v, r, s
        );
        authorizationState[authorizer][nonce] = true;
        emit AuthorizationCanceled(authorizer, nonce);
    }

    function _useAuthorization(
        bytes32 typehash,
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) private {
        if (block.timestamp <= validAfter) revert AuthorizationNotYetValid();
        if (block.timestamp >= validBefore) revert AuthorizationExpired();
        if (authorizationState[from][nonce]) revert AuthorizationAlreadyUsed(nonce);
        _requireSigner(
            keccak256(abi.encode(typehash, from, to, value, validAfter, validBefore, nonce)), from, v, r, s
        );
        authorizationState[from][nonce] = true;
        emit AuthorizationUsed(from, nonce);
    }

    function _requireSigner(bytes32 structHash, address expected, uint8 v, bytes32 r, bytes32 s)
        private
        view
    {
        address signer = ECDSA.recover(_hashTypedDataV4(structHash), v, r, s);
        if (signer != expected) revert InvalidSigner(signer, expected);
    }
}
