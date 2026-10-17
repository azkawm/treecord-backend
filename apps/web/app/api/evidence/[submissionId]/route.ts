import { authenticate } from "@/lib/server/auth";
import { json, notFound, route } from "@/lib/server/errors";
import { latestJobId, mustLoadSubmission, submissionView } from "@/lib/server/evidence";
import { parseUuid } from "@/lib/server/http";

/**
 * GET /api/evidence/:submissionId: status, reasons, AI scores, policy score and tx hash of a submission.
 * Visible to its planter, operators and auditors. Anyone else gets 404 so submission ids do not leak.
 */
export const GET = route(
  async (request, { params }: { params: Promise<{ submissionId: string }> }) => {
    const auth = await authenticate(request);
    const id = parseUuid((await params).submissionId, "submissionId");
    const submission = await mustLoadSubmission(id);

    const privileged = auth.profile.role === "operator" || auth.profile.role === "auditor";
    if (submission.profile_id !== auth.profile.id && !privileged) throw notFound("Submission");

    return json({ submission: submissionView(submission, await latestJobId(id)) });
  },
);
