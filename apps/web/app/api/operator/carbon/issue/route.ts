import { carbonIssueRequestSchema, tonnesToUnits, unitsToTonnes } from "@treecord/shared";
import { requireRole } from "@/lib/server/auth";
import { loadCampaign } from "@/lib/server/campaigns";
import { conflict, json, route } from "@/lib/server/errors";
import { readIdempotencyKey, readJson } from "@/lib/server/http";
import { enqueueRelayerJob, findJobForIdempotencyKey, jobView } from "@/lib/server/jobs";

/**
 * POST /api/operator/carbon/issue: mirrors a registry issuance (SRN PPI, Verra) on-chain. Enqueues an `issue`
 * job that calls CarbonLedger.issueBatch from the operator wallet (which holds ISSUER_ROLE in the MVP). The
 * ledger fills reservations pro rata and puts the rest in platform inventory. Send an Idempotency-Key: the
 * same issuance must not be mirrored twice.
 */
export const POST = route(async (request) => {
  const auth = await requireRole(request, "operator");
  const idempotencyKey = readIdempotencyKey(request);
  const body = await readJson(request, carbonIssueRequestSchema);

  const previous = await findJobForIdempotencyKey(idempotencyKey, "issue", auth.profile.id);
  if (previous) return json({ job: jobView(previous, true), idempotent: true });

  const campaign = await loadCampaign(body.campaign);
  if (campaign.status !== "active" && campaign.status !== "completed") {
    throw conflict(
      "campaign_not_issuable",
      "Credits can only be issued for an active or completed campaign",
      {
        status: campaign.status,
      },
    );
  }
  const units = tonnesToUnits(body.tonnes);
  const { job, created } = await enqueueRelayerJob(
    "issue",
    {
      campaign: body.campaign,
      registry: body.registry,
      serialStart: body.serialStart,
      serialEnd: body.serialEnd,
      vintage: body.vintage,
      amount: units.toString(),
    },
    { idempotencyKey, profileId: auth.profile.id },
  );
  return json(
    {
      issuance: { units: units.toString(), tonnes: unitsToTonnes(units) },
      job: jobView(job, true),
      idempotent: !created,
    },
    { status: created ? 202 : 200 },
  );
});
