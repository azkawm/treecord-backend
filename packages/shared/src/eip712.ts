// EIP-712 attestation types and helpers (PRODUCT_KNOWLEDGE.md section 8).
// Must stay byte-for-byte compatible with packages/contracts/src/VerificationGateway.sol.
import {
  hashTypedData,
  keccak256,
  stringToBytes,
  type Address,
  type Hex,
  type LocalAccount,
  type TypedDataDomain,
} from "viem";
import { ATTESTATION_TTL_SECONDS, EVIDENCE_KINDS, type EvidenceKind } from "./constants.js";

export const EIP712_NAME = "Treecord";
export const EIP712_VERSION = "1";

/** The exact EIP-712 type string. */
export const ATTESTATION_TYPE_STRING =
  "Attestation(uint8 kind,address campaign,uint256 slotId,uint256 treeId,address planter,uint8 milestone,bytes32 evidenceHash,bytes8 geohash,uint16 score,uint256 nonce,uint64 expiry)";

/** keccak256 of the type string. Equals VerificationGateway.ATTESTATION_TYPEHASH. */
export const ATTESTATION_TYPEHASH: Hex = keccak256(stringToBytes(ATTESTATION_TYPE_STRING));

/** viem typed-data definition, field order matching the type string. */
export const attestationTypes = {
  Attestation: [
    { name: "kind", type: "uint8" },
    { name: "campaign", type: "address" },
    { name: "slotId", type: "uint256" },
    { name: "treeId", type: "uint256" },
    { name: "planter", type: "address" },
    { name: "milestone", type: "uint8" },
    { name: "evidenceHash", type: "bytes32" },
    { name: "geohash", type: "bytes8" },
    { name: "score", type: "uint16" },
    { name: "nonce", type: "uint256" },
    { name: "expiry", type: "uint64" },
  ],
} as const;

/** An attestation as signed by the backend and submitted to VerificationGateway. */
export interface Attestation {
  kind: number;
  campaign: Address;
  slotId: bigint;
  treeId: bigint;
  planter: Address;
  milestone: number;
  evidenceHash: Hex;
  geohash: Hex;
  score: number;
  nonce: bigint;
  expiry: bigint;
}

/** The on-chain AttestationKind value for an evidence kind (PLANTED = 0 ... REPLANTED = 3). */
export function attestationKindOf(kind: EvidenceKind): number {
  return EVIDENCE_KINDS.indexOf(kind);
}

/** EIP-712 domain for a VerificationGateway deployment. */
export function attestationDomain(chainId: number, verifyingContract: Address): TypedDataDomain {
  return { name: EIP712_NAME, version: EIP712_VERSION, chainId, verifyingContract };
}

/** The EIP-712 digest. Equals VerificationGateway.hashAttestation(att). */
export function hashAttestation(
  attestation: Attestation,
  chainId: number,
  verifyingContract: Address,
): Hex {
  return hashTypedData({
    domain: attestationDomain(chainId, verifyingContract),
    types: attestationTypes,
    primaryType: "Attestation",
    message: attestation,
  });
}

/** Signs an attestation with a local account (the backend attester key). Returns a 65-byte signature. */
export async function signAttestation(
  account: LocalAccount,
  attestation: Attestation,
  chainId: number,
  verifyingContract: Address,
): Promise<Hex> {
  return account.signTypedData({
    domain: attestationDomain(chainId, verifyingContract),
    types: attestationTypes,
    primaryType: "Attestation",
    message: attestation,
  });
}

/** A uniformly random uint256 nonce. Nonces are single use on-chain. */
export function randomNonce(): bigint {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let value = 0n;
  for (const b of bytes) value = (value << 8n) | BigInt(b);
  return value;
}

/** Expiry timestamp (seconds) for an attestation signed at `nowSeconds`. */
export function attestationExpiry(nowSeconds: number): bigint {
  return BigInt(Math.floor(nowSeconds) + ATTESTATION_TTL_SECONDS);
}
