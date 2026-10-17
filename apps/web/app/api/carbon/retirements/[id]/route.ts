import { retirementIdSchema, unitsToTonnes } from "@treecord/shared";
import { txUrl } from "@/lib/server/chain";
import { badRequest, json, notFound, route } from "@/lib/server/errors";
import { getSupabase, unwrap, unwrapMaybe } from "@/lib/server/supabase";

/**
 * GET /api/carbon/retirements/:id: public retirement certificate. The burned amount, beneficiary and purpose,
 * the batch with its registry serial range and vintage, the campaign and its trees (public geohash only), the
 * on-chain transaction, and whether the matching registry retirement is done.
 */
export const GET = route(async (_request, { params }: { params: Promise<{ id: string }> }) => {
  const parsed = retirementIdSchema.safeParse((await params).id);
  if (!parsed.success) throw badRequest("invalid_path", "id must be a positive integer");
  const db = getSupabase();

  const retirement = unwrapMaybe(
    await db
      .from("retirements")
      .select(
        "retirement_id, batch_id, holder_address, amount::text, beneficiary, purpose, retired_at, tx_hash, registry_retirement_status, registry_reference",
      )
      .eq("retirement_id", Number(parsed.data))
      .maybeSingle(),
    "load retirement",
  );
  if (!retirement) throw notFound("Retirement");

  const batch = unwrap(
    await db
      .from("carbon_batches")
      .select(
        "batch_id, campaign_address, registry, serial_start, serial_end, vintage, amount::text, issued_tx",
      )
      .eq("batch_id", retirement.batch_id)
      .single(),
    "load batch",
  );
  const [campaign, trees] = await Promise.all([
    db
      .from("campaigns")
      .select(
        "address, title, species_code, species_name, region_name, region_geohash, tree_target",
      )
      .eq("address", batch.campaign_address)
      .maybeSingle(),
    db
      .from("trees")
      .select("tree_id, status, geohash, planted_at")
      .eq("campaign_address", batch.campaign_address)
      .order("tree_id"),
  ]);
  const c = unwrapMaybe(campaign, "load campaign");
  const treeRows = unwrap(trees, "load trees");

  return json({
    certificate: {
      retirementId: retirement.retirement_id,
      units: retirement.amount,
      tonnes: unitsToTonnes(BigInt(retirement.amount)),
      beneficiary: retirement.beneficiary,
      purpose: retirement.purpose,
      retiredAt: retirement.retired_at,
      holder: retirement.holder_address,
      tx: { hash: retirement.tx_hash, url: txUrl(retirement.tx_hash) },
      registryRetirement: {
        status: retirement.registry_retirement_status,
        reference: retirement.registry_reference,
      },
      batch: {
        batchId: batch.batch_id,
        registry: batch.registry,
        serialStart: batch.serial_start,
        serialEnd: batch.serial_end,
        vintage: batch.vintage,
        units: batch.amount,
        issuedTx: { hash: batch.issued_tx, url: txUrl(batch.issued_tx) },
      },
      campaign: c
        ? {
            address: c.address,
            title: c.title,
            species: { code: c.species_code, name: c.species_name },
            region: { name: c.region_name, geohash: c.region_geohash },
            treeTarget: c.tree_target,
          }
        : { address: batch.campaign_address },
      trees: {
        count: treeRows.length,
        list: treeRows.map((t) => ({
          treeId: t.tree_id,
          status: t.status,
          geohash: t.geohash,
          plantedAt: t.planted_at,
        })),
      },
    },
  });
});
