import { requireRole, requireWallet } from "@/lib/server/auth";
import { getChainNow } from "@/lib/server/chain";
import { json, route } from "@/lib/server/errors";
import { getSupabase, unwrap } from "@/lib/server/supabase";
import { milestoneSchedule, settledMilestones, treeLocation } from "@/lib/server/trees";

/**
 * GET /api/planter/trees: the caller's trees with every milestone window and amount, and the next milestone
 * to work towards (the first one still upcoming or open). Times are chain time, like the contracts use.
 */
export const GET = route(async (request) => {
  const auth = await requireRole(request, "planter");
  const wallet = requireWallet(auth);
  const db = getSupabase();

  const trees = unwrap(
    await db.from("trees").select("*").eq("planter_address", wallet).order("tree_id"),
    "load planter trees",
  );
  const addresses = [...new Set(trees.map((t) => t.campaign_address))];
  const [campaigns, settled, nowSec] = await Promise.all([
    addresses.length === 0
      ? Promise.resolve([])
      : db
          .from("campaigns")
          .select("address, title, status, time_unit_seconds, per_tree_incentive::text")
          .in("address", addresses)
          .then((result) => unwrap(result, "load campaigns")),
    settledMilestones(trees.map((t) => t.tree_id)),
    getChainNow(),
  ]);
  const byAddress = new Map(campaigns.map((c) => [c.address, c]));

  return json({
    chainTime: new Date(nowSec * 1000).toISOString(),
    trees: trees.map((tree) => {
      const campaign = byAddress.get(tree.campaign_address);
      const milestones = campaign
        ? milestoneSchedule(
            tree,
            Number(campaign.time_unit_seconds),
            campaign.per_tree_incentive,
            settled.get(tree.tree_id) ?? { paid: new Set(), forfeited: new Set() },
            nowSec,
          )
        : [];
      // Flagged, dead, removed and completed trees have nothing to check in for.
      const active = tree.status === "alive";
      return {
        treeId: tree.tree_id,
        campaign: {
          address: tree.campaign_address,
          title: campaign?.title ?? null,
          status: campaign?.status ?? null,
        },
        slotId: tree.slot_id,
        status: tree.status,
        plantedAt: tree.planted_at,
        location: treeLocation(tree, true),
        replantDeadline: tree.replant_deadline,
        checkInCount: tree.check_in_count,
        nextMilestone: active
          ? (milestones.find((m) => m.state === "open" || m.state === "upcoming") ?? null)
          : null,
        milestones,
      };
    }),
  });
});
