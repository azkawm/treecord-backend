// Backend evidence policy (AI_SERVICE_INTERFACE.md "Backend policy" and PRODUCT_KNOWLEDGE.md section 15, rule 1).
// The AI service scores; this function decides. It is pure so the worker, the operator review endpoint and
// tests all share one implementation.
import type { AiScores } from "./ai.js";
import { MAX_ATTESTATION_SCORE, type EvidenceKind } from "./constants.js";

export type PolicyDecision = "pass" | "reject" | "needs_review";

export interface PolicyResult {
  decision: PolicyDecision;
  /** Attestation score, 0 to 10000. */
  score: number;
  /** Reason codes for every reject and review finding, in rule order. Empty on a clean pass. */
  reasons: string[];
}

export interface PolicyContext {
  kind: EvidenceKind;
  /** True when an auditor challenge was active for this submission. */
  challengeIssued: boolean;
}

/**
 * Thresholds. `reject` is the hard limit from the interface. `review` is 0.10 inside it, written as a literal
 * to avoid floating point drift (0.7 + 0.1 !== 0.8). The borderline band is one-sided: a score past `reject`
 * is always rejected, a passing score that has not cleared `review` goes to needs_review.
 */
export const POLICY_THRESHOLDS = {
  /** Higher is better. Reject below 0.70, review below 0.80. */
  liveness: { reject: 0.7, review: 0.8 },
  /** Higher is better. Reject below 0.70, review below 0.80. */
  treePresence: { reject: 0.7, review: 0.8 },
  /** Higher is better, ALIVE only. Reject below 0.50, review below 0.60. */
  growthConsistency: { reject: 0.5, review: 0.6 },
  /** Higher is better, only with a challenge. Reject below 0.80, review below 0.90. */
  challengeVisible: { reject: 0.8, review: 0.9 },
  /** Lower is better. Reject above 0.30, review above 0.20. */
  recapture: { reject: 0.3, review: 0.2 },
  /** Lower is better. Reject above 0.90, review above 0.80. */
  duplicate: { reject: 0.9, review: 0.8 },
} as const;

/** Attestation score weights (sum to 1). Growth is replaced by tree presence when it does not apply. */
export const SCORE_WEIGHTS = {
  liveness: 0.3,
  treePresence: 0.3,
  inverseRecapture: 0.2,
  growthConsistency: 0.2,
} as const;

/**
 * Applies the policy to AI scores.
 *
 * Growth consistency is checked for ALIVE only. PLANTED has no history, a DEAD tree is not expected to
 * show growth, and a REPLANTED seedling is a new plant, so for those kinds tree presence stands in for growth
 * in the score. `speciesMatch` and `ndvi` are advisory and never affect the decision.
 */
export function applyPolicy(scores: AiScores, context: PolicyContext): PolicyResult {
  const rejects: string[] = [];
  const reviews: string[] = [];
  const t = POLICY_THRESHOLDS;

  higherIsBetter(scores.liveness, t.liveness, "liveness", rejects, reviews);
  lowerIsBetter(scores.recapture, t.recapture, "recapture", rejects, reviews);
  higherIsBetter(scores.treePresence, t.treePresence, "tree_presence", rejects, reviews);
  lowerIsBetter(scores.duplicate.maxSimilarity, t.duplicate, "duplicate", rejects, reviews);

  const growthApplies = context.kind === "ALIVE";
  if (growthApplies) {
    if (scores.growthConsistency === null) {
      reviews.push("growth_missing");
    } else {
      higherIsBetter(scores.growthConsistency, t.growthConsistency, "growth", rejects, reviews);
    }
  }

  if (context.challengeIssued) {
    if (scores.challengeVisible === null) {
      rejects.push("challenge_not_scored");
    } else {
      higherIsBetter(scores.challengeVisible, t.challengeVisible, "challenge", rejects, reviews);
    }
  }

  const growth =
    growthApplies && scores.growthConsistency !== null
      ? scores.growthConsistency
      : scores.treePresence;
  const weighted =
    SCORE_WEIGHTS.liveness * scores.liveness +
    SCORE_WEIGHTS.treePresence * scores.treePresence +
    SCORE_WEIGHTS.inverseRecapture * (1 - scores.recapture) +
    SCORE_WEIGHTS.growthConsistency * growth;
  const score = Math.min(
    MAX_ATTESTATION_SCORE,
    Math.max(0, Math.round(weighted * MAX_ATTESTATION_SCORE)),
  );

  const decision: PolicyDecision =
    rejects.length > 0 ? "reject" : reviews.length > 0 ? "needs_review" : "pass";
  return { decision, score, reasons: [...rejects, ...reviews] };
}

function higherIsBetter(
  value: number,
  limits: { reject: number; review: number },
  name: string,
  rejects: string[],
  reviews: string[],
): void {
  if (value < limits.reject) rejects.push(`${name}_low`);
  else if (value < limits.review) reviews.push(`${name}_borderline`);
}

function lowerIsBetter(
  value: number,
  limits: { reject: number; review: number },
  name: string,
  rejects: string[],
  reviews: string[],
): void {
  if (value > limits.reject) rejects.push(`${name}_high`);
  else if (value > limits.review) reviews.push(`${name}_borderline`);
}
