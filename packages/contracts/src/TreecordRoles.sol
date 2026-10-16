// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {AlreadySet, Unauthorized, ZeroAddress} from "./libraries/TreecordTypes.sol";

/// @title TreecordRoles
/// @notice Central role registry and address book that every other Treecord contract queries.
/// @dev Why a central registry instead of an AccessControl base inherited by each contract:
///      every campaign is a minimal proxy clone. With a shared base, each clone would hold its own role
///      table, so granting or rotating the operator key would need one transaction per campaign. A single
///      registry gives one place to grant and revoke OPERATOR, ATTESTER and ISSUER for the factory, all
///      campaigns, the tree registry, the gateway and the carbon ledger. The cost is one external view call
///      per role check, which is acceptable on Base.
///
///      Component addresses (factory, tree registry, gateway, carbon ledger) can be set once each, which
///      limits what a compromised admin key can redirect. The treasury can be updated.
contract TreecordRoles is AccessControl {
    /// @notice Backend operator wallet: assigns anchor slots, claims slots for planters, resolves flags, sets carbon estimates.
    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");
    /// @notice Backend attestation signer. Its EIP-712 signatures are the only way to register trees and release incentives.
    bytes32 public constant ATTESTER_ROLE = keccak256("ATTESTER_ROLE");
    /// @notice Mirrors registry credit issuance into CarbonLedger.
    bytes32 public constant ISSUER_ROLE = keccak256("ISSUER_ROLE");

    /// @notice Receives the seedling, verification and fee buckets, and holds carbon inventory.
    address public treasury;
    /// @notice The CampaignFactory. Set once.
    address public factory;
    /// @notice The TreeRegistry. Set once.
    address public treeRegistry;
    /// @notice The VerificationGateway. Set once.
    address public gateway;
    /// @notice The CarbonLedger. Set once.
    address public carbonLedger;

    /// @notice Emitted when the treasury address changes.
    event TreasuryUpdated(address indexed previousTreasury, address indexed newTreasury);
    /// @notice Emitted when the factory is wired.
    event FactorySet(address indexed factory);
    /// @notice Emitted when the tree registry is wired.
    event TreeRegistrySet(address indexed treeRegistry);
    /// @notice Emitted when the verification gateway is wired.
    event GatewaySet(address indexed gateway);
    /// @notice Emitted when the carbon ledger is wired.
    event CarbonLedgerSet(address indexed carbonLedger);

    /// @param admin Receives DEFAULT_ADMIN_ROLE (deployer multisig or EOA).
    /// @param treasury_ Initial treasury address.
    constructor(address admin, address treasury_) {
        if (admin == address(0) || treasury_ == address(0)) revert ZeroAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        treasury = treasury_;
        emit TreasuryUpdated(address(0), treasury_);
    }

    /// @notice Updates the treasury address.
    /// @param newTreasury The new treasury. Must not be zero.
    function setTreasury(address newTreasury) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newTreasury == address(0)) revert ZeroAddress();
        emit TreasuryUpdated(treasury, newTreasury);
        treasury = newTreasury;
    }

    /// @notice Wires the CampaignFactory. Can be called once.
    /// @param factory_ The factory address.
    function setFactory(address factory_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (factory_ == address(0)) revert ZeroAddress();
        if (factory != address(0)) revert AlreadySet();
        factory = factory_;
        emit FactorySet(factory_);
    }

    /// @notice Wires the TreeRegistry. Can be called once.
    /// @param treeRegistry_ The tree registry address.
    function setTreeRegistry(address treeRegistry_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (treeRegistry_ == address(0)) revert ZeroAddress();
        if (treeRegistry != address(0)) revert AlreadySet();
        treeRegistry = treeRegistry_;
        emit TreeRegistrySet(treeRegistry_);
    }

    /// @notice Wires the VerificationGateway. Can be called once.
    /// @param gateway_ The gateway address.
    function setGateway(address gateway_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (gateway_ == address(0)) revert ZeroAddress();
        if (gateway != address(0)) revert AlreadySet();
        gateway = gateway_;
        emit GatewaySet(gateway_);
    }

    /// @notice Wires the CarbonLedger. Can be called once.
    /// @param carbonLedger_ The carbon ledger address.
    function setCarbonLedger(address carbonLedger_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (carbonLedger_ == address(0)) revert ZeroAddress();
        if (carbonLedger != address(0)) revert AlreadySet();
        carbonLedger = carbonLedger_;
        emit CarbonLedgerSet(carbonLedger_);
    }
}

/// @title RoleGated
/// @notice Base for contracts that check roles and component addresses against TreecordRoles.
/// @dev `roles` is immutable, so it lives in bytecode and is shared by every clone of an implementation.
abstract contract RoleGated {
    // Same values as the TreecordRoles constants, kept local to avoid an extra external call per check.
    bytes32 internal constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");
    bytes32 internal constant ATTESTER_ROLE = keccak256("ATTESTER_ROLE");
    bytes32 internal constant ISSUER_ROLE = keccak256("ISSUER_ROLE");

    /// @notice The central role registry.
    TreecordRoles public immutable roles;

    constructor(TreecordRoles roles_) {
        if (address(roles_) == address(0)) revert ZeroAddress();
        roles = roles_;
    }

    /// @dev Reverts unless the caller holds `role` in TreecordRoles.
    modifier onlyRoleHolder(bytes32 role) {
        if (!roles.hasRole(role, msg.sender)) revert Unauthorized(msg.sender);
        _;
    }

    /// @dev Reverts unless the caller is the wired VerificationGateway.
    modifier onlyGateway() {
        if (msg.sender != roles.gateway()) revert Unauthorized(msg.sender);
        _;
    }

    function _isOperator(address account) internal view returns (bool) {
        return roles.hasRole(OPERATOR_ROLE, account);
    }
}
