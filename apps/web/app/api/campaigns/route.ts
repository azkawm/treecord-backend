import { campaignListQuerySchema } from "@treecord/shared";
import { CAMPAIGN_COLUMNS, campaignView, type CampaignRow } from "@/lib/server/campaigns";
import { badRequest, json, route } from "@/lib/server/errors";
import { readQuery } from "@/lib/server/http";
import { getSupabase, unwrap } from "@/lib/server/supabase";

/**
 * GET /api/campaigns: public list from the database mirror, newest first.
 * Filters: status, species (code), region (case-insensitive substring of the region name).
 * Pagination: pass the returned nextCursor as `cursor`.
 */
export const GET = route(async (request) => {
  const query = readQuery(request, campaignListQuerySchema);
  const offset = query.cursor === undefined ? 0 : parseCursor(query.cursor);

  let select = getSupabase()
    .from("campaigns")
    .select(CAMPAIGN_COLUMNS)
    .order("created_at", { ascending: false })
    .order("address", { ascending: false })
    // Fetch one extra row to know whether another page exists.
    .range(offset, offset + query.limit);
  if (query.status) select = select.eq("status", query.status);
  if (query.species) select = select.eq("species_code", query.species);
  if (query.region) select = select.ilike("region_name", `%${escapeLike(query.region)}%`);

  const rows = unwrap(await select, "list campaigns") as unknown as CampaignRow[];
  const hasMore = rows.length > query.limit;
  return json({
    items: rows.slice(0, query.limit).map(campaignView),
    nextCursor: hasMore ? String(offset + query.limit) : null,
  });
});

function parseCursor(cursor: string): number {
  if (!/^\d{1,9}$/.test(cursor))
    throw badRequest("invalid_cursor", "cursor must come from a previous response");
  return Number(cursor);
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}
