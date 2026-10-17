// One builder per job kind: how to simulate and send its contract call, with the ABI typed per contract.
import {
  anchorAssignJobPayloadSchema,
  campaignAbi,
  carbonLedgerAbi,
  claimJobPayloadSchema,
  estimateJobPayloadSchema,
  issueJobPayloadSchema,
  resolveFlagJobPayloadSchema,
  treeRegistryAbi,
  verificationGatewayAbi,
  type AttestationJobPayload,
  type TreecordDeployment,
} from "@treecord/shared";
import { deserializeAttestation, type SerializedAttestation } from "@treecord/pipeline";
import type { Account, Address, Hex, PublicClient } from "viem";
import type { Wallet } from "../chain.js";
import type { JobKind } from "./state.js";

export interface PreparedCall {
  /** Which wallet sends it. */
  wallet: "operator" | "relayer";
  /** For logs. */
  description: string;
  /** Throws the contract revert if the call would fail now. */
  simulate(client: PublicClient, account: Account): Promise<unknown>;
  send(wallet: Wallet, nonce: number): Promise<Hex>;
}

/** Thrown for a payload that fails its schema. The job fails without retrying. */
export class InvalidPayloadError extends Error {
  constructor(kind: string, issues: string) {
    super(`Invalid ${kind} job payload: ${issues}`);
    this.name = "InvalidPayloadError";
  }
}

function parse<T>(
  schema: {
    safeParse(value: unknown): { success: true; data: T } | { success: false; error: Error };
  },
  kind: string,
  payload: unknown,
): T {
  const result = schema.safeParse(payload);
  if (!result.success) throw new InvalidPayloadError(kind, result.error.message);
  return result.data;
}

/** Calls for the operator lane: claim, anchor_assign, estimate, issue, resolve_flag. */
export function operatorCall(
  kind: JobKind,
  payload: unknown,
  deployment: TreecordDeployment,
): PreparedCall {
  switch (kind) {
    case "claim":
    case "anchor_assign": {
      const p = parse(
        kind === "claim" ? claimJobPayloadSchema : anchorAssignJobPayloadSchema,
        kind,
        payload,
      );
      const address = p.campaign as Address;
      const args = [p.planter as Address, p.count] as const;
      const functionName = kind === "claim" ? "claimSlotsFor" : "assignAnchorSlots";
      return {
        wallet: "operator",
        description: `${functionName}(${p.planter}, ${p.count}) on ${p.campaign}`,
        simulate: (client, account) =>
          client.simulateContract({ address, abi: campaignAbi, functionName, args, account }),
        send: (wallet, nonce) =>
          wallet.writeContract({ address, abi: campaignAbi, functionName, args, nonce }),
      };
    }
    case "estimate": {
      const p = parse(estimateJobPayloadSchema, kind, payload);
      const args = [p.campaign as Address, BigInt(p.estimatedAmount)] as const;
      const address = deployment.carbonLedger;
      return {
        wallet: "operator",
        description: `setEstimate(${p.campaign}, ${p.estimatedAmount})`,
        simulate: (client, account) =>
          client.simulateContract({
            address,
            abi: carbonLedgerAbi,
            functionName: "setEstimate",
            args,
            account,
          }),
        send: (wallet, nonce) =>
          wallet.writeContract({
            address,
            abi: carbonLedgerAbi,
            functionName: "setEstimate",
            args,
            nonce,
          }),
      };
    }
    case "issue": {
      const p = parse(issueJobPayloadSchema, kind, payload);
      const args = [
        p.campaign as Address,
        p.registry,
        p.serialStart,
        p.serialEnd,
        p.vintage,
        BigInt(p.amount),
      ] as const;
      const address = deployment.carbonLedger;
      return {
        wallet: "operator",
        description: `issueBatch(${p.campaign}, ${p.registry} ${p.serialStart}..${p.serialEnd}, ${p.amount})`,
        simulate: (client, account) =>
          client.simulateContract({
            address,
            abi: carbonLedgerAbi,
            functionName: "issueBatch",
            args,
            account,
          }),
        send: (wallet, nonce) =>
          wallet.writeContract({
            address,
            abi: carbonLedgerAbi,
            functionName: "issueBatch",
            args,
            nonce,
          }),
      };
    }
    case "resolve_flag": {
      const p = parse(resolveFlagJobPayloadSchema, kind, payload);
      const args = [BigInt(p.treeId), p.uphold, p.noteHash as Hex] as const;
      const address = deployment.treeRegistry;
      return {
        wallet: "operator",
        description: `resolveFlag(${p.treeId}, ${p.uphold ? "uphold" : "dismiss"})`,
        simulate: (client, account) =>
          client.simulateContract({
            address,
            abi: treeRegistryAbi,
            functionName: "resolveFlag",
            args,
            account,
          }),
        send: (wallet, nonce) =>
          wallet.writeContract({
            address,
            abi: treeRegistryAbi,
            functionName: "resolveFlag",
            args,
            nonce,
          }),
      };
    }
    default:
      throw new Error(`${kind} jobs are not sent by the operator lane`);
  }
}

/** VerificationGateway.submit for one attestation, or submitBatch for several (all or nothing). */
export function attestationCall(
  payloads: AttestationJobPayload[],
  deployment: TreecordDeployment,
): PreparedCall {
  const address = deployment.verificationGateway;
  const atts = payloads.map((p) => deserializeAttestation(p.attestation as SerializedAttestation));
  const signatures = payloads.map((p) => p.signature as Hex);
  const [first] = atts;
  const [firstSignature] = signatures;
  if (atts.length === 1 && first && firstSignature) {
    const args = [first, firstSignature] as const;
    return {
      wallet: "relayer",
      description: `submit(nonce ${first.nonce})`,
      simulate: (client, account) =>
        client.simulateContract({
          address,
          abi: verificationGatewayAbi,
          functionName: "submit",
          args,
          account,
        }),
      send: (wallet, nonce) =>
        wallet.writeContract({
          address,
          abi: verificationGatewayAbi,
          functionName: "submit",
          args,
          nonce,
        }),
    };
  }
  const args = [atts, signatures] as const;
  return {
    wallet: "relayer",
    description: `submitBatch(${atts.length} attestations)`,
    simulate: (client, account) =>
      client.simulateContract({
        address,
        abi: verificationGatewayAbi,
        functionName: "submitBatch",
        args,
        account,
      }),
    send: (wallet, nonce) =>
      wallet.writeContract({
        address,
        abi: verificationGatewayAbi,
        functionName: "submitBatch",
        args,
        nonce,
      }),
  };
}
