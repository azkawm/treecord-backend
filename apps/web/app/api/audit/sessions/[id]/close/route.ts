import {
  AUDIT_SAMPLE_ALGORITHM,
  auditCloseRequestSchema,
  reportHash,
  type JsonValue,
} from "@treecord/shared";
import { requireRole } from "@/lib/server/auth";
import { loadOwnSession, loadSamples, sessionView, type AuditSession } from "@/lib/server/audit";
import { conflict, json, route } from "@/lib/server/errors";
import { parseUuid, readJson } from "@/lib/server/http";
import { getSupabase, unwrap, unwrapMaybe } from "@/lib/server/supabase";

/**
 * POST /api/audit/sessions/:id/close: builds the report, stores report_hash = keccak256 of its canonical JSON
 * (keys sorted), and closes the session. Every sampled tree needs a finding first. Closing a closed session
 * returns the stored report.
 */
export const POST = route(async (request, { params }: { params: Promise<{ id: string }> }) => {
  const auth = await requireRole(request, "auditor");
  const session = await loadOwnSession(auth, parseUuid((await params).id));
  const { summary } = await readJson(request, auditCloseRequestSchema);
  if (session.status === "closed") {
    return json({ session: await sessionView(session), idempotent: true });
  }

  const samples = await loadSamples(session.id);
  const missing = samples.filter((s) => s.finding === null).map((s) => s.tree_id);
  if (missing.length > 0) {
    throw conflict(
      "findings_incomplete",
      "Record a finding for every sampled tree before closing",
      {
        missing,
      },
    );
  }

  const db = getSupabase();
  const challenges = unwrap(
    await db
      .from("challenges")
      .select("tree_id, code, created_at, expires_at, fulfilled_submission_id")
      .eq("audit_session_id", session.id)
      .order("created_at"),
    "load challenges",
  );
  const closedAt = new Date().toISOString();
  const count = (finding: string) => samples.filter((s) => s.finding === finding).length;

  const report: JsonValue = {
    version: 1,
    sessionId: session.id,
    campaign: session.campaign_address,
    auditor: { profileId: auth.profile.id, wallet: auth.wallet },
    seed: {
      blockNumber: String(session.seed_block_number),
      blockHash: session.seed_block_hash,
      seed: session.seed,
      algorithm: AUDIT_SAMPLE_ALGORITHM,
    },
    population: session.population_tree_ids.map(String),
    sampleSize: session.sample_size,
    findings: samples.map((s) => ({
      position: s.position,
      treeId: String(s.tree_id),
      finding: s.finding,
      notes: s.notes,
      recordedAt: s.recorded_at,
    })),
    totals: { ok: count("ok"), issue: count("issue"), needsFollowup: count("needs_followup") },
    challenges: challenges.map((c) => ({
      treeId: String(c.tree_id),
      code: c.code,
      issuedAt: c.created_at,
      expiresAt: c.expires_at,
      fulfilledSubmissionId: c.fulfilled_submission_id,
    })),
    summary,
    closedAt,
  };
  const hash = reportHash(report);

  const closed = unwrapMaybe(
    await db
      .from("audit_sessions")
      .update({ status: "closed", closed_at: closedAt, report, report_hash: hash })
      .eq("id", session.id)
      .eq("status", "open")
      .select("*")
      .maybeSingle(),
    "close audit session",
  );
  // A concurrent close won: return what it stored.
  const final: AuditSession = closed ?? (await loadOwnSession(auth, session.id));
  return json({ session: await sessionView(final), idempotent: closed === null });
});
