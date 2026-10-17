import { describe, expect, it } from "vitest";
import { aiScoreResponseSchema } from "./ai.js";
import { MAX_VIDEO_BYTES } from "./constants.js";
import {
  addressInputSchema,
  anchorAssignRequestSchema,
  campaignListQuerySchema,
  campaignMetadataRequestSchema,
  claimSlotsRequestSchema,
  ecPublicJwkSchema,
  evidencePayloadSchema,
  evidenceSubmitRequestSchema,
  evidenceUploadUrlRequestSchema,
  isoTimestampMsSchema,
  usdcAmountSchema,
  carbonIssueRequestSchema,
  tonnesSchema,
  treeIdSchema,
} from "./schemas.js";

const SHA = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const THUMBPRINT = "NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs";
const COORD = "f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU";

const planted = {
  v: 1,
  kind: "PLANTED",
  campaign: "0x2222222222222222222222222222222222222222",
  slotId: "12",
  treeId: null,
  milestone: 0,
  videoSha256: SHA,
  lat: -6.2,
  lon: 106.816666,
  acc: 8.5,
  capturedAt: "2026-10-20T03:15:00.000Z",
  challenge: null,
  deviceKey: THUMBPRINT,
};

function issuesOf(result: {
  success: boolean;
  error?: { issues: { path: PropertyKey[] }[] };
}): string[] {
  return result.success ? [] : (result.error?.issues ?? []).map((issue) => issue.path.join("."));
}

describe("evidencePayloadSchema", () => {
  it("accepts a valid PLANTED payload without rewriting it", () => {
    expect(evidencePayloadSchema.parse(planted)).toEqual(planted);
  });

  it("accepts a valid ALIVE payload", () => {
    const alive = { ...planted, kind: "ALIVE", slotId: null, treeId: "42", milestone: 3 };
    expect(evidencePayloadSchema.safeParse(alive).success).toBe(true);
  });

  it("enforces kind-specific shape", () => {
    expect(issuesOf(evidencePayloadSchema.safeParse({ ...planted, treeId: "1" }))).toContain(
      "treeId",
    );
    expect(issuesOf(evidencePayloadSchema.safeParse({ ...planted, slotId: null }))).toContain(
      "slotId",
    );
    expect(issuesOf(evidencePayloadSchema.safeParse({ ...planted, milestone: 1 }))).toContain(
      "milestone",
    );
    const aliveMilestoneZero = {
      ...planted,
      kind: "ALIVE",
      slotId: null,
      treeId: "1",
      milestone: 0,
    };
    expect(issuesOf(evidencePayloadSchema.safeParse(aliveMilestoneZero))).toContain("milestone");
    const deadWithMilestone = { ...planted, kind: "DEAD", slotId: null, treeId: "1", milestone: 2 };
    expect(issuesOf(evidencePayloadSchema.safeParse(deadWithMilestone))).toContain("milestone");
  });

  it("requires a lowercase campaign because the value is signed", () => {
    const upper = { ...planted, campaign: "0xABCDEF0000000000000000000000000000000000" };
    expect(issuesOf(evidencePayloadSchema.safeParse(upper))).toContain("campaign");
  });

  it("rejects unknown keys and bad formats", () => {
    expect(evidencePayloadSchema.safeParse({ ...planted, extra: 1 }).success).toBe(false);
    expect(issuesOf(evidencePayloadSchema.safeParse({ ...planted, v: 2 }))).toContain("v");
    expect(issuesOf(evidencePayloadSchema.safeParse({ ...planted, lat: 91 }))).toContain("lat");
    expect(
      issuesOf(evidencePayloadSchema.safeParse({ ...planted, videoSha256: SHA.toUpperCase() })),
    ).toContain("videoSha256");
    expect(
      issuesOf(evidencePayloadSchema.safeParse({ ...planted, capturedAt: "2026-10-20T03:15:00Z" })),
    ).toContain("capturedAt");
    expect(issuesOf(evidencePayloadSchema.safeParse({ ...planted, slotId: "012" }))).toContain(
      "slotId",
    );
  });

  it("leaves GPS accuracy limits to the precheck", () => {
    expect(evidencePayloadSchema.safeParse({ ...planted, acc: 45 }).success).toBe(true);
  });
});

