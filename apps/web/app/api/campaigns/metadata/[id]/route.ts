import { json, notFound, route } from "@/lib/server/errors";
import { parseUuid } from "@/lib/server/http";
import { getSupabase, unwrapMaybe } from "@/lib/server/supabase";

/** GET /api/campaigns/metadata/:id: public campaign metadata. This is what a campaign's metadataURI resolves to. */
export const GET = route(async (_request, { params }: { params: Promise<{ id: string }> }) => {
  const id = parseUuid((await params).id);
  const row = unwrapMaybe(
    await getSupabase()
      .from("campaign_metadata")
      .select(
        "id, title, description, species_code, region_name, region_center_lat, region_center_lon, region_radius_m, image_urls, created_at, species(scientific_name, local_name)",
      )
      .eq("id", id)
      .maybeSingle(),
    "load campaign metadata",
  );
  if (!row) throw notFound("Campaign metadata");
  return json({
    id: row.id,
    title: row.title,
    description: row.description,
    species: {
      code: row.species_code,
      scientificName: row.species?.scientific_name,
      localName: row.species?.local_name,
    },
    region: {
      name: row.region_name,
      center: { lat: row.region_center_lat, lon: row.region_center_lon },
      radiusM: row.region_radius_m,
    },
    imageUrls: row.image_urls,
    createdAt: row.created_at,
  });
});
