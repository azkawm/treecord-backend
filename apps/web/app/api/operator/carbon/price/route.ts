import { carbonPriceRequestSchema } from "@treecord/shared";
import { requireRole } from "@/lib/server/auth";
import { json, notFound, route } from "@/lib/server/errors";
import { readIdempotencyKey, readJson } from "@/lib/server/http";
import { enqueueRelayerJob, findJobForIdempotencyKey, jobView } from "@/lib/server/jobs";
import { getSupabase, unwrapMaybe } from "@/lib/server/supabase";

/**
 * POST /api/operator/carbon/price: sets the USDC price per tonne at which buyers purchase a batch's platform
 * inventory. Enqueues a `set_price` job that calls CarbonLedger.setPrice from the operator wallet. The
 * indexer mirrors PriceSet into carbon_batches.price_usdc_per_tonne.
 */
export const POST = route(async (request) => {
  const auth = await requireRole(request, "operator");
  const idempotencyKey = readIdempotencyKey(request);
  const body = await readJson(request, carbonPriceRequestSchema);

  const previous = await findJobForIdempotencyKey(idempotencyKey, "set_price", auth.profile.id);
  if (previous) return json({ job: jobView(previous, true), idempotent: true });

  const batch = unwrapMaybe(
    await getSupabase()
      .from("carbon_batches")
      .select("batch_id, price_usdc_per_tonne::text")
      .eq("batch_id", Number(body.batchId))
      .maybeSingle(),
    "load batch",
  );
  if (!batch) throw notFound("Batch");

  const { job, created } = await enqueueRelayerJob(
    "set_price",
    { batchId: body.batchId, usdcPerTonne: body.usdcPerTonne },
    { idempotencyKey, profileId: auth.profile.id },
  );
  return json(
    {
      price: {
        batchId: batch.batch_id,
        current: batch.price_usdc_per_tonne,
        requested: body.usdcPerTonne,
      },
      job: jobView(job, true),
      idempotent: !created,
    },
    { status: created ? 202 : 200 },
  );
});
