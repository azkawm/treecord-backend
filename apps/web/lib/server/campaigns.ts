import "server-only";
import { BPS, CARBON_UNITS_PER_TONNE } from "@treecord/shared";
import { notFound } from "./errors";
import { OPEN_JOB_STATUSES, type RelayerJobKind } from "./jobs";
import { check, getSupabase, unwrap, unwrapMaybe } from "./supabase";

/** Campaign columns with every uint256 cast to text so bigint precision survives PostgREST. */
export const CAMPAIGN_COLUMNS =
  "address, chain_id, creator_address, status, title, description, species_code, species_name, region_name, " +
  "region_center_lat, region_center_lon, region_radius_m, region_geohash, tree_target, anchor_slots, open_slots, " +
  "per_planter_cap, funding_target::text, funded_amount::text, funding_deadline, claim_deadline, commitment_units, " +
  "time_unit_seconds, split, incentive_pool::text, reserve_amount::text, per_tree_incentive::text, " +
  "refund_pool::text, activated_at, completed_at, estimated_amount::text, metadata_uri, created_at";

export interface CampaignRow {
  address: string;
  chain_id: number;
  creator_address: string;
  status: "funding" | "active" | "refunding" | "completed";
  title: string | null;
  description: string | null;
  species_code: string | null;
  species_name: string | null;
  region_name: string | null;
  region_center_lat: number | null;
  region_center_lon: number | null;
  region_radius_m: number;
  region_geohash: string;
  tree_target: number;
  anchor_slots: number;
  open_slots: number;
  per_planter_cap: number;
  funding_target: string;
  funded_amount: string;
  funding_deadline: string;
  claim_deadline: string;
  commitment_units: number;
  time_unit_seconds: number;
  split: unknown;
  incentive_pool: string | null;
  reserve_amount: string | null;
  per_tree_incentive: string | null;
  refund_pool: string | null;
  activated_at: string | null;
  completed_at: string | null;
  estimated_amount: string | null;
  metadata_uri: string;
  created_at: string;
}

export async function loadCampaign(address: string): Promise<CampaignRow> {
  const row = unwrapMaybe(
    await getSupabase()
      .from("campaigns")
      .select(CAMPAIGN_COLUMNS)
      .eq("address", address)
      .maybeSingle(),
    "load campaign",
  ) as CampaignRow | null;
  if (!row) throw notFound("Campaign");
  return row;
}

/** Formats carbon units (3 decimals) as a tonnes decimal string, for example 12345 -> "12.345". */
export function carbonUnitsToTonnes(units: string): string {
  const value = BigInt(units);
  const whole = value / BigInt(CARBON_UNITS_PER_TONNE);
  const fraction = (value % BigInt(CARBON_UNITS_PER_TONNE)).toString().padStart(3, "0");
  return `${whole}.${fraction}`;
}

/** Public shape of a campaign. Money is decimal strings of USDC base units. */
export function campaignView(row: CampaignRow) {
  const target = BigInt(row.funding_target);
  const raised = BigInt(row.funded_amount);
  return {
    address: row.address,
    chainId: row.chain_id,
    creator: row.creator_address,
    status: row.status,
    title: row.title,
    description: row.description,
    species: { code: row.species_code, name: row.species_name },
    region: {
      name: row.region_name,
      center:
        row.region_center_lat === null || row.region_center_lon === null
          ? null
          : { lat: row.region_center_lat, lon: row.region_center_lon },
      radiusM: row.region_radius_m,
      geohash: row.region_geohash,
    },
    treeTarget: row.tree_target,
    anchorSlots: row.anchor_slots,
    openSlots: row.open_slots,
    perPlanterCap: row.per_planter_cap,
    funding: {
      target: row.funding_target,
      raised: row.funded_amount,
      progressBps: target === 0n ? 0 : Number((raised * BigInt(BPS)) / target),
      deadline: row.funding_deadline,
    },
    claimDeadline: row.claim_deadline,
    commitmentUnits: row.commitment_units,
    timeUnitSeconds: row.time_unit_seconds,
    split: row.split,
    incentivePool: row.incentive_pool,
    perTreeIncentive: row.per_tree_incentive,
    activatedAt: row.activated_at,
    completedAt: row.completed_at,
    carbon: row.estimated_amount
      ? {
          label: "pre-certification" as const,
          estimatedUnits: row.estimated_amount,
          estimatedTonnes: carbonUnitsToTonnes(row.estimated_amount),
        }
      : null,
    metadataUri: row.metadata_uri,
    createdAt: row.created_at,
  };
}

export interface SlotUsage {
  /** Open-range slots handed out (planter claims plus rolled-over assignments). */
  openTaken: number;
  /** Anchor-range slots handed out. */
  anchorTaken: number;
  planted: number;
}

/** Slot usage from the mirror. */
export async function slotUsage(address: string): Promise<SlotUsage> {
  const db = getSupabase();
  const [open, anchor, planted] = await Promise.all([
    db
      .from("slots")
      .select("slot_id", { count: "exact", head: true })
      .eq("campaign_address", address)
      .eq("kind", "open")
      .not("planter_address", "is", null),
    db
      .from("slots")
      .select("slot_id", { count: "exact", head: true })
      .eq("campaign_address", address)
      .eq("kind", "anchor")
      .not("planter_address", "is", null),
    db
      .from("trees")
      .select("tree_id", { count: "exact", head: true })
      .eq("campaign_address", address),
  ]);
  for (const result of [open, anchor, planted]) check(result, "count slots");
  return {
    openTaken: open.count ?? 0,
    anchorTaken: anchor.count ?? 0,
    planted: planted.count ?? 0,
  };
}

/** Slots reserved by queued jobs that have not reached the chain yet, in total and for one planter. */
export async function pendingJobSlots(
  kind: Extract<RelayerJobKind, "claim" | "anchor_assign">,
  campaign: string,
  planter?: string,
): Promise<{ total: number; forPlanter: number }> {
  const rows = unwrap(
    await getSupabase()
      .from("relayer_jobs")
      .select("payload")
      .eq("kind", kind)
      .in("status", [...OPEN_JOB_STATUSES])
      .eq("payload->>campaign", campaign),
    "load pending jobs",
  );
  let total = 0;
  let forPlanter = 0;
  for (const { payload } of rows) {
    const p = payload as { count?: number; planter?: string };
    const count = Number(p.count ?? 0);
    total += count;
    if (planter && p.planter === planter) forPlanter += count;
  }
  return { total, forPlanter };
}

/** Open slots a planter currently holds in a campaign (counts toward the per-planter cap). */
export async function openSlotsHeldBy(campaign: string, planter: string): Promise<number> {
  const result = await getSupabase()
    .from("slots")
    .select("slot_id", { count: "exact", head: true })
    .eq("campaign_address", campaign)
    .eq("kind", "open")
    .eq("planter_address", planter);
  check(result, "count planter slots");
  return result.count ?? 0;
}
