import { BPS, unitsToTonnes } from "@treecord/shared";
import { requireRole, requireWallet } from "@/lib/server/auth";
import { CAMPAIGN_COLUMNS, type CampaignRow } from "@/lib/server/campaigns";
import { json, route } from "@/lib/server/errors";
import { getSupabase, unwrap } from "@/lib/server/supabase";
import { treeStats } from "@/lib/server/trees";

const sum = (rows: { amount: string }[]) => rows.reduce((total, r) => total + BigInt(r.amount), 0n);

/**
 * GET /api/donor/dashboard: every campaign the caller's wallet contributed to, with their funding share,
 * tree health and survival rate, incentives released to planters, their carbon (pre-certification
 * reservation and issued credits, labeled separately) and flags still open.
 */
export const GET = route(async (request) => {
  const auth = await requireRole(request, "donor", "operator");
  const wallet = requireWallet(auth);
  const db = getSupabase();

  const [contributions, refunds] = await Promise.all([
    db
      .from("contributions")
      .select("campaign_address, amount::text")
      .eq("contributor_address", wallet),
    db.from("refunds").select("campaign_address, amount::text").eq("contributor_address", wallet),
  ]);
  const contributed = unwrap(contributions, "load contributions");
  const addresses = [...new Set(contributed.map((c) => c.campaign_address))];
  if (addresses.length === 0) return json({ wallet, campaigns: [], totals: totalsOf([]) });

  const [campaigns, trees, payouts, reservations, batches, balances, flags] = await Promise.all([
    db.from("campaigns").select(CAMPAIGN_COLUMNS).in("address", addresses),
    db.from("trees").select("campaign_address, status").in("campaign_address", addresses),
    db
      .from("milestone_payouts")
      .select("campaign_address, amount::text")
      .in("campaign_address", addresses),
    db
      .from("carbon_reservations")
      .select("campaign_address, reserved_amount::text, allocated_amount::text, declined")
      .eq("holder_address", wallet)
      .in("campaign_address", addresses),
    db
      .from("carbon_batches")
      .select("batch_id, campaign_address")
      .in("campaign_address", addresses),
    db.from("carbon_balances").select("batch_id, amount::text").eq("holder_address", wallet),
    db
      .from("flags")
      .select("id, tree_id, campaign_address, status, reason_text, created_at, opened_at")
      .in("campaign_address", addresses)
      .in("status", ["pending", "open"])
      .order("created_at"),
  ]);
  const refundRows = unwrap(refunds, "load refunds");
  const treeRows = unwrap(trees, "load trees");
  const payoutRows = unwrap(payouts, "load payouts");
  const reservationRows = unwrap(reservations, "load reservations");
  const batchCampaign = new Map(
    unwrap(batches, "load batches").map((b) => [b.batch_id, b.campaign_address]),
  );
  const balanceRows = unwrap(balances, "load balances");
  const flagRows = unwrap(flags, "load flags");

  const views = (unwrap(campaigns, "load campaigns") as unknown as CampaignRow[]).map((c) => {
    const mine = sum(contributed.filter((x) => x.campaign_address === c.address));
    const raised = BigInt(c.funded_amount);
    const reservation = reservationRows.find((r) => r.campaign_address === c.address);
    const held = sum(balanceRows.filter((b) => batchCampaign.get(b.batch_id) === c.address));
    const reserved = BigInt(reservation?.reserved_amount ?? "0");
    const allocated = BigInt(reservation?.allocated_amount ?? "0");
    return {
      campaign: {
        address: c.address,
        title: c.title,
        status: c.status,
        species: { code: c.species_code, name: c.species_name },
        region: c.region_name,
        treeTarget: c.tree_target,
        fundingTarget: c.funding_target,
        raised: c.funded_amount,
      },
      contributed: mine.toString(),
      refunded: sum(refundRows.filter((r) => r.campaign_address === c.address)).toString(),
      fundingShareBps: raised === 0n ? 0 : Number((mine * BigInt(BPS)) / raised),
      trees: treeStats(
        treeRows.filter((t) => t.campaign_address === c.address).map((t) => t.status),
      ),
      payoutsReleased: sum(payoutRows.filter((p) => p.campaign_address === c.address)).toString(),
      carbon: {
        campaignEstimate: c.estimated_amount
          ? {
              label: "pre-certification" as const,
              units: c.estimated_amount,
              tonnes: unitsToTonnes(BigInt(c.estimated_amount)),
            }
          : null,
        reserved: {
          label: "pre-certification" as const,
          units: reserved.toString(),
          tonnes: unitsToTonnes(reserved),
          declined: reservation?.declined ?? false,
        },
        issued: {
          label: "issued" as const,
          allocatedUnits: allocated.toString(),
          heldUnits: held.toString(),
          heldTonnes: unitsToTonnes(held),
        },
      },
      openFlags: flagRows
        .filter((f) => f.campaign_address === c.address)
        .map((f) => ({
          id: f.id,
          treeId: f.tree_id,
          status: f.status,
          reasonText: f.reason_text,
          createdAt: f.created_at,
          openedAt: f.opened_at,
        })),
    };
  });

  return json({ wallet, campaigns: views, totals: totalsOf(views) });
});

function totalsOf(
  views: {
    contributed: string;
    trees: { planted: number; alive: number; flagged: number; completed: number };
    payoutsReleased: string;
    openFlags: unknown[];
  }[],
) {
  const planted = views.reduce((n, v) => n + v.trees.planted, 0);
  const surviving = views.reduce(
    (n, v) => n + v.trees.alive + v.trees.flagged + v.trees.completed,
    0,
  );
  return {
    campaigns: views.length,
    contributed: views.reduce((s, v) => s + BigInt(v.contributed), 0n).toString(),
    treesPlanted: planted,
    survivalRateBps: planted === 0 ? null : Math.floor((surviving * 10_000) / planted),
    payoutsReleased: views.reduce((s, v) => s + BigInt(v.payoutsReleased), 0n).toString(),
    openFlags: views.reduce((n, v) => n + v.openFlags.length, 0),
  };
}
