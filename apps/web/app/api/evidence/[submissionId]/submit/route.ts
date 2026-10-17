import {
  ensureJob,
  EVIDENCE_BUCKET,
  scoreJobKey,
  transitionSubmission,
  type SubmissionRow,
} from "@treecord/pipeline";
import {
  base64UrlToBytes,
  canonicalize,
  computeEvidenceHash,
  evidenceSubmitRequestSchema,
  sha256Hex,
  utf8,
  type EcPublicJwk,
  type EvidencePayload,
  type Json,
} from "@treecord/shared";
import { requireRole, requireWallet } from "@/lib/server/auth";
import { badRequest, conflict, json, notFound, route } from "@/lib/server/errors";
import {
  latestJobId,
  loadTargetFacts,
  mustLoadSubmission,
  targetOf,
  targetReasons,
} from "@/lib/server/evidence";
import { parseUuid, readJson } from "@/lib/server/http";
import {
  checkCaptureTime,
  checkChallenge,
  checkDevice,
  checkGpsAccuracy,
  checkInsideRegion,
  checkNearTree,
  checkSignature,
  checkVideoHash,
  collectReasons,
} from "@/lib/server/precheck";
import { getSupabase, unwrapMaybe } from "@/lib/server/supabase";

type Params = { params: Promise<{ submissionId: string }> };

/**
 * POST /api/evidence/:submissionId/submit: the planter submits the signed payload after uploading the video.
 * Verifies the signature and the stored file's hash, runs every precheck, and on success enqueues a `score`
 * job for the worker (PRODUCT_KNOWLEDGE.md section 15, rule 5). The client then polls GET /api/evidence/:id.
 *
 * Idempotent per submission: once a submission has left `queued`, repeating the request returns its current
 * state (200, or 422 if it was rejected) without running anything again.
 */
export const POST = route(async (request, { params }: Params) => {
  const auth = await requireRole(request, "planter");
  const wallet = requireWallet(auth);
  const id = parseUuid((await params).submissionId, "submissionId");
  const body = await readJson(request, evidenceSubmitRequestSchema);
  const payload = body.payload as EvidencePayload;

  let submission = await mustLoadSubmission(id);
  if (submission.profile_id !== auth.profile.id) throw notFound("Submission");
  if (submission.status !== "queued") return replay(submission);

  assertMatchesSubmission(submission, payload, body.canonical);

  // Take the submission so a concurrent duplicate request cannot process it twice.
  const taken = await transitionSubmission(getSupabase(), id, ["queued"], { status: "uploaded" });
  if (!taken) return replay(await mustLoadSubmission(id));
  submission = taken;

  try {
    return await process(submission, payload, body.canonical, body.signature, wallet);
  } catch (error) {
    // Infrastructure failures (storage, database) must not burn the submission: hand it back to the planter.
    await transitionSubmission(getSupabase(), id, ["uploaded"], { status: "queued" }).catch(
      () => null,
    );
    throw error;
  }
});

