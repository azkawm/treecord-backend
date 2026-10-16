// zod schemas for API request bodies. Evidence and campaigns are defined now; prompts 7 to 10 add the rest.
import { z } from "zod";
import {
  DEFAULT_PER_PLANTER_CAP,
  EVIDENCE_KINDS,
  EVIDENCE_PAYLOAD_VERSION,
  MAX_VIDEO_BYTES,
  MILESTONE_COUNT,
} from "./constants.js";

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/** Any-case 0x address from user input, normalized to lowercase. */
export const addressInputSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, "must be a 0x-prefixed 20-byte hex address")
  .transform((value) => value.toLowerCase() as `0x${string}`);

/** Lowercase 0x address, required where the value is signed and must not be rewritten. */
export const lowercaseAddressSchema = z
  .string()
  .regex(/^0x[0-9a-f]{40}$/, "must be a lowercase 0x-prefixed 20-byte hex address");

/** Non-negative integer as a decimal string (uint256 ids). */
export const uintStringSchema = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,77})$/, "must be a decimal integer string");

/** USDC base units as a decimal string, parsed to bigint. Money never travels as a JS number. */
export const usdcAmountSchema = uintStringSchema.transform((value) => BigInt(value));

/** Lowercase hex SHA-256, no 0x prefix. */
export const sha256HexSchema = z
  .string()
  .regex(/^[0-9a-f]{64}$/, "must be a lowercase hex SHA-256");

/** ISO 8601 UTC with milliseconds, exactly as Date.prototype.toISOString produces. */
export const isoTimestampMsSchema = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    "must be an ISO timestamp like 2026-10-20T03:15:00.000Z",
  )
  .refine((value) => !Number.isNaN(Date.parse(value)), "must be a valid date");

const base64Url = (length: number) =>
  z
    .string()
    .regex(new RegExp(`^[A-Za-z0-9_-]{${length}}$`), `must be ${length} base64url characters`);

/** RFC 7638 SHA-256 thumbprint (32 bytes, base64url). */
export const jwkThumbprintSchema = base64Url(43);

/** P-256 public key JWK. Rejects keys that carry a private member. */
export const ecPublicJwkSchema = z
  .object({
    kty: z.literal("EC"),
    crv: z.literal("P-256"),
    x: base64Url(43),
    y: base64Url(43),
  })
  .loose()
  .refine((jwk) => !("d" in jwk), "must not include the private key");

export const evidenceKindSchema = z.enum(EVIDENCE_KINDS);

export const latitudeSchema = z.number().min(-90).max(90);
export const longitudeSchema = z.number().min(-180).max(180);

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

interface KindShape {
  kind: (typeof EVIDENCE_KINDS)[number];
  slotId?: string | null | undefined;
  treeId?: string | null | undefined;
  milestone: number;
}

/**
 * Kind-specific shape rules shared by the payload and the upload request:
 * PLANTED has a slot, no tree, milestone 0. ALIVE has a tree and milestone 1 to 5.
 * DEAD and REPLANTED have a tree and milestone 0.
 */
function checkKindShape(value: KindShape, ctx: z.RefinementCtx): void {
  const hasSlot = value.slotId !== null && value.slotId !== undefined;
  const hasTree = value.treeId !== null && value.treeId !== undefined;
  if (value.kind === "PLANTED") {
    if (!hasSlot)
      ctx.addIssue({ code: "custom", path: ["slotId"], message: "is required for PLANTED" });
    if (hasTree)
      ctx.addIssue({ code: "custom", path: ["treeId"], message: "must be null for PLANTED" });
    if (value.milestone !== 0)
      ctx.addIssue({ code: "custom", path: ["milestone"], message: "must be 0 for PLANTED" });
    return;
  }
  if (!hasTree)
    ctx.addIssue({ code: "custom", path: ["treeId"], message: `is required for ${value.kind}` });
  if (hasSlot)
    ctx.addIssue({ code: "custom", path: ["slotId"], message: `must be null for ${value.kind}` });
  if (value.kind === "ALIVE" && value.milestone < 1) {
    ctx.addIssue({ code: "custom", path: ["milestone"], message: "must be 1 to 5 for ALIVE" });
  }
  if (value.kind !== "ALIVE" && value.milestone !== 0) {
    ctx.addIssue({ code: "custom", path: ["milestone"], message: `must be 0 for ${value.kind}` });
  }
}

const milestoneSchema = z
  .number()
  .int()
  .min(0)
  .max(MILESTONE_COUNT - 1);

/**
 * The canonical evidence payload signed by the device (PRODUCT_KNOWLEDGE.md section 7). Validation is strict
 * and never rewrites values, because the server must reproduce the signed bytes exactly.
 * GPS accuracy is not capped here: an inaccurate fix is a precheck failure (`gps_inaccurate`), not bad input.
 */
