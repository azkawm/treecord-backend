import { carbonEstimateRequestSchema, unitsToTonnes, type Json } from "@treecord/shared";
import { requireRole } from "@/lib/server/auth";
import { loadCampaign } from "@/lib/server/campaigns";
import { campaignEstimate } from "@/lib/server/carbon";
import { conflict, json, route } from "@/lib/server/errors";
import { readIdempotencyKey, readJson } from "@/lib/server/http";
import { enqueueRelayerJob, findJobForIdempotencyKey, jobView } from "@/lib/server/jobs";
import { check, getSupabase, unwrap } from "@/lib/server/supabase";

/**
 * POST /api/operator/carbon/estimate: computes the pre-certification estimate for a campaign from the
 * species table, stores it with its method, and enqueues an `estimate` job that calls
 * CarbonLedger.setEstimate (which sets every contributor's pro-rata reservation). Same rules as the
 * contract: the campaign must be active and no batch issued yet.
 */
export const POST = route(async (request) => {
  const auth = await requireRole(request, "operator");
  const idempotencyKey = readIdempotencyKey(request);
  const { campaign: address } = await readJson(request, carbonEstimateRequestSchema);

  const previous = await findJobForIdempotencyKey(idempotencyKey, "estimate", auth.profile.id);
  if (previous) return json({ job: jobView(previous, true), idempotent: true });

  const campaign = await loadCampaign(address);
  if (campaign.status !== "active") {
    throw conflict(
      "campaign_not_active",
      "Estimates can only be set while the campaign is active",
      {
        status: campaign.status,
      },
    );
  }
  const db = getSupabase();
  const issued = await db
    .from("carbon_batches")
    .select("batch_id", { count: "exact", head: true })
    .eq("campaign_address", address);
  check(issued, "count batches");
  if ((issued.count ?? 0) > 0) {
    throw conflict(
      "estimate_locked",
      "Credits were already issued for this campaign, so the estimate is locked",
    );
  }

  const estimate = await campaignEstimate(campaign);
  const method = {
    ...estimate.method,
    species: estimate.species,
    computedAt: new Date().toISOString(),
  };
  unwrap(
    await db
      .from("campaigns")
      .update({
        // uint256 column, written as a decimal string.
        estimated_amount: estimate.units.toString() as unknown as number,
        estimate_method: method as unknown as Json,
      })
      .eq("address", address)
      .select("address")
      .single(),
    "store estimate",
  );

  const { job, created } = await enqueueRelayerJob(
    "estimate",
    { campaign: address, estimatedAmount: estimate.units.toString() },
    { idempotencyKey, profileId: auth.profile.id },
  );
  return json(
    {
      estimate: {
        label: "pre-certification",
        units: estimate.units.toString(),
        tonnes: unitsToTonnes(estimate.units),
        method,
      },
      job: jobView(job, true),
      idempotent: !created,
    },
    { status: created ? 202 : 200 },
  );
});
