import { requireRole, requireWallet } from "@/lib/server/auth";
import { json, route } from "@/lib/server/errors";
import { getSupabase, unwrap } from "@/lib/server/supabase";

/**
 * GET /api/planter/slots: the caller's claimed or assigned slots that have no tree yet, so the app knows
 * which slot id to put in a PLANTED payload. Planted slots appear in GET /api/planter/trees instead.
 */
export const GET = route(async (request) => {
  const auth = await requireRole(request, "planter");
  const wallet = requireWallet(auth);
  const db = getSupabase();

  const slots = unwrap(
    await db
      .from("slots")
      .select("campaign_address, slot_id, kind, claimed_at, claimed_tx")
      .eq("planter_address", wallet)
      .eq("status", "claimed")
      .order("campaign_address")
      .order("slot_id"),
    "load planter slots",
  );
  const addresses = [...new Set(slots.map((s) => s.campaign_address))];
  const campaigns =
    addresses.length === 0
      ? []
      : unwrap(
          await db
            .from("campaigns")
            .select("address, title, status, region_name, region_geohash, region_radius_m")
            .in("address", addresses),
          "load campaigns",
        );
  const byAddress = new Map(campaigns.map((c) => [c.address, c]));

  return json({
    slots: slots.map((slot) => {
      const campaign = byAddress.get(slot.campaign_address);
      return {
        campaign: {
          address: slot.campaign_address,
          title: campaign?.title ?? null,
          status: campaign?.status ?? null,
          regionName: campaign?.region_name ?? null,
          regionGeohash: campaign?.region_geohash ?? null,
          regionRadiusM: campaign?.region_radius_m ?? null,
        },
        slotId: slot.slot_id,
        kind: slot.kind,
        claimedAt: slot.claimed_at,
        claimedTx: slot.claimed_tx,
      };
    }),
  });
});