async function process(
  submission: SubmissionRow,
  payload: EvidencePayload,
  canonical: string,
  signature: string,
  wallet: string,
): Promise<Response> {
  const db = getSupabase();

  const download = await db.storage.from(EVIDENCE_BUCKET).download(submission.video_path ?? "");
  if (download.error) {
    throw conflict("video_not_uploaded", "Upload the video to the signed URL before submitting");
  }
  const video = new Uint8Array(await download.data.arrayBuffer());

  const [deviceResult, facts] = await Promise.all([
    db
      .from("devices")
      .select("id, profile_id, public_key_jwk, revoked_at")
      .eq("thumbprint", payload.deviceKey)
      .maybeSingle(),
    loadTargetFacts(targetOf(submission), submission.id),
  ]);
  const device = unwrapMaybe(deviceResult, "load device");

  const canonicalBytes = utf8(canonical);
  const point = { lat: payload.lat, lon: payload.lon };
  const deviceReason = checkDevice(
    device ? { profileId: device.profile_id, revokedAt: device.revoked_at } : null,
    submission.profile_id,
  );
  const reasons = collectReasons([
    deviceReason,
    // A signature is only meaningful against a known, active device key of this planter.
    deviceReason || !device
      ? null
      : await checkSignature(device.public_key_jwk as EcPublicJwk, canonicalBytes, signature),
    checkVideoHash(await sha256Hex(video), payload.videoSha256),
    checkCaptureTime(payload.capturedAt, Date.now()),
    checkGpsAccuracy(payload.acc),
    submission.kind === "PLANTED"
      ? checkInsideRegion(
          point,
          facts.campaign.region_center_lat !== null && facts.campaign.region_center_lon !== null
            ? { lat: facts.campaign.region_center_lat, lon: facts.campaign.region_center_lon }
            : null,
          facts.campaign.region_radius_m,
        )
      : checkNearTree(point, facts.tree?.location ?? null),
    checkChallenge(facts.activeChallenge?.code ?? null, payload.challenge),
    ...targetReasons(targetOf(submission), facts, wallet, submission.duration_sec),
  ]);

  const evidenceFields = {
    payload: payload as unknown as Json,
    canonical,
    signature,
    evidence_hash: computeEvidenceHash(canonicalBytes, base64UrlToBytes(signature)),
    captured_at: payload.capturedAt,
    device_id: device?.id ?? null,
    size_bytes: video.length,
  };

  if (reasons.length > 0) {
    const rejected = await transitionSubmission(db, submission.id, ["uploaded"], {
      ...evidenceFields,
      status: "rejected",
      reject_reasons: reasons,
    });
    return result(rejected ?? (await mustLoadSubmission(submission.id)), null, false);
  }

  const checking = await transitionSubmission(db, submission.id, ["uploaded"], {
    ...evidenceFields,
    status: "checking",
    challenge_id: facts.activeChallenge?.id ?? null,
  });
  if (!checking) return replay(await mustLoadSubmission(submission.id));
  const jobId = await ensureScoreJob(checking);
  return result(checking, jobId, false);
}

/** The signed payload must describe the announced video and target, and `canonical` must be its exact bytes. */
function assertMatchesSubmission(
  submission: SubmissionRow,
  payload: EvidencePayload,
  canonical: string,
): void {
  const mismatched: string[] = [];
  if (payload.kind !== submission.kind) mismatched.push("kind");
  if (payload.campaign !== submission.campaign_address) mismatched.push("campaign");
  if (payload.slotId !== (submission.slot_id === null ? null : String(submission.slot_id)))
    mismatched.push("slotId");
  if (payload.treeId !== (submission.tree_id === null ? null : String(submission.tree_id)))
    mismatched.push("treeId");
  if (payload.milestone !== submission.milestone) mismatched.push("milestone");
  if (payload.videoSha256 !== submission.video_sha256) mismatched.push("videoSha256");
  if (mismatched.length > 0) {
    throw badRequest("payload_mismatch", "The signed payload does not match the announced upload", {
      fields: mismatched,
    });
  }
  if (canonical !== canonicalize(payload)) {
    throw badRequest("canonical_mismatch", "canonical must equal the canonical form of payload");
  }
}

async function ensureScoreJob(submission: SubmissionRow): Promise<string> {
  return ensureJob(
    getSupabase(),
    "score",
    { submissionId: submission.id },
    scoreJobKey(submission.id),
    submission.profile_id,
  );
}

/** Current state of an already submitted submission. Re-creates a lost score job for `checking`. */
async function replay(submission: SubmissionRow): Promise<Response> {
  if (submission.status === "uploaded") {
    throw conflict(
      "submission_in_progress",
      "This submission is being checked. Try again shortly.",
    );
  }
  const jobId =
    submission.status === "checking"
      ? await ensureScoreJob(submission)
      : await latestJobId(submission.id);
  return result(submission, jobId, true);
}

function result(submission: SubmissionRow, jobId: string | null, idempotent: boolean): Response {
  const body = {
    submissionId: submission.id,
    status: submission.status,
    reasons: submission.reject_reasons,
    policyScore: submission.policy_score,
    jobId,
    idempotent,
  };
  if (submission.status === "rejected") {
    return json(
      {
        ...body,
        error: {
          code: "evidence_rejected",
          message: "Evidence was rejected",
          details: { reasons: submission.reject_reasons },
        },
      },
      { status: 422 },
    );
  }
  return json(body, { status: idempotent ? 200 : 202 });
}
