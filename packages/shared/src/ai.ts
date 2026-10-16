// Contract with the AI scoring service (AI_SERVICE_INTERFACE.md). The service only scores.
import { z } from "zod";
import { EVIDENCE_KINDS } from "./constants.js";

const unitScore = z.number().min(0).max(1);

/** Body of POST /v1/score. */
export const aiScoreRequestSchema = z.object({
  submissionId: z.uuid(),
  kind: z.enum(EVIDENCE_KINDS),
  video: z.object({
    url: z.url(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    durationHintSec: z.number().positive().nullable(),
  }),
  species: z.string().min(1),
  location: z.object({ lat: z.number(), lon: z.number(), acc: z.number().nonnegative() }),
  capturedAt: z.iso.datetime(),
  challengeCode: z.string().nullable(),
  tree: z
    .object({
      treeId: z.string(),
      previousKeyframes: z.array(z.string()),
      plantedAt: z.iso.datetime(),
    })
    .nullable(),
});
export type AiScoreRequest = z.infer<typeof aiScoreRequestSchema>;

/** 200 response of POST /v1/score. Validated before policy runs, so a malformed reply fails the submission. */
export const aiScoreResponseSchema = z.object({
  submissionId: z.string(),
  modelVersion: z.string(),
  scores: z.object({
    liveness: unitScore,
    recapture: unitScore,
    treePresence: unitScore,
    /** Advisory only in the MVP. */
    speciesMatch: unitScore.nullable(),
    /** Null for PLANTED. */
    growthConsistency: unitScore.nullable(),
    duplicate: z.object({
      maxSimilarity: unitScore,
      matchedSubmissionId: z.string().nullable(),
    }),
    /** Null when no challenge was issued. */
    challengeVisible: unitScore.nullable(),
    /** Advisory only in the MVP. */
    ndvi: z
      .object({
        value: z.number().min(-1).max(1),
        source: z.string(),
        date: z.string(),
      })
      .nullable(),
  }),
  /** Base64 data URLs or short-lived URLs. The backend copies them into its own storage (section 15, rule 6). */
  keyframes: z.array(z.string()),
  notes: z.array(z.string()).default([]),
});
export type AiScoreResponse = z.infer<typeof aiScoreResponseSchema>;
export type AiScores = AiScoreResponse["scores"];
