// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Attestation} from "../libraries/TreecordTypes.sol";

/// @title IVerificationGateway
/// @notice Accepts EIP-712 attestations signed by an ATTESTER_ROLE key and routes them to the
///         TreeRegistry and the campaign. Anyone may submit a valid attestation. Implemented in prompt 3.
interface IVerificationGateway {
    /// @notice An attestation was verified and applied.
    event AttestationAccepted(
        uint256 indexed nonce, uint8 indexed kind, uint256 indexed treeId, bytes32 evidenceHash, uint16 score
    );

    /// @notice Verifies and applies one attestation. Returns the affected tree id.
    function submit(Attestation calldata att, bytes calldata signature) external returns (uint256 treeId);

    /// @notice Verifies and applies several attestations. Reverts the whole batch if any one fails.
    function submitBatch(Attestation[] calldata atts, bytes[] calldata signatures) external;

    /// @notice The EIP-712 digest of an attestation, for off-chain parity tests.
    function hashAttestation(Attestation calldata att) external view returns (bytes32);

    /// @notice True if a nonce has been used.
    function nonceUsed(uint256 nonce) external view returns (bool);
}
