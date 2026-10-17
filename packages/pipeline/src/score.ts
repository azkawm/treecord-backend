// The `score` relayer job (PRODUCT_KNOWLEDGE.md section 15, rule 5): call the AI service, store its answer and
// keyframes, apply the policy, and attest passing submissions. Runs in the worker, never in a user request.
import {
  aiScoreResponseSchema,
  applyPolicy,
  type AiScoreRequest,
  type AiScoreResponse,
  type EvidencePayload,
  type Json,
} from "@treecord/shared";
import { AiServiceError, type AiClient } from "./ai-client.js";
import { attestSubmission, ensureAttestationJob, type AttestDeps } from "./attest.js";
import {
  consoleLogger,
  ensureOk,
  EVIDENCE_BUCKET,
  KEYFRAMES_BUCKET,
  loadSubmission,
  SIGNED_READ_URL_SECONDS,
  transitionSubmission,
  type Logger,
  type SubmissionRow,
  type SubmissionStatus,
} from "./db.js";
import { storeKeyframes } from "./keyframes.js";

export interface ScoreDeps extends AttestDeps {
  ai: AiClient;
  log?: Logger;
  /** Used to download keyframes returned as URLs. */
  fetch?: typeof fetch;
}

export interface ScoreJobOptions {
  /** True on the job's last attempt: a retryable AI failure then fails the submission instead of throwing. */
  finalAttempt?: boolean;
}

export interface ScoreOutcome {
  status: SubmissionStatus;
  reasons: string[];
  policyScore: number | null;
  /** The attestation job, when the submission was attested. */
  jobId: string | null;
  /** True when the submission was not in a scorable state, so nothing was done. */
  skipped: boolean;
}

/** Previous keyframes sent to the AI for growth consistency. */
const MAX_PREVIOUS_KEYFRAMES = 6;

/**
 * Processes one score job. Idempotent: a submission that already moved past `checking` is not scored again,
 * and a retry after a crash resumes from the stored AI response (`scored`) instead of calling the AI twice.
 *
 * Throws only for retryable failures (AI busy or unreachable, database errors), so the job queue can retry.
 */
export async function processScoreJob(
  deps: ScoreDeps,
  submissionId: string,
  options: ScoreJobOptions = {},
): Promise<ScoreOutcome> {
  const log = deps.log ?? consoleLogger;
  let submission = await loadSubmission(deps.db, submissionId);
  if (!submission) throw new Error(`Submission ${submissionId} not found`);

  if (submission.status === "attested") {
    const { jobId } = await ensureAttestationJob(deps.db, submission);
    return outcome(submission, jobId, true);
  }
  if (submission.status !== "checking" && submission.status !== "scored") {
    return outcome(submission, null, true);
  }

  if (submission.status === "checking") {
    let response: AiScoreResponse;
    try {
      response = await deps.ai.score(await buildRequest(deps, submission));
    } catch (error) {
      if (!(error instanceof AiServiceError)) throw error;
      if (error.status === 422) {
        log.info({ submissionId, error: error.message }, "AI could not read the video");
        return finish(deps, submission, ["checking"], {
          status: "rejected",
          reject_reasons: ["video_unreadable"],
        });
      }
      if (error.retryable && !options.finalAttempt) throw error;
      log.error({ submissionId, error: error.message }, "AI scoring failed");
      return finish(deps, submission, ["checking"], {
        status: "failed",
        error: error.message.slice(0, 1000),
      });
    }

    const keyframePaths = await storeKeyframes(
      deps.db,
      submission.id,
      response.keyframes,
      log,
      deps.fetch,
    );
    const scored = await transitionSubmission(deps.db, submission.id, ["checking"], {
      status: "scored",
      ai_response: response as unknown as Json,
      keyframe_paths: keyframePaths,
    });
    if (!scored) return outcome(await mustLoad(deps, submission.id), null, true);
    submission = scored;
  }

  // status is `scored` here: apply the policy to the stored response.
  const response = aiScoreResponseSchema.parse(submission.ai_response);
  const policy = applyPolicy(response.scores, {
    kind: submission.kind,
    challengeIssued: submission.challenge_id !== null,
  });
  const policyFields = {
    policy_decision: policy.decision,
    policy_score: policy.score,
    reject_reasons: policy.reasons,
  };

  if (policy.decision !== "pass") {
    return finish(deps, submission, ["scored"], {
      ...policyFields,
      status: policy.decision === "reject" ? "rejected" : "needs_review",
    });
  }

  const passed = await transitionSubmission(deps.db, submission.id, ["scored"], policyFields);
  if (!passed) return outcome(await mustLoad(deps, submission.id), null, true);
  const attested = await attestSubmission(deps, passed, ["scored"]);
  return outcome(attested.submission, attested.jobId, false);
}

