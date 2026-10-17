import { unitsToTonnes } from "@treecord/shared";
import { authenticate, requireWallet } from "@/lib/server/auth";
import { txUrl } from "@/lib/server/chain";
import { json, route } from "@/lib/server/errors";
import { getSupabase, unwrap } from "@/lib/server/supabase";

/**
 * GET /api/carbon/holdings: the caller's carbon. Reservations are pre-certification claims from contributing
 * (unfilled until a registry issuance). Balances are issued credits held per batch. Retirements are permanent.
 * Planters have none: they receive incentives, never carbon.
 */
export const GET = route(async (request) => {
  const auth = await authenticate(request);
  const wallet = requireWallet(auth);
  const db = getSupabase();

  const [reservations, balances, retirements] = await Promise.all([
    db
      .from("carbon_reservations")
      .select(
        "campaign_address, reserved_amount::text, allocated_amount::text, declined, updated_at",
      )
      .eq("holder_address", wallet),
    db.from("carbon_balances").select("batch_id, amount::text").eq("holder_address", wallet),
    db
      .from("retirements")
      .select(
        "retirement_id, batch_id, amount::text, beneficiary, purpose, retired_at, tx_hash, registry_retirement_status",
      )
      .eq("holder_address", wallet)
      .order("retirement_id"),
  ]);
  const balanceRows = unwrap(balances, "load balances").filter((b) => BigInt(b.amount) > 0n);
  const batches =
    balanceRows.length === 0
      ? []
      : unwrap(
          await db
            .from("carbon_batches")
            .select("batch_id, campaign_address, registry, serial_start, serial_end, vintage")
            .in(
              "batch_id",
              balanceRows.map((b) => b.batch_id),
            ),
          "load batches",
        );
  const batchById = new Map(batches.map((b) => [b.batch_id, b]));

  return json({
    wallet,
    reservations: unwrap(reservations, "load reservations").map((r) => {
      const reserved = BigInt(r.reserved_amount);
      const allocated = BigInt(r.allocated_amount);
      return {
        campaign: r.campaign_address,
        label: "pre-certification" as const,
        reservedUnits: r.reserved_amount,
        allocatedUnits: r.allocated_amount,
        unfilledUnits: (reserved - allocated).toString(),
        unfilledTonnes: unitsToTonnes(reserved - allocated),
        declined: r.declined,
        updatedAt: r.updated_at,
      };
    }),
    balances: balanceRows.map((b) => {
      const batch = batchById.get(b.batch_id);
      return {
        batchId: b.batch_id,
        label: "issued" as const,
        campaign: batch?.campaign_address ?? null,
        registry: batch?.registry ?? null,
        serialStart: batch?.serial_start ?? null,
        serialEnd: batch?.serial_end ?? null,
        vintage: batch?.vintage ?? null,
        units: b.amount,
        tonnes: unitsToTonnes(BigInt(b.amount)),
      };
    }),
    retirements: unwrap(retirements, "load retirements").map((r) => ({
      retirementId: r.retirement_id,
      batchId: r.batch_id,
      units: r.amount,
      tonnes: unitsToTonnes(BigInt(r.amount)),
      beneficiary: r.beneficiary,
      purpose: r.purpose,
      retiredAt: r.retired_at,
      registryRetirementStatus: r.registry_retirement_status,
      tx: { hash: r.tx_hash, url: txUrl(r.tx_hash) },
    })),
  });
});
