import { campaignMetadataRequestSchema } from "@treecord/shared";
import { requireRole } from "@/lib/server/auth";
import { getServerEnv } from "@/lib/server/env";
import { badRequest, json, route } from "@/lib/server/errors";
import { readJson } from "@/lib/server/http";
import { getSupabase, PG, unwrap } from "@/lib/server/supabase";

/**
 * POST /api/campaigns/metadata: store off-chain campaign metadata before calling CampaignFactory.
 * Returns the metadataURI to pass in the campaign config. The indexer links the on-chain campaign back to
 * this row through that URI.
 */
export const POST = route(async (request) => {
  const { profile } = await requireRole(request, "donor", "operator");
  const body = await readJson(request, campaignMetadataRequestSchema);

  const inserted = await getSupabase()
    .from("campaign_metadata")
    .insert({
      creator_profile_id: profile.id,
      title: body.title,
      description: body.description,
      species_code: body.speciesCode,
      region_name: body.regionName,
      region_center_lat: body.regionCenter.lat,
      region_center_lon: body.regionCenter.lon,
      region_radius_m: body.regionRadiusM,
      image_urls: body.imageUrls,
    })
    .select("id")
    .single();
  if (inserted.error?.code === PG.foreignKeyViolation) {
    throw badRequest("unknown_species", `Unknown species code ${body.speciesCode}`);
  }
  const { id } = unwrap(inserted, "store campaign metadata");
  const metadataURI = `${getServerEnv().PUBLIC_APP_URL.replace(/\/$/, "")}/api/campaigns/metadata/${id}`;
  return json({ id, metadataURI }, { status: 201 });
});
