import { randomUUID } from "node:crypto";
import { EVIDENCE_BUCKET, SUBMISSION_COLUMNS, type SubmissionRow } from "@treecord/pipeline";
import { evidenceUploadUrlRequestSchema } from "@treecord/shared";
import { requireRole, requireWallet } from "@/lib/server/auth";
import { json, route } from "@/lib/server/errors";
import { loadTargetFacts, precheckFailed, targetOf, targetReasons } from "@/lib/server/evidence";
import { readJson } from "@/lib/server/http";
import { checkDuplicateVideo, type UploadTarget } from "@/lib/server/precheck";
import { getSupabase, PG, unwrap, unwrapMaybe } from "@/lib/server/supabase";

const EXTENSIONS = { "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov" } as const;

/** Signed upload URLs from Supabase Storage are valid for 2 hours. */
const UPLOAD_URL_TTL_SECONDS = 2 * 60 * 60;

/**
 * POST /api/evidence/upload-url: a planter announces a video (target, SHA-256, size) and gets a signed upload
 * URL. Target-level prechecks run first so a doomed video is never uploaded. Creates a `queued` submission.
 *
 * Retrying with the same owner, target and SHA-256 while the submission is still `queued` returns the same
 * submission with a fresh URL (200). Any other reuse of a video hash is `duplicate_video`.
 */
export const POST = route(async (request) => {
  const auth = await requireRole(request, "planter");
  const wallet = requireWallet(auth);
  const body = await readJson(request, evidenceUploadUrlRequestSchema);
  const db = getSupabase();

  const target: UploadTarget = {
    kind: body.kind,
    campaign: body.campaign,
    slotId: body.slotId ? Number(body.slotId) : null,
    treeId: body.treeId ? Number(body.treeId) : null,
    milestone: body.milestone,
  };

  const existing = await findBySha(body.sha256);
  if (existing) return reuseOrReject(existing, auth.profile.id, target);

  const facts = await loadTargetFacts(target);
  const reasons = targetReasons(target, facts, wallet, body.durationSec ?? null);
  if (reasons.length > 0) throw precheckFailed(reasons);

  const id = randomUUID();
  const path = `${auth.profile.id}/${id}.${EXTENSIONS[body.contentType]}`;
  const inserted = await db
    .from("submissions")
    .insert({
      id,
      profile_id: auth.profile.id,
      campaign_address: target.campaign,
      slot_id: target.slotId,
      tree_id: target.treeId,
      kind: target.kind,
      milestone: target.milestone,
      video_path: path,
      video_sha256: body.sha256,
      size_bytes: body.sizeBytes,
      duration_sec: body.durationSec ?? null,
    })
    .select(SUBMISSION_COLUMNS)
    .single();

  if (inserted.error?.code === PG.uniqueViolation) {
    // A concurrent request announced the same video first.
    const raced = await findBySha(body.sha256);
    if (raced) return reuseOrReject(raced, auth.profile.id, target);
  }
  const submission = unwrap(inserted, "create submission") as unknown as SubmissionRow;
  return json(await uploadResponse(submission, false), { status: 201 });
});

async function findBySha(sha256: string): Promise<SubmissionRow | null> {
  return unwrapMaybe(
    await getSupabase()
      .from("submissions")
      .select(SUBMISSION_COLUMNS)
      .eq("video_sha256", sha256)
      .maybeSingle(),
    "load submission by video hash",
  ) as unknown as SubmissionRow | null;
}

async function reuseOrReject(
  existing: SubmissionRow,
  profileId: string,
  target: UploadTarget,
): Promise<Response> {
  const reason = checkDuplicateVideo(
    { ...targetOf(existing), profileId: existing.profile_id, status: existing.status },
    profileId,
    target,
  );
  if (reason) throw precheckFailed([reason]);
  return json(await uploadResponse(existing, true));
}

async function uploadResponse(submission: SubmissionRow, idempotent: boolean) {
  const path = submission.video_path ?? "";
  const signed = await getSupabase()
    .storage.from(EVIDENCE_BUCKET)
    .createSignedUploadUrl(path, { upsert: true });
  if (signed.error) throw signed.error;
  return {
    submissionId: submission.id,
    uploadUrl: signed.data.signedUrl,
    token: signed.data.token,
    path,
    expiresInSec: UPLOAD_URL_TTL_SECONDS,
    idempotent,
  };
}
