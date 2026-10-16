import { authenticate } from "@/lib/server/auth";
import { json, notFound, route } from "@/lib/server/errors";
import { parseUuid } from "@/lib/server/http";
import { jobView } from "@/lib/server/jobs";
import { getSupabase, unwrapMaybe } from "@/lib/server/supabase";

/**
 * GET /api/jobs/:id: status of a relayer job. Visible to the user who created it and to operators.
 * Other callers get 404, so job ids do not leak. Only operators see the last error.
 */
export const GET = route(async (request, { params }: { params: Promise<{ id: string }> }) => {
  const { profile } = await authenticate(request);
  const id = parseUuid((await params).id);

  const job = unwrapMaybe(
    await getSupabase().from("relayer_jobs").select("*").eq("id", id).maybeSingle(),
    "load job",
  );
  const isOperator = profile.role === "operator";
  if (!job || (!isOperator && job.created_by_profile_id !== profile.id)) throw notFound("Job");
  return json({ job: jobView(job, isOperator) });
});
