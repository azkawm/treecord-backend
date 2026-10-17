import { requireRole, requireWallet } from "@/lib/server/auth";
import { json, route } from "@/lib/server/errors";
import { getSupabase, unwrap } from "@/lib/server/supabase";

/**
 * GET /api/planter/challenges: open "prove it now" challenges on the caller's trees. The code must appear in
 * the signed payload of the next check-in for that tree before the challenge expires.
 */
export const GET = route(async (request) => {
  const auth = await requireRole(request, "planter");
  const wallet = requireWallet(auth);
  const db = getSupabase();

  const trees = unwrap(
    await db.from("trees").select("tree_id, campaign_address").eq("planter_address", wallet),
    "load planter trees",
  );
  if (trees.length === 0) return json({ challenges: [] });

  const challenges = unwrap(
    await db
      .from("challenges")
      .select("id, tree_id, code, expires_at, created_at")
      .in(
        "tree_id",
        trees.map((t) => t.tree_id),
      )
      .is("fulfilled_submission_id", null)
      .gt("expires_at", new Date().toISOString())
      .order("expires_at"),
    "load challenges",
  );
  const campaignOf = new Map(trees.map((t) => [t.tree_id, t.campaign_address]));
  return json({
    challenges: challenges.map((c) => ({
      id: c.id,
      treeId: c.tree_id,
      campaign: campaignOf.get(c.tree_id) ?? null,
      code: c.code,
      issuedAt: c.created_at,
      expiresAt: c.expires_at,
    })),
  });
});
