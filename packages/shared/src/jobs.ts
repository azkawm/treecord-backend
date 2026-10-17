// Payloads of relayer_jobs rows, one schema per job kind. The API and the pipeline write them, the worker
// validates them before acting. uint256 values travel as decimal strings.
import { z } from "zod";
import { lowercaseAddressSchema, uintStringSchema } from "./schemas.js";

const hex = (bytes: number) =>
  z
    .string()
    .regex(new RegExp(`^0x[0-9a-fA-F]{${bytes * 2}}$`), `must be 0x plus ${bytes * 2} hex digits`);

const uint16 = z.number().int().min(0).max(65_535);

/** `claim`: Campaign.claimSlotsFor(planter, count), sent by the operator wallet. */
export const claimJobPayloadSchema = z.object({
  campaign: lowercaseAddressSchema,
  planter: lowercaseAddressSchema,
  count: uint16.min(1),
});

/** `anchor_assign`: Campaign.assignAnchorSlots(planter, count), sent by the operator wallet. */
export const anchorAssignJobPayloadSchema = claimJobPayloadSchema;

/** `estimate`: CarbonLedger.setEstimate(campaign, estimatedAmount) in carbon units (1000 = 1 tCO2e). */
export const estimateJobPayloadSchema = z.object({
  campaign: lowercaseAddressSchema,
  estimatedAmount: uintStringSchema,
});

/** `issue`: CarbonLedger.issueBatch(...), sent by the operator wallet (which holds ISSUER_ROLE in the MVP). */
export const issueJobPayloadSchema = z.object({
  campaign: lowercaseAddressSchema,
  registry: z.string().min(1).max(64),
  serialStart: z.string().min(1).max(200),
  serialEnd: z.string().min(1).max(200),
  vintage: uint16,
  amount: uintStringSchema,
});

/** `resolve_flag`: TreeRegistry.resolveFlag(treeId, uphold, noteHash), sent by the operator wallet. */
export const resolveFlagJobPayloadSchema = z.object({
  treeId: uintStringSchema,
  uphold: z.boolean(),
  noteHash: hex(32),
});

/** `score`: runs the scoring pipeline for one submission in the worker. */
export const scoreJobPayloadSchema = z.object({
  submissionId: z.uuid(),
});

/** An EIP-712 attestation with uint256 and uint64 fields as decimal strings. */
export const serializedAttestationSchema = z.object({
  kind: z.number().int().min(0).max(3),
  campaign: hex(20),
  slotId: uintStringSchema,
  treeId: uintStringSchema,
  planter: hex(20),
  milestone: z.number().int().min(0).max(5),
  evidenceHash: hex(32),
  geohash: hex(8),
  score: z.number().int().min(0).max(10_000),
  nonce: uintStringSchema,
  expiry: uintStringSchema,
});

/** `attestation`: VerificationGateway.submit (or submitBatch), sent by the relayer wallet. */
export const attestationJobPayloadSchema = z.object({
  submissionId: z.uuid(),
  nonce: uintStringSchema,
  attestation: serializedAttestationSchema,
  signature: z.string().regex(/^0x[0-9a-fA-F]+$/, "must be 0x-prefixed hex"),
});

export type ClaimJobPayload = z.infer<typeof claimJobPayloadSchema>;
export type EstimateJobPayload = z.infer<typeof estimateJobPayloadSchema>;
export type IssueJobPayload = z.infer<typeof issueJobPayloadSchema>;
export type ResolveFlagJobPayload = z.infer<typeof resolveFlagJobPayloadSchema>;
export type ScoreJobPayload = z.infer<typeof scoreJobPayloadSchema>;
export type AttestationJobPayload = z.infer<typeof attestationJobPayloadSchema>;
