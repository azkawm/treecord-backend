import { ATTESTATION_TTL_SECONDS, attestationTypes, hashAttestation } from "@treecord/shared";
import { recoverTypedDataAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { Attester, deserializeAttestation } from "./attester.js";

// Anvil account 2, the local attester. Public test key.
const KEY = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a";
const GATEWAY = "0x5FC8d32690cc91D4c39d9d3abcBD16989F875707";

const input = {
  kind: "ALIVE" as const,
  campaign: "0x856e4424f806d16e8cbc702b3c0f2ede5468eae5" as const,
  slotId: 0n,
  treeId: 7n,
  planter: "0x90f79bf6eb2c4f870365e785982e1f101e93b906" as const,
  milestone: 2,
  evidenceHash: `0x${"ab".repeat(32)}` as const,
  geohash: "0x7171677577767400" as const,
  score: 9120,
};

describe("Attester", () => {
  const attester = new Attester(KEY, 31337, GATEWAY);

  it("signs an attestation that recovers to the attester and matches hashAttestation", async () => {
    const record = await attester.sign(input, 1_800_000_000);
    const attestation = deserializeAttestation(record.attestation);

    expect(attestation).toMatchObject({ kind: 1, treeId: 7n, milestone: 2, score: 9120 });
    expect(attestation.expiry).toBe(BigInt(1_800_000_000 + ATTESTATION_TTL_SECONDS));
    expect(record.digest).toBe(hashAttestation(attestation, 31337, GATEWAY));
    expect(record.signer).toBe(privateKeyToAccount(KEY).address);

    const recovered = await recoverTypedDataAddress({
      domain: { name: "Treecord", version: "1", chainId: 31337, verifyingContract: GATEWAY },
      types: attestationTypes,
      primaryType: "Attestation",
      message: attestation,
      signature: record.signature,
    });
    expect(recovered).toBe(attester.address);
  });

  it("uses a fresh random nonce every time, or the one given", async () => {
    const a = await attester.sign(input, 1_800_000_000);
    const b = await attester.sign(input, 1_800_000_000);
    expect(a.attestation.nonce).not.toBe(b.attestation.nonce);
    expect(BigInt(a.attestation.nonce)).toBeGreaterThan(0n);
    const fixed = await attester.sign(input, 1_800_000_000, 42n);
    expect(fixed.attestation.nonce).toBe("42");
  });

  it("serializes bigints as decimal strings for JSON storage", async () => {
    const record = await attester.sign(input, 1_800_000_000, 2n ** 255n);
    const roundTrip = JSON.parse(JSON.stringify(record)) as typeof record;
    expect(roundTrip.attestation.nonce).toBe((2n ** 255n).toString());
    expect(deserializeAttestation(roundTrip.attestation).nonce).toBe(2n ** 255n);
  });
});
