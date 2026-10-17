import { attestSubmission, ensureAttestationJob, transitionSubmission } from "@treecord/pipeline";
import { submissionReviewRequestSchema } from "@treecord/shared";
import { attestDeps } from "@/lib/server/attester";
import { requireRole } from "@/lib/server/auth";
import { conflict, json, route } from "@/lib/server/errors";
import {
  latestJobId,
  loadTargetFacts,
  mustLoadSubmission,
  submissionView,
  targetOf,
} from "@/lib/server/evidence";
import { parseUuid, readJson } from "@/lib/server/http";
import { checkMilestoneOpen, checkTreeStatus, collectReasons } from "@/lib/server/precheck";
import { getSupabase } from "@/lib/server/supabase";

/**
 * POST /api/operator/submissions/:id/review: an operator decides a `needs_review` submission.
 * Approve signs the attestation and enqueues the relayer job, reject records the note. Both keep the policy's
 * own decision and reasons for the record.
 *
 * Repeating the same decision returns the current state (200). Deciding something that is not in review is 409.
 */
export const POST = route(async (request, { params }: { params: Promise<{ id: string }> }) => {
  const auth = await requireRole(request, "operator");
  const id = parseUuid((await params).id);
  const { approve, note } = await readJson(request, submissionReviewRequestSchema);
  const submission = await mustLoadSubmission(id);

  if (submission.status !== "needs_review") {
    const sameDecision =
      submission.reviewed_at !== null &&
      ((approve && (submission.status === "attested" || submission.status === "onchain")) ||
        (!approve && submission.status === "rejected"));
    if (!sameDecision) {
      throw conflict("not_in_review", "Only submissions in needs_review can be reviewed", {
        status: submission.status,
      });
    }
    const jobId =
      submission.status === "attested"
        ? (await ensureAttestationJob(getSupabase(), submission)).jobId
        : await latestJobId(id);
    return json({ submission: submissionView(submission, jobId), idempotent: true });
  }

  const review = { reviewerProfileId: auth.profile.id, note };

  if (!approve) {
    const rejected = await transitionSubmission(getSupabase(), id, ["needs_review"], {
      status: "rejected",
      reject_reasons: [...submission.reject_reasons, "operator_rejected"],
      reviewed_by_profile_id: review.reviewerProfileId,
      review_note: note,
      reviewed_at: new Date().toISOString(),
    });
    const current = rejected ?? (await mustLoadSubmission(id));
    return json({ submission: submissionView(current, null), idempotent: rejected === null });
  }

  // Time has passed since scoring: make sure the attestation can still land before signing it.
  const target = targetOf(submission);
  const facts = await loadTargetFacts(target, id);
  const blocking = facts.tree
    ? collectReasons([
        checkTreeStatus(target.kind, facts.tree, facts.chainNowSec),
        checkMilestoneOpen(
          target.kind,
          target.milestone,
          facts.tree,
          Number(facts.campaign.time_unit_seconds),
          facts.chainNowSec,
        ),
      ])
    : [];
  if (blocking.length > 0) {
    throw conflict(
      "cannot_attest",
      "This submission can no longer be attested. Reject it instead.",
      {
        reasons: blocking,
      },
    );
  }

  const outcome = await attestSubmission(attestDeps(), submission, ["needs_review"], review);
  return json({
    submission: submissionView(outcome.submission, outcome.jobId),
    idempotent: false,
  });
});
