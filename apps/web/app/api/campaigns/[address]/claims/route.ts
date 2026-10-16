import { claimSlotsRequestSchema } from "@treecord/shared";
import { requireRole, requireWallet } from "@/lib/server/auth";
import { loadCampaign, openSlotsHeldBy, pendingJobSlots, slotUsage } from "@/lib/server/campaigns";
import { conflict, json, route } from "@/lib/server/errors";
import { parseAddress, readIdempotencyKey, readJson } from "@/lib/server/http";
import { enqueueRelayerJob, findJobForIdempotencyKey, jobView } from "@/lib/server/jobs";

/**
 * POST /api/campaigns/:address/claims: a planter claims N open slots. Planters never pay gas: the API checks
 * availability and the per-planter cap against the mirror plus claims still queued, then enqueues a `claim`
 * job that the worker sends as `claimSlotsFor` with the operator wallet. The contract enforces the same
 * rules, so a race between two requests can only make the later job fail, never over-assign.
 *
 * Idempotency-Key: repeating a request with the same key returns the original job (200) instead of a new one.
 */
export const POST = route(async (request, { params }: { params: Promise<{ address: string }> }) => {
  const auth = await requireRole(request, "planter");
  const planter = requireWallet(auth);
  const address = parseAddress((await params).address);
  const idempotencyKey = readIdempotencyKey(request);
  const { count } = await readJson(request, claimSlotsRequestSchema);

  const previous = await findJobForIdempotencyKey(idempotencyKey, "claim", auth.profile.id);
  if (previous) return json({ job: jobView(previous, false), idempotent: true });

  const campaign = await loadCampaign(address);
  if (campaign.status !== "active") {
    throw conflict(
      "campaign_not_active",
      "Slots can only be claimed while the campaign is active",
      {
        status: campaign.status,
      },
    );
  }
  if (new Date(campaign.claim_deadline).getTime() <= Date.now()) {
    throw conflict("claim_window_closed", "The claim deadline has passed", {
      claimDeadline: campaign.claim_deadline,
    });
  }

  const [usage, pending, held] = await Promise.all([
    slotUsage(address),
    pendingJobSlots("claim", address, planter),
    openSlotsHeldBy(address, planter),
  ]);

  const available = Math.max(0, campaign.open_slots - usage.openTaken - pending.total);
  if (count > available) {
    throw conflict("not_enough_slots", `Only ${available} open slots are available`, { available });
  }
  const capRemaining = Math.max(0, campaign.per_planter_cap - held - pending.forPlanter);
  if (count > capRemaining) {
    throw conflict(
      "planter_cap_exceeded",
      `You can claim at most ${capRemaining} more slots in this campaign`,
      {
        remaining: capRemaining,
        cap: campaign.per_planter_cap,
      },
    );
  }

  const { job, created } = await enqueueRelayerJob(
    "claim",
    { campaign: address, planter, count },
    { idempotencyKey, profileId: auth.profile.id },
  );
  return json({ job: jobView(job, false), idempotent: !created }, { status: created ? 202 : 200 });
});
