import { keccak256, recoverTypedDataAddress, stringToBytes, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import {
  ATTESTATION_TYPEHASH,
  ATTESTATION_TYPE_STRING,
  attestationDomain,
  attestationExpiry,
  attestationKindOf,
  attestationTypes,
  hashAttestation,
  randomNonce,
  signAttestation,
  type Attestation,
} from "./eip712.js";
import { geohashToBytes8 } from "./evidence.js";

/**
 * Parity vector shared with packages/contracts/test/VerificationGateway.t.sol `test_parityFixture`, which
 * deploys the gateway at FIXTURE_GATEWAY on chain 84532 and asserts the same digest from Solidity.
 */
const FIXTURE_GATEWAY: Address = "0x1111111111111111111111111111111111111111";
const FIXTURE_DIGEST = "0xa2a16bb4d852b11e15802eaa9c06005c38528d81023d86e406cac952340062ed";
const FIXTURE: Attestation = {
  kind: 0,
  campaign: "0x2222222222222222222222222222222222222222",
  slotId: 12n,
  treeId: 0n,
  planter: "0x3333333333333333333333333333333333333333",
  milestone: 0,
  evidenceHash: keccak256(stringToBytes("treecord-fixture")),
  geohash: geohashToBytes8("qqguwvt"),
  score: 9200,
  nonce: 42n,
  expiry: 1_800_000_000n,
};

// Anvil account 2, the local attester.
const ATTESTER = privateKeyToAccount(
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
);

describe("EIP-712 attestation", () => {
  it("uses the exact type string from the spec", () => {
    expect(ATTESTATION_TYPE_STRING).toBe(
      "Attestation(uint8 kind,address campaign,uint256 slotId,uint256 treeId,address planter,uint8 milestone,bytes32 evidenceHash,bytes8 geohash,uint16 score,uint256 nonce,uint64 expiry)",
    );
    expect(ATTESTATION_TYPEHASH).toBe(keccak256(stringToBytes(ATTESTATION_TYPE_STRING)));
  });

  it("lists typed-data fields in type string order", () => {
    const fromTypes = `Attestation(${attestationTypes.Attestation.map((f) => `${f.type} ${f.name}`).join(",")})`;
    expect(fromTypes).toBe(ATTESTATION_TYPE_STRING);
  });

  it("builds the Treecord domain", () => {
    expect(attestationDomain(84532, FIXTURE_GATEWAY)).toEqual({
      name: "Treecord",
      version: "1",
      chainId: 84532,
      verifyingContract: FIXTURE_GATEWAY,
    });
  });

  it("matches the Solidity digest (parity fixture)", () => {
    expect(hashAttestation(FIXTURE, 84532, FIXTURE_GATEWAY)).toBe(FIXTURE_DIGEST);
  });

  it("changes the digest when any field, the chain or the gateway changes", () => {
    const base = hashAttestation(FIXTURE, 84532, FIXTURE_GATEWAY);
    expect(hashAttestation({ ...FIXTURE, nonce: 43n }, 84532, FIXTURE_GATEWAY)).not.toBe(base);
    expect(hashAttestation({ ...FIXTURE, score: 9201 }, 84532, FIXTURE_GATEWAY)).not.toBe(base);
    expect(hashAttestation(FIXTURE, 31337, FIXTURE_GATEWAY)).not.toBe(base);
    expect(hashAttestation(FIXTURE, 84532, "0x1111111111111111111111111111111111111112")).not.toBe(
      base,
    );
  });

  it("signs so the signature recovers to the attester", async () => {
    const signature = await signAttestation(ATTESTER, FIXTURE, 84532, FIXTURE_GATEWAY);
    expect(signature).toMatch(/^0x[0-9a-f]{130}$/);
    const recovered = await recoverTypedDataAddress({
      domain: attestationDomain(84532, FIXTURE_GATEWAY),
      types: attestationTypes,
      primaryType: "Attestation",
      message: FIXTURE,
      signature,
    });
    expect(recovered).toBe(ATTESTER.address);
  });

  it("maps evidence kinds to on-chain kinds", () => {
    expect(attestationKindOf("PLANTED")).toBe(0);
    expect(attestationKindOf("ALIVE")).toBe(1);
    expect(attestationKindOf("DEAD")).toBe(2);
    expect(attestationKindOf("REPLANTED")).toBe(3);
  });

  it("generates distinct uint256 nonces", () => {
    const nonces = new Set(Array.from({ length: 50 }, () => randomNonce()));
    expect(nonces.size).toBe(50);
    for (const nonce of nonces) {
      expect(nonce).toBeGreaterThanOrEqual(0n);
      expect(nonce).toBeLessThan(2n ** 256n);
    }
  });

  it("expires one hour after signing", () => {
    expect(attestationExpiry(1_800_000_000.7)).toBe(1_800_003_600n);
  });
});