async function buildRequest(deps: ScoreDeps, submission: SubmissionRow): Promise<AiScoreRequest> {
  const payload = submission.payload as unknown as EvidencePayload | null;
  if (!payload || !submission.video_path) {
    throw new Error(`Submission ${submission.id} has no payload or video`);
  }
  const { db } = deps;

  const video = await db.storage
    .from(EVIDENCE_BUCKET)
    .createSignedUrl(submission.video_path, SIGNED_READ_URL_SECONDS);
  if (video.error) throw video.error;

  const campaign = ensureOk(
    await db
      .from("campaigns")
      .select("species_name, species_code")
      .eq("address", submission.campaign_address)
      .single(),
    "load campaign",
  );

  let tree: AiScoreRequest["tree"] = null;
  if (submission.tree_id !== null) {
    const row = ensureOk(
      await db
        .from("trees")
        .select("tree_id, slot_id, campaign_address, planted_at")
        .eq("tree_id", submission.tree_id)
        .single(),
      "load tree",
    );
    tree = {
      treeId: String(row.tree_id),
      previousKeyframes: await previousKeyframes(deps, submission, row),
      plantedAt: new Date(row.planted_at).toISOString(),
    };
  }

  return {
    submissionId: submission.id,
    kind: submission.kind,
    video: {
      url: video.data.signedUrl,
      sha256: submission.video_sha256,
      durationHintSec: submission.duration_sec,
    },
    species: campaign.species_name ?? campaign.species_code ?? "unknown",
    location: { lat: payload.lat, lon: payload.lon, acc: payload.acc },
    capturedAt: payload.capturedAt,
    challengeCode: payload.challenge,
    tree,
  };
}

/** Signed URLs for keyframes of the tree's earlier accepted submissions (planting included), newest first. */
async function previousKeyframes(
  deps: ScoreDeps,
  submission: SubmissionRow,
  tree: { tree_id: number; slot_id: number; campaign_address: string },
): Promise<string[]> {
  const rows = ensureOk(
    await deps.db
      .from("submissions")
      .select("keyframe_paths, captured_at")
      .neq("id", submission.id)
      .in("status", ["attested", "onchain"])
      .or(
        `tree_id.eq.${tree.tree_id},and(kind.eq.PLANTED,campaign_address.eq.${tree.campaign_address},slot_id.eq.${tree.slot_id})`,
      )
      .order("captured_at", { ascending: false })
      .limit(MAX_PREVIOUS_KEYFRAMES),
    "load previous keyframes",
  );
  const paths = rows.flatMap((row) => row.keyframe_paths).slice(0, MAX_PREVIOUS_KEYFRAMES);
  if (paths.length === 0) return [];
  const signed = await deps.db.storage
    .from(KEYFRAMES_BUCKET)
    .createSignedUrls(paths, SIGNED_READ_URL_SECONDS);
  if (signed.error) throw signed.error;
  return signed.data.flatMap((entry) => (entry.signedUrl ? [entry.signedUrl] : []));
}

async function finish(
  deps: ScoreDeps,
  submission: SubmissionRow,
  from: SubmissionStatus[],
  changes: Parameters<typeof transitionSubmission>[3],
): Promise<ScoreOutcome> {
  const updated = await transitionSubmission(deps.db, submission.id, from, changes);
  return outcome(updated ?? (await mustLoad(deps, submission.id)), null, updated === null);
}

async function mustLoad(deps: ScoreDeps, id: string): Promise<SubmissionRow> {
  const row = await loadSubmission(deps.db, id);
  if (!row) throw new Error(`Submission ${id} disappeared`);
  return row;
}

function outcome(submission: SubmissionRow, jobId: string | null, skipped: boolean): ScoreOutcome {
  return {
    status: submission.status,
    reasons: submission.reject_reasons,
    policyScore: submission.policy_score,
    jobId,
    skipped,
  };
}