describe("evidence request schemas", () => {
  const upload = {
    kind: "PLANTED",
    campaign: "0xABCDEF0000000000000000000000000000000000",
    slotId: "12",
    milestone: 0,
    sha256: SHA,
    sizeBytes: 4_000_000,
    durationSec: 7.2,
  };

  it("normalizes the campaign address in the upload request", () => {
    expect(evidenceUploadUrlRequestSchema.parse(upload).campaign).toBe(
      "0xabcdef0000000000000000000000000000000000",
    );
  });

  it("caps uploads at 25 MB", () => {
    expect(
      evidenceUploadUrlRequestSchema.safeParse({ ...upload, sizeBytes: MAX_VIDEO_BYTES }).success,
    ).toBe(true);
    expect(
      evidenceUploadUrlRequestSchema.safeParse({ ...upload, sizeBytes: MAX_VIDEO_BYTES + 1 })
        .success,
    ).toBe(false);
  });

  it("requires a 64-byte base64url signature on submit", () => {
    const body = { payload: planted, canonical: "{}", signature: "A".repeat(86) };
    expect(evidenceSubmitRequestSchema.safeParse(body).success).toBe(true);
    expect(
      evidenceSubmitRequestSchema.safeParse({ ...body, signature: "A".repeat(85) }).success,
    ).toBe(false);
    expect(
      evidenceSubmitRequestSchema.safeParse({ ...body, signature: `${"A".repeat(85)}=` }).success,
    ).toBe(false);
  });
});

describe("primitives", () => {
  it("parses USDC amounts to bigint and rejects decimals", () => {
    expect(usdcAmountSchema.parse("1000000000000000000000")).toBe(1_000_000_000_000_000_000_000n);
    expect(usdcAmountSchema.safeParse("1.5").success).toBe(false);
    expect(usdcAmountSchema.safeParse("-1").success).toBe(false);
  });

  it("lowercases input addresses", () => {
    expect(addressInputSchema.parse("0xAbC0000000000000000000000000000000000001")).toBe(
      "0xabc0000000000000000000000000000000000001",
    );
    expect(addressInputSchema.safeParse("0x123").success).toBe(false);
  });

  it("accepts only millisecond UTC timestamps", () => {
    expect(isoTimestampMsSchema.safeParse("2026-10-20T03:15:00.000Z").success).toBe(true);
    expect(isoTimestampMsSchema.safeParse("2026-13-40T03:15:00.000Z").success).toBe(false);
    expect(isoTimestampMsSchema.safeParse("2026-10-20T03:15:00.000+07:00").success).toBe(false);
  });

  it("accepts P-256 public JWKs and rejects private keys", () => {
    const jwk = { kty: "EC", crv: "P-256", x: COORD, y: COORD, ext: true };
    expect(ecPublicJwkSchema.safeParse(jwk).success).toBe(true);
    expect(ecPublicJwkSchema.safeParse({ ...jwk, d: COORD }).success).toBe(false);
    expect(ecPublicJwkSchema.safeParse({ ...jwk, crv: "P-384" }).success).toBe(false);
  });
});

