import "server-only";
import { KEYFRAMES_BUCKET, SIGNED_READ_URL_SECONDS } from "@treecord/pipeline";
import {
  decodeGeohash,
  milestoneAmount,
  MILESTONE_COUNT,
  MILESTONE_DUE_UNITS,
  MILESTONE_WINDOW_UNITS,
  treeIdSchema,
  type Tables,
} from "@treecord/shared";
import type { AuthContext } from "./auth";
import { badRequest, notFound } from "./errors";
import { getSupabase, unwrap, unwrapMaybe } from "./supabase";

export type TreeRow = Tables<"trees">;

/** Validates a tree id path segment. Tree ids fit in a JS number for the lifetime of the platform. */
export function parseTreeId(value: string): number {
  const result = treeIdSchema.safeParse(value);
  if (!result.success) throw badRequest("invalid_path", "treeId must be a positive integer");
  return Number(result.data);
}

export async function loadTree(treeId: number): Promise<TreeRow> {
  const row = unwrapMaybe(
    await getSupabase().from("trees").select("*").eq("tree_id", treeId).maybeSingle(),
    "load tree",
  );
  if (!row) throw notFound("Tree");
  return row;
}

/** Exact GPS is for the tree's planter, operators and auditors (PRODUCT_KNOWLEDGE.md section 9). */
export function canSeeExactLocation(
  auth: AuthContext | null,
  tree: Pick<TreeRow, "planter_address">,
) {
  if (!auth) return false;
  if (auth.profile.role === "operator" || auth.profile.role === "auditor") return true;
  return auth.wallet !== null && auth.wallet === tree.planter_address;
}

/** The exact location for privileged callers, otherwise the center of the public precision-7 geohash cell. */
export function treeLocation(
  tree: Pick<TreeRow, "geohash" | "exact_lat" | "exact_lon">,
  exact: boolean,
) {
  if (exact && tree.exact_lat !== null && tree.exact_lon !== null) {
    return {
      precision: "exact" as const,
      lat: tree.exact_lat,
      lon: tree.exact_lon,
      geohash: tree.geohash,
    };
  }
  const center = decodeGeohash(tree.geohash);
  return { precision: "geohash" as const, lat: center.lat, lon: center.lon, geohash: tree.geohash };
}

/** 15 minute signed URLs for keyframe paths. Paths that fail to sign are dropped. */
export async function signedKeyframeUrls(paths: string[]): Promise<Map<string, string>> {
  const urls = new Map<string, string>();
  if (paths.length === 0) return urls;
  const { data, error } = await getSupabase()
    .storage.from(KEYFRAMES_BUCKET)
    .createSignedUrls(paths, SIGNED_READ_URL_SECONDS);
  if (error) {
    console.warn("Could not sign keyframe URLs", error);
    return urls;
  }
  for (const item of data) if (item.path && item.signedUrl) urls.set(item.path, item.signedUrl);
  return urls;
}

export type MilestoneState = "paid" | "forfeited" | "upcoming" | "open" | "missed";

export interface MilestoneView {
  milestone: number;
  opensAt: string;
  closesAt: string;
  /** USDC base units. Null before the campaign is activated. */
  amount: string | null;
  state: MilestoneState;
}

/**
 * The six milestones of a tree with their windows (shifted by paused seconds, like Campaign._window), amount
 * and state at `nowSec`. `missed` means the window closed unpaid and the forfeit is not mirrored yet.
 */
export function milestoneSchedule(
  tree: Pick<TreeRow, "planted_at" | "paused_seconds">,
  timeUnitSeconds: number,
  perTreeIncentive: string | null,
  settled: { paid: Set<number>; forfeited: Set<number> },
  nowSec: number,
): MilestoneView[] {
  const base = Math.floor(Date.parse(tree.planted_at) / 1000) + Number(tree.paused_seconds);
  const iso = (sec: number) => new Date(sec * 1000).toISOString();
  return Array.from({ length: MILESTONE_COUNT }, (_, m) => {
    const opensAt = base + (MILESTONE_DUE_UNITS[m] ?? 0) * timeUnitSeconds;
    const closesAt = opensAt + MILESTONE_WINDOW_UNITS * timeUnitSeconds;
    let state: MilestoneState;
    if (settled.paid.has(m)) state = "paid";
    else if (settled.forfeited.has(m)) state = "forfeited";
    else if (nowSec < opensAt) state = "upcoming";
    else if (nowSec <= closesAt) state = "open";
    else state = "missed";
    return {
      milestone: m,
      opensAt: iso(opensAt),
      closesAt: iso(closesAt),
      amount:
        perTreeIncentive === null ? null : milestoneAmount(BigInt(perTreeIncentive), m).toString(),
      state,
    };
  });
}

/** Paid and forfeited milestones per tree, from the mirror. */
export async function settledMilestones(
  treeIds: number[],
): Promise<Map<number, { paid: Set<number>; forfeited: Set<number> }>> {
  const result = new Map<number, { paid: Set<number>; forfeited: Set<number> }>();
  for (const id of treeIds) result.set(id, { paid: new Set(), forfeited: new Set() });
  if (treeIds.length === 0) return result;
  const db = getSupabase();
  const [payouts, forfeits] = await Promise.all([
    db.from("milestone_payouts").select("tree_id, milestone").in("tree_id", treeIds),
    db.from("milestone_forfeits").select("tree_id, milestone").in("tree_id", treeIds),
  ]);
  for (const row of unwrap(payouts, "load payouts"))
    result.get(row.tree_id)?.paid.add(row.milestone);
  for (const row of unwrap(forfeits, "load forfeits"))
    result.get(row.tree_id)?.forfeited.add(row.milestone);
  return result;
}

/** Counts of trees by status and the survival rate: alive, flagged or completed over everything planted. */
export function treeStats(statuses: TreeRow["status"][]) {
  const counts = {
    planted: statuses.length,
    alive: 0,
    flagged: 0,
    dead: 0,
    removed: 0,
    completed: 0,
  };
  for (const status of statuses) counts[status] += 1;
  const surviving = counts.alive + counts.flagged + counts.completed;
  return {
    ...counts,
    survivalRateBps:
      counts.planted === 0 ? null : Math.floor((surviving * 10_000) / counts.planted),
  };
}
