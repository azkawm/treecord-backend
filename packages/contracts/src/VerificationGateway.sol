// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

import {RoleGated, TreecordRoles} from "./TreecordRoles.sol";
import {ICampaign} from "./interfaces/ICampaign.sol";
import {ICampaignFactory} from "./interfaces/ICampaignFactory.sol";
import {ITreeRegistry} from "./interfaces/ITreeRegistry.sol";
import {IVerificationGateway} from "./interfaces/IVerificationGateway.sol";
import {
    Attestation,
    AttestationKind,
    Tree,
    AttestationExpired,
    InvalidAttestationKind,
    InvalidAttester,
    InvalidPlantedAttestation,
    InvalidScore,
    InvalidSignature,
    LengthMismatch,
    NonceAlreadyUsed,
    TreeCampaignMismatch,
    UnknownCampaign,
    WrongPlanter
} from "./libraries/TreecordTypes.sol";

/// @title VerificationGateway
/// @notice Verifies EIP-712 attestations signed by an ATTESTER_ROLE key and applies them to the TreeRegistry and
///         the tree's campaign. Anyone may submit a valid attestation; in practice the backend relayer does, so
///         planters never pay gas.
/// @dev Domain: name "Treecord", version "1", chainId = block.chainid, verifyingContract = this contract.
///      Type string (PRODUCT_KNOWLEDGE.md section 8):
///      Attestation(uint8 kind,address campaign,uint256 slotId,uint256 treeId,address planter,uint8 milestone,
///      bytes32 evidenceHash,bytes8 geohash,uint16 score,uint256 nonce,uint64 expiry)
///
///      Per kind:
///      - PLANTED (0): treeId and milestone must be 0. Registers the tree, then pays milestone 0.
///      - ALIVE (1): records a check-in, then pays `milestone`.
///      - DEAD (2): marks the tree dead.
///      - REPLANTED (3): marks a dead tree replanted.
///      For ALIVE, DEAD and REPLANTED the tree must belong to `campaign` and `planter` must be the tree's planter.
contract VerificationGateway is IVerificationGateway, RoleGated, EIP712, ReentrancyGuardTransient {
    /// @notice EIP-712 type hash of Attestation.
    bytes32 public constant ATTESTATION_TYPEHASH = keccak256(
        "Attestation(uint8 kind,address campaign,uint256 slotId,uint256 treeId,address planter,uint8 milestone,bytes32 evidenceHash,bytes8 geohash,uint16 score,uint256 nonce,uint64 expiry)"
    );

    /// @notice Maximum attestation score (100.00%).
    uint16 public constant MAX_SCORE = 10_000;

    /// @inheritdoc IVerificationGateway
    mapping(uint256 nonce => bool used) public nonceUsed;

    /// @param roles_ Central role registry. The factory and tree registry are read from it at call time.
    constructor(TreecordRoles roles_) RoleGated(roles_) EIP712("Treecord", "1") {}

    /// @inheritdoc IVerificationGateway
    function submit(Attestation calldata att, bytes calldata signature) external nonReentrant returns (uint256 treeId) {
        return _submit(att, signature);
    }

    /// @inheritdoc IVerificationGateway
    /// @dev All or nothing: any invalid attestation reverts the whole batch. The relayer simulates first and
    ///      drops failing items, so a revert means state changed between simulation and inclusion.
    function submitBatch(Attestation[] calldata atts, bytes[] calldata signatures) external nonReentrant {
        if (atts.length != signatures.length) revert LengthMismatch();
        for (uint256 i = 0; i < atts.length; ++i) {
            _submit(atts[i], signatures[i]);
        }
    }

    /// @inheritdoc IVerificationGateway
    function hashAttestation(Attestation calldata att) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    ATTESTATION_TYPEHASH,
                    att.kind,
                    att.campaign,
                    att.slotId,
                    att.treeId,
                    att.planter,
                    att.milestone,
                    att.evidenceHash,
                    att.geohash,
                    att.score,
                    att.nonce,
                    att.expiry
                )
            )
        );
    }

    /// @notice The EIP-712 domain separator for this chain.
    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    // _submit runs inside submitBatch's loop. Reverting the whole batch on any failure is the specified
    // behavior, batches are relayer-sized (at most 10), and every callee is a Treecord contract.
    // forge-lint: disable-next-item(calls-loop, require-revert-in-loop, reentrancy-events)
    function _submit(Attestation calldata att, bytes calldata signature) internal returns (uint256 treeId) {
        (address signer, ECDSA.RecoverError err,) = ECDSA.tryRecover(hashAttestation(att), signature);
        if (err != ECDSA.RecoverError.NoError) revert InvalidSignature();
        if (!roles.hasRole(ATTESTER_ROLE, signer)) revert InvalidAttester(signer);
        if (nonceUsed[att.nonce]) revert NonceAlreadyUsed(att.nonce);
        if (block.timestamp > att.expiry) revert AttestationExpired(att.expiry);
        if (att.score > MAX_SCORE) revert InvalidScore(att.score);
        if (att.kind > uint8(AttestationKind.Replanted)) revert InvalidAttestationKind(att.kind);
        if (!ICampaignFactory(roles.factory()).isCampaign(att.campaign)) revert UnknownCampaign(att.campaign);

        nonceUsed[att.nonce] = true;

        ITreeRegistry registry = ITreeRegistry(roles.treeRegistry());
        ICampaign campaign = ICampaign(att.campaign);

        if (att.kind == uint8(AttestationKind.Planted)) {
            if (att.treeId != 0 || att.milestone != 0) revert InvalidPlantedAttestation();
            treeId = registry.registerTree(att.campaign, att.slotId, att.planter, att.geohash, att.evidenceHash);
            campaign.releaseMilestone(treeId, 0, att.planter);
        } else {
            treeId = att.treeId;
            _requireTreeMatches(registry, att);
            if (att.kind == uint8(AttestationKind.Alive)) {
                registry.recordCheckIn(treeId, att.evidenceHash);
                campaign.releaseMilestone(treeId, att.milestone, att.planter);
            } else if (att.kind == uint8(AttestationKind.Dead)) {
                registry.markDead(treeId, att.evidenceHash);
            } else {
                registry.markReplanted(treeId, att.evidenceHash);
            }
        }

        emit AttestationAccepted(att.nonce, att.kind, treeId, att.evidenceHash, att.score);
    }

    // forge-lint: disable-next-item(calls-loop, require-revert-in-loop)
    function _requireTreeMatches(ITreeRegistry registry, Attestation calldata att) internal view {
        Tree memory tree = registry.getTree(att.treeId);
        if (tree.campaign != att.campaign) revert TreeCampaignMismatch(att.treeId, att.campaign);
        if (tree.planter != att.planter) revert WrongPlanter(att.treeId, att.planter);
    }
}