export const evidencePayloadSchema = z
  .object({
    v: z.literal(EVIDENCE_PAYLOAD_VERSION),
    kind: evidenceKindSchema,
    campaign: lowercaseAddressSchema,
    slotId: uintStringSchema.nullable(),
    treeId: uintStringSchema.nullable(),
    milestone: milestoneSchema,
    videoSha256: sha256HexSchema,
    lat: latitudeSchema,
    lon: longitudeSchema,
    acc: z.number().nonnegative().max(100_000),
    capturedAt: isoTimestampMsSchema,
    challenge: z.string().min(1).max(32).nullable(),
    deviceKey: jwkThumbprintSchema,
  })
  .strict()
  .superRefine(checkKindShape);
export type EvidencePayloadInput = z.infer<typeof evidencePayloadSchema>;

/** POST /api/evidence/upload-url */
export const evidenceUploadUrlRequestSchema = z
  .object({
    kind: evidenceKindSchema,
    campaign: addressInputSchema,
    slotId: uintStringSchema.nullish(),
    treeId: uintStringSchema.nullish(),
    milestone: milestoneSchema,
    sha256: sha256HexSchema,
    sizeBytes: z.number().int().positive().max(MAX_VIDEO_BYTES),
    /** Duration from the recorder's metadata, checked against the 4 to 12 second server window. */
    durationSec: z.number().positive().max(600).optional(),
  })
  .strict()
  .superRefine(checkKindShape);
export type EvidenceUploadUrlRequest = z.infer<typeof evidenceUploadUrlRequestSchema>;

/** POST /api/evidence/:submissionId/submit */
export const evidenceSubmitRequestSchema = z
  .object({
    payload: evidencePayloadSchema,
    /** The exact UTF-8 string that was signed. Must equal canonicalize(payload). */
    canonical: z.string().min(2).max(4096),
    /** ECDSA P-256 signature, IEEE P1363 (64 bytes), base64url. */
    signature: base64Url(86),
  })
  .strict();
export type EvidenceSubmitRequest = z.infer<typeof evidenceSubmitRequestSchema>;

/** POST /api/operator/submissions/:id/review */
export const submissionReviewRequestSchema = z
  .object({
    approve: z.boolean(),
    note: z.string().trim().min(1).max(2000),
  })
  .strict();
export type SubmissionReviewRequest = z.infer<typeof submissionReviewRequestSchema>;

/** POST /api/devices */
export const deviceRegisterRequestSchema = z
  .object({
    publicKeyJwk: ecPublicJwkSchema,
    label: z.string().trim().min(1).max(64).optional(),
  })
  .strict();
export type DeviceRegisterRequest = z.infer<typeof deviceRegisterRequestSchema>;

// ---------------------------------------------------------------------------
// Campaigns
// ---------------------------------------------------------------------------

export const CAMPAIGN_STATUSES = ["funding", "active", "refunding", "completed"] as const;
export const campaignStatusSchema = z.enum(CAMPAIGN_STATUSES);

/** Species codes match the bytes32 speciesCode on-chain, for example SWIETENIA_MACROPHYLLA. */
export const speciesCodeSchema = z
  .string()
  .regex(
    /^[A-Z][A-Z0-9_]{0,31}$/,
    "must be uppercase letters, digits and underscores, at most 32 characters",
  );

/** POST /api/campaigns/metadata: off-chain metadata uploaded before calling the factory. */
export const campaignMetadataRequestSchema = z
  .object({
    title: z.string().trim().min(3).max(120),
    description: z.string().trim().max(5000).default(""),
    speciesCode: speciesCodeSchema,
    regionName: z.string().trim().min(2).max(120),
    regionCenter: z.object({ lat: latitudeSchema, lon: longitudeSchema }).strict(),
    regionRadiusM: z.number().int().min(100).max(100_000),
    imageUrls: z.array(z.url()).max(10).default([]),
  })
  .strict();
export type CampaignMetadataRequest = z.infer<typeof campaignMetadataRequestSchema>;

/** GET /api/campaigns query string. */
export const campaignListQuerySchema = z
  .object({
    status: campaignStatusSchema.optional(),
    species: speciesCodeSchema.optional(),
    region: z.string().trim().min(1).max(120).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    cursor: z.string().max(200).optional(),
  })
  .strict();
export type CampaignListQuery = z.infer<typeof campaignListQuerySchema>;

/** POST /api/campaigns/:address/claims */
export const claimSlotsRequestSchema = z
  .object({
    count: z.number().int().min(1).max(DEFAULT_PER_PLANTER_CAP),
  })
  .strict();
export type ClaimSlotsRequest = z.infer<typeof claimSlotsRequestSchema>;

/** POST /api/operator/campaigns/:address/anchor-assign */
export const anchorAssignRequestSchema = z
  .object({
    planter: addressInputSchema,
    count: z.number().int().min(1).max(65_535),
  })
  .strict();
export type AnchorAssignRequest = z.infer<typeof anchorAssignRequestSchema>;
