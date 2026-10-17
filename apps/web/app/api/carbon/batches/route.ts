import { carbonBatchesQuerySchema, unitsToTonnes } from "@treecord/shared";
import { ledgerAddress } from "@/lib/server/carbon";
import { txUrl } from "@/lib/server/chain";
import { json, route } from "@/lib/server/errors";
import { readQuery } from "@/lib/server/http";
import { getSupabase, unwrap } from "@/lib/server/supabase";

/**
 * GET /api/carbon/batches: public list of issued batches with registry serials, vintage, amount, price, and
 * the platform inventory still for sale. Optional `?campaign=0x...`.
 */
export const GET = route(async (request) => {
  const { campaign } = readQuery(request, carbonBatchesQuerySchema);
  const db = getSupabase();
  let query = db
    .from("carbon_batches")
    .select(
      "batch_id, campaign_address, registry, serial_start, serial_end, vintage, amount::text, price_usdc_per_tonne::text, issued_tx, created_at",
    )
    .order("batch_id");
  if (campaign) query = query.eq("campaign_address", campaign);
  const batches = unwrap(await query, "load batches");
  if (batches.length === 0) return json({ batches: [] });

  const [campaigns, inventory] = await Promise.all([
    db
      .from("campaigns")
      .select("address, title, species_name, region_name")
      .in("address", [...new Set(batches.map((b) => b.campaign_address))]),
    db
      .from("carbon_balances")
      .select("batch_id, amount::text")
      .eq("holder_address", ledgerAddress())
      .in(
        "batch_id",
        batches.map((b) => b.batch_id),
      ),
  ]);
  const campaignByAddress = new Map(unwrap(campaigns, "load campaigns").map((c) => [c.address, c]));
  const inventoryByBatch = new Map(
    unwrap(inventory, "load inventory").map((i) => [i.batch_id, i.amount]),
  );

  return json({
    batches: batches.map((b) => {
      const c = campaignByAddress.get(b.campaign_address);
      const available = BigInt(inventoryByBatch.get(b.batch_id) ?? "0");
      return {
        batchId: b.batch_id,
        label: "issued" as const,
        campaign: {
          address: b.campaign_address,
          title: c?.title ?? null,
          species: c?.species_name ?? null,
          region: c?.region_name ?? null,
        },
        registry: b.registry,
        serialStart: b.serial_start,
        serialEnd: b.serial_end,
        vintage: b.vintage,
        units: b.amount,
        tonnes: unitsToTonnes(BigInt(b.amount)),
        priceUsdcPerTonne: b.price_usdc_per_tonne,
        inventory: { units: available.toString(), tonnes: unitsToTonnes(available) },
        issuedTx: { hash: b.issued_tx, url: txUrl(b.issued_tx) },
        issuedAt: b.created_at,
      };
    }),
  });
});
