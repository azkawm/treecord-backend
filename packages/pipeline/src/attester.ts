// Signs EIP-712 attestations with the attester key (PRODUCT_KNOWLEDGE.md section 8). Never sends transactions.
import {
  attestationExpiry,
  attestationKindOf,
  hashAttestation,
  randomNonce,
  signAttestation,
  type Attestation,
  type EvidenceKind,
} from "@treecord/shared";
import type { Address, Hex, LocalAccount } from "viem";
import { privateKeyToAccount } from "viem/accounts";

export interface AttestationInput {
  kind: EvidenceKind;
  campaign: Address;
  /** Set for PLANTED, 0 otherwise. */
  slotId: bigint;
  /** 0 for PLANTED, set otherwise. */
  treeId: bigint;
  planter: Address;
  milestone: number;
  evidenceHash: Hex;
  /** Precision-7 geohash as bytes8. */
  geohash: Hex;
  /** Policy score, 0 to 10000. */
  score: number;
}

/** Attestation with every uint256 and uint64 as a decimal string, for JSON storage and job payloads. */
export interface SerializedAttestation {
  kind: number;
  campaign: Address;
  slotId: string;
  treeId: string;
  planter: Address;
  milestone: number;
  evidenceHash: Hex;
  geohash: Hex;
  score: number;
  nonce: string;
  expiry: string;
}

/** What is stored in submissions.attestation and sent to the relayer. */
export interface SignedAttestationRecord {
  attestation: SerializedAttestation;
  signature: Hex;
  /** EIP-712 digest. Equals VerificationGateway.hashAttestation(attestation). */
  digest: Hex;
  signer: Address;
  chainId: number;
  verifyingContract: Address;
  signedAt: string;
}

export class Attester {
  private readonly account: LocalAccount;

  constructor(
    privateKey: Hex,
    readonly chainId: number,
    readonly verifyingContract: Address,
  ) {
    this.account = privateKeyToAccount(privateKey);
  }

  get address(): Address {
    return this.account.address;
  }

  /**
   * Signs an attestation. The nonce is a fresh random uint256 and the expiry is one hour after `nowSeconds`,
   * which should be chain time because the gateway compares it with block.timestamp.
   */
  async sign(
    input: AttestationInput,
    nowSeconds: number,
    nonce: bigint = randomNonce(),
  ): Promise<SignedAttestationRecord> {
    const attestation: Attestation = {
      kind: attestationKindOf(input.kind),
      campaign: input.campaign,
      slotId: input.slotId,
      treeId: input.treeId,
      planter: input.planter,
      milestone: input.milestone,
      evidenceHash: input.evidenceHash,
      geohash: input.geohash,
      score: input.score,
      nonce,
      expiry: attestationExpiry(nowSeconds),
    };
    const signature = await signAttestation(
      this.account,
      attestation,
      this.chainId,
      this.verifyingContract,
    );
    return {
      attestation: serializeAttestation(attestation),
      signature,
      digest: hashAttestation(attestation, this.chainId, this.verifyingContract),
      signer: this.account.address,
      chainId: this.chainId,
      verifyingContract: this.verifyingContract,
      signedAt: new Date().toISOString(),
    };
  }
}

export function serializeAttestation(attestation: Attestation): SerializedAttestation {
  return {
    ...attestation,
    slotId: attestation.slotId.toString(),
    treeId: attestation.treeId.toString(),
    nonce: attestation.nonce.toString(),
    expiry: attestation.expiry.toString(),
  };
}

export function deserializeAttestation(attestation: SerializedAttestation): Attestation {
  return {
    ...attestation,
    slotId: BigInt(attestation.slotId),
    treeId: BigInt(attestation.treeId),
    nonce: BigInt(attestation.nonce),
    expiry: BigInt(attestation.expiry),
  };
}
