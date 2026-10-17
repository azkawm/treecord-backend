import { auditChallengeRequestSchema } from "@treecord/shared";
import { requireRole } from "@/lib/server/auth";
import {
  challengeCode,
  challengeView,
  loadOwnSession,
  loadSample,
  requireOpen,
} from "@/lib/server/audit";
import { conflict, json, route } from "@/lib/server/errors";
import { parseUuid, readJson } from "@/lib/server/http";
import { getSupabase, unwrap, unwrapMaybe } from "@/lib/server/supabase";
import { loadTree } from "@/lib/server/trees";

/** A challenge stays open for this many campaign time units. */
const CHALLENGE_UNITS = 2;

/**
 * POST /api/audit/sessions/:id/challenges: "prove it now" for a sampled tree. The planter must record a new
 * check-in whose signed payload carries the code within 2 time units. One open challenge per tree.
 */
export const POST = route(async (request, { params }: { params: Promise<{ id: string }> }) => {
  const auth = await requireRole(request, "auditor");
  const session = await loadOwnSession(auth, parseUuid((await params).id));
  requireOpen(session);
  const { treeId } = await readJson(request, auditChallengeRequestSchema);
  await loadSample(session.id, Number(treeId));
  const tree = await loadTree(Number(treeId));
  const db = getSupabase();

  const active = unwrapMaybe(
    await db
      .from("challenges")
      .select("id, expires_at")
      .eq("tree_id", tree.tree_id)
      .is("fulfilled_submission_id", null)
      .gt("expires_at", new Date().toISOString())
      .limit(1)
      .maybeSingle(),
    "find active challenge",
  );
  if (active) {
    throw conflict("challenge_active", "This tree already has an open challenge", {
      challengeId: active.id,
      expiresAt: active.expires_at,
    });
  }
  if (tree.status !== "alive") {
    throw conflict("tree_not_alive", `A ${tree.status} tree cannot answer a challenge`, {
      status: tree.status,
    });
  }

  const campaign = unwrap(
    await db
      .from("campaigns")
      .select("time_unit_seconds")
      .eq("address", tree.campaign_address)
      .single(),
    "load campaign time unit",
  );
  const expiresAt = new Date(
    Date.now() + CHALLENGE_UNITS * Number(campaign.time_unit_seconds) * 1000,
  );
  const challenge = unwrap(
    await db
      .from("challenges")
      .insert({
        tree_id: tree.tree_id,
        code: challengeCode(),
        issued_by_profile_id: auth.profile.id,
        audit_session_id: session.id,
        expires_at: expiresAt.toISOString(),
      })
      .select("id, tree_id, code, expires_at, fulfilled_submission_id, created_at")
      .single(),
    "create challenge",
  );
  return json({ challenge: challengeView(challenge) }, { status: 201 });
});
