import { anchorAssignRequestSchema } from "@treecord/shared";
import { requireRole } from "@/lib/server/auth";
import { loadCampaign, pendingJobSlots, slotUsage } from "@/lib/server/campaigns";
import { conflict, json, route } from "@/lib/server/errors";
import { parseAddress, readIdempotencyKey, readJson } from "@/lib/server/http";
import { enqueueRelayerJob, findJobForIdempotencyKey, jobView } from "@/lib/server/jobs";

/**
 * POST /api/operator/campaigns/:address/anchor-assign: an operator assigns anchor slots to a planter.
 * After the claim deadline, unclaimed open slots roll into the anchor portion and count as available.
 * The per-planter cap does not apply (anchor slots are planted by platform-managed crews).
 */
export const POST = route(async (request, { params }: { params: Promise<{ address: string }> }) => {
  const auth = await requireRole(request, "operator");
  const address = parseAddress((await params).address);
  const idempotencyKey = readIdempotencyKey(request);
  const { planter, count } = await readJson(request, anchorAssignRequestSchema);

  const previous = await findJobForIdempotencyKey(idempotencyKey, "anchor_assign", auth.profile.id);
  if (previous) return json({ job: jobView(previous, true), idempotent: true });

  const campaign = await loadCampaign(address);
  if (campaign.status !== "active") {
    throw conflict(
      "campaign_not_active",
      "Anchor slots can only be assigned while the campaign is active",
      {
        status: campaign.status,
      },
    );
  }

  const [usage, pendingAnchor, pendingClaims] = await Promise.all([
    slotUsage(address),
    pendingJobSlots("anchor_assign", address),
    pendingJobSlots("claim", address),
  ]);
  const claimWindowClosed = new Date(campaign.claim_deadline).getTime() <= Date.now();
  const rolledOver = claimWindowClosed
    ? Math.max(0, campaign.open_slots - usage.openTaken - pendingClaims.total)
    : 0;
  const available = Math.max(
    0,
    campaign.anchor_slots - usage.anchorTaken + rolledOver - pendingAnchor.total,
  );
  if (count > available) {
    throw conflict("not_enough_slots", `Only ${available} anchor slots are available`, {
      available,
    });
  }

  const { job, created } = await enqueueRelayerJob(
    "anchor_assign",
    { campaign: address, planter, count },
    { idempotencyKey, profileId: auth.profile.id },
  );
  return json({ job: jobView(job, true), idempotent: !created }, { status: created ? 202 : 200 });
});