describe("campaign schemas", () => {
  it("validates metadata and fills defaults", () => {
    const parsed = campaignMetadataRequestSchema.parse({
      title: "Mahogany for Jakarta",
      speciesCode: "SWIETENIA_MACROPHYLLA",
      regionName: "Jakarta",
      regionCenter: { lat: -6.2, lon: 106.816666 },
      regionRadiusM: 5000,
    });
    expect(parsed.description).toBe("");
    expect(parsed.imageUrls).toEqual([]);
    expect(
      campaignMetadataRequestSchema.safeParse({ ...parsed, speciesCode: "mahogany" }).success,
    ).toBe(false);
  });

  it("coerces list query limits", () => {
    expect(campaignListQuerySchema.parse({ limit: "50", status: "active" })).toEqual({
      limit: 50,
      status: "active",
    });
    expect(campaignListQuerySchema.parse({}).limit).toBe(20);
    expect(campaignListQuerySchema.safeParse({ limit: "500" }).success).toBe(false);
  });

  it("bounds claims and anchor assignments", () => {
    expect(claimSlotsRequestSchema.safeParse({ count: 50 }).success).toBe(true);
    expect(claimSlotsRequestSchema.safeParse({ count: 51 }).success).toBe(false);
    expect(claimSlotsRequestSchema.safeParse({ count: 0 }).success).toBe(false);
    expect(
      anchorAssignRequestSchema.parse({
        planter: "0xAbC0000000000000000000000000000000000001",
        count: 3,
      }).planter,
    ).toBe("0xabc0000000000000000000000000000000000001");
  });
});

describe("aiScoreResponseSchema", () => {
  const response = {
    submissionId: "00000000-0000-4000-8000-000000000000",
    modelVersion: "treecord-ai-0.1.0",
    scores: {
      liveness: 0.94,
      recapture: 0.03,
      treePresence: 0.97,
      speciesMatch: 0.71,
      growthConsistency: 0.88,
      duplicate: { maxSimilarity: 0.12, matchedSubmissionId: null },
      challengeVisible: null,
      ndvi: { value: 0.41, source: "sentinel2-sample", date: "2026-10-01" },
    },
    keyframes: ["https://example.com/k1.jpg"],
    notes: ["Seedling height estimated 40 to 60 cm"],
  };

  it("accepts the interface example", () => {
    expect(aiScoreResponseSchema.parse(response)).toEqual(response);
  });

  it("rejects scores outside 0 to 1 and defaults notes", () => {
    const bad = { ...response, scores: { ...response.scores, liveness: 1.2 } };
    expect(aiScoreResponseSchema.safeParse(bad).success).toBe(false);
    const { notes: _notes, ...withoutNotes } = response;
    expect(aiScoreResponseSchema.parse(withoutNotes).notes).toEqual([]);
  });
});

describe("prompt 10 schemas", () => {
  it("tree ids: positive integers that fit the bigint column, never a throw", () => {
    expect(treeIdSchema.safeParse("42").success).toBe(true);
    expect(treeIdSchema.safeParse("9223372036854775807").success).toBe(true);
    expect(treeIdSchema.safeParse("9223372036854775808").success).toBe(false);
    for (const bad of ["0", "-1", "abc", "1.5", "", "01"]) {
      expect(() => treeIdSchema.safeParse(bad)).not.toThrow();
      expect(treeIdSchema.safeParse(bad).success).toBe(false);
    }
  });

  it("tonnes: up to 3 decimals and more than zero", () => {
    for (const ok of ["1", "12.5", "0.001", "1000000"])
      expect(tonnesSchema.safeParse(ok).success).toBe(true);
    for (const bad of ["0", "0.000", "1.2345", "-1", "1e3", "01"]) {
      expect(tonnesSchema.safeParse(bad).success).toBe(false);
    }
    expect(
      carbonIssueRequestSchema.safeParse({
        campaign: "0x856E4424F806D16E8CBC702B3C0F2EDE5468EAE5",
        registry: "SRN-PPI",
        serialStart: "A-1",
        serialEnd: "A-9",
        vintage: 2027,
        tonnes: "9",
      }),
    ).toMatchObject({
      success: true,
      data: { campaign: "0x856e4424f806d16e8cbc702b3c0f2ede5468eae5" },
    });
  });
});
