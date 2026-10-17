import { auditFindingRequestSchema } from "@treecord/shared";
import { requireRole } from "@/lib/server/auth";
import { loadOwnSession, loadSample, requireOpen, sampleView } from "@/lib/server/audit";
import { json, route } from "@/lib/server/errors";
import { parseUuid, readJson } from "@/lib/server/http";
import { getSupabase, unwrap } from "@/lib/server/supabase";

/**
 * POST /api/audit/sessions/:id/findings: records (or replaces) the finding for one sampled tree while the
 * session is open: ok, issue or needs_followup, with optional notes.
 */
export const POST = route(async (request, { params }: { params: Promise<{ id: string }> }) => {
  const auth = await requireRole(request, "auditor");
  const session = await loadOwnSession(auth, parseUuid((await params).id));
  requireOpen(session);
  const { treeId, finding, notes } = await readJson(request, auditFindingRequestSchema);
  await loadSample(session.id, Number(treeId));

  const sample = unwrap(
    await getSupabase()
      .from("audit_samples")
      .update({ finding, notes: notes ?? null, recorded_at: new Date().toISOString() })
      .eq("session_id", session.id)
      .eq("tree_id", Number(treeId))
      .select("*")
      .single(),
    "record finding",
  );
  return json({ sample: sampleView(sample) });
});
