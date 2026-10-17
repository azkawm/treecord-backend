import { MILESTONE_COUNT, unitsToTonnes } from "@treecord/shared";
import { campaignView, loadCampaign } from "@/lib/server/campaigns";
import { getChainNow, txUrl } from "@/lib/server/chain";
import { json, route } from "@/lib/server/errors";
import { parseAddress } from "@/lib/server/http";
import { getSupabase, unwrap, unwrapMaybe } from "@/lib/server/supabase";
import { treeStats } from "@/lib/server/trees";

/**
 * GET /api/reports/campaign/:address: public impact report as JSON (a PDF rendering comes later). Trees and
 * survival, incentives paid per milestone, the pre-certification carbon estimate with the method behind it,
 * issued credits, and every evidence hash recorded on-chain so anyone can check them against the chain.
 */
export const GET = route(async (_request, { params }: { params: Promise<{ address: string }> }) => {
  const address = parseAddress((await params).address);
  const campaign = await loadCampaign(address);
  const db = getSupabase();

  const [method, contributions, refunds, trees, payouts, forfeits, batches, retirements, nowSec] =
    await Promise.all([
      db.from("campaigns").select("estimate_method").eq("address", address).maybeSingle(),
      db.from("contributions").select("contributor_address").eq("campaign_address", address),
      db.from("refunds").select("amount::text").eq("campaign_address", address),
      db
        .from("trees")
        .select("tree_id, status, planted_at")
        .eq("campaign_address", address)
        .order("tree_id"),
      db
        .from("milestone_payouts")
        .select("milestone, amount::text")
        .eq("campaign_address", address),
      db.from("milestone_forfeits").select("amount::text").eq("campaign_address", address),
      db
        .from("carbon_batches")
        .select("batch_id, registry, serial_start, serial_end, vintage, amount::text, issued_tx")
        .eq("campaign_address", address)
        .order("batch_id"),
      db.from("retirements").select("batch_id, amount::text"),
      getChainNow(),
    ]);
  const treeRows = unwrap(trees, "load trees");
  const payoutRows = unwrap(payouts, "load payouts");
  const batchRows = unwrap(batches, "load batches");
  const batchIds = new Set(batchRows.map((b) => b.batch_id));
  const total = (rows: { amount: string }[]) => rows.reduce((s, r) => s + BigInt(r.amount), 0n);

  const treeIds = treeRows.map((t) => t.tree_id);
  const evidence =
    treeIds.length === 0
      ? []
      : unwrap(
          await db
            .from("tree_events")
            .select("tree_id, kind, evidence_hash, block_number, block_time, tx_hash")
            .in("tree_id", treeIds)
            .not("evidence_hash", "is", null)
            .order("block_number")
            .order("log_index"),
          "load evidence hashes",
        );

  const ages = treeRows.map((t) => nowSec - Math.floor(Date.parse(t.planted_at) / 1000));
  const issuedUnits = total(batchRows);
  const retiredUnits = total(
    unwrap(retirements, "load retirements").filter((r) => batchIds.has(r.batch_id)),
  );

  return json({
    report: {
      generatedAt: new Date(nowSec * 1000).toISOString(),
      campaign: campaignView(campaign),
      funding: {
        target: campaign.funding_target,
        raised: campaign.funded_amount,
        contributors: new Set(
          unwrap(contributions, "load contributors").map((c) => c.contributor_address),
        ).size,
        refunded: total(unwrap(refunds, "load refunds")).toString(),
      },
      trees: {
        ...treeStats(treeRows.map((t) => t.status)),
        averageAgeDays:
          ages.length === 0
            ? null
            : Math.floor(ages.reduce((a, b) => a + b, 0) / ages.length / 86_400),
      },
      incentives: {
        paid: total(payoutRows).toString(),
        forfeited: total(unwrap(forfeits, "load forfeits")).toString(),
        byMilestone: Array.from({ length: MILESTONE_COUNT }, (_, m) => {
          const rows = payoutRows.filter((p) => p.milestone === m);
          return { milestone: m, payouts: rows.length, amount: total(rows).toString() };
        }),
      },
      carbon: {
        estimate: campaign.estimated_amount
          ? {
              label: "pre-certification" as const,
              units: campaign.estimated_amount,
              tonnes: unitsToTonnes(BigInt(campaign.estimated_amount)),
              method: unwrapMaybe(method, "load estimate method")?.estimate_method ?? null,
            }
          : null,
        issued: {
          label: "issued" as const,
          units: issuedUnits.toString(),
          tonnes: unitsToTonnes(issuedUnits),
          retiredUnits: retiredUnits.toString(),
          batches: batchRows.map((b) => ({
            batchId: b.batch_id,
            registry: b.registry,
            serialStart: b.serial_start,
            serialEnd: b.serial_end,
            vintage: b.vintage,
            units: b.amount,
            tonnes: unitsToTonnes(BigInt(b.amount)),
            tx: { hash: b.issued_tx, url: txUrl(b.issued_tx) },
          })),
        },
      },
      evidence: evidence.map((e) => ({
        treeId: e.tree_id,
        event: e.kind,
        evidenceHash: e.evidence_hash,
        blockNumber: e.block_number,
        at: e.block_time,
        tx: { hash: e.tx_hash, url: txUrl(e.tx_hash) },
      })),
    },
  });
});
