import { campaignView, loadCampaign, slotUsage } from "@/lib/server/campaigns";
import { json, route } from "@/lib/server/errors";
import { parseAddress } from "@/lib/server/http";

/**
 * GET /api/campaigns/:address: public campaign detail with slot counts and funding progress.
 * The carbon estimate, when set, is labeled pre-certification.
 */
export const GET = route(async (_request, { params }: { params: Promise<{ address: string }> }) => {
  const address = parseAddress((await params).address);
  const campaign = await loadCampaign(address);
  const usage = await slotUsage(address);

  const claimWindowOpen = new Date(campaign.claim_deadline).getTime() > Date.now();
  return json({
    campaign: {
      ...campaignView(campaign),
      slots: {
        total: campaign.tree_target,
        anchor: campaign.anchor_slots,
        open: campaign.open_slots,
        openClaimed: usage.openTaken,
        anchorAssigned: usage.anchorTaken,
        planted: usage.planted,
        openAvailable: claimWindowOpen ? Math.max(0, campaign.open_slots - usage.openTaken) : 0,
      },
    },
  });
});
