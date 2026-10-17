import { authenticateOptional } from "@/lib/server/auth";
import { getChainNow, txUrl } from "@/lib/server/chain";
import { json, route } from "@/lib/server/errors";
import { getSupabase, unwrap, unwrapMaybe } from "@/lib/server/supabase";
import {
  canSeeExactLocation,
  loadTree,
  milestoneSchedule,
  parseTreeId,
  settledMilestones,
  signedKeyframeUrls,
  treeLocation,
} from "@/lib/server/trees";

/**
 * GET /api/trees/:treeId: public tree page. Timeline of on-chain events with keyframe thumbnails for
 * evidence, milestone schedule and payouts with transaction links, and flags. Exact GPS only for the
 * planter, operators and auditors. Everyone else gets the center of the precision-7 geohash cell.
 */
export const GET = route(async (request, { params }: { params: Promise<{ treeId: string }> }) => {
  const auth = await authenticateOptional(request);
  const treeId = parseTreeId((await params).treeId);
  const tree = await loadTree(treeId);
  const db = getSupabase();

  const [campaign, events, payouts, forfeits, flags, settled, nowSec] = await Promise.all([
    db
      .from("campaigns")
      .select(
        "address, title, species_code, species_name, region_name, time_unit_seconds, per_tree_incentive::text",
      )
      .eq("address", tree.campaign_address)
      .maybeSingle(),
    db
      .from("tree_events")
      .select("kind, evidence_hash, data, block_number, block_time, tx_hash, log_index")
      .eq("tree_id", treeId)
      .order("block_number", { ascending: true })
      .order("log_index", { ascending: true }),
    db
      .from("milestone_payouts")
      .select("milestone, amount::text, planter_address, block_time, tx_hash")
      .eq("tree_id", treeId)
      .order("milestone"),
    db
      .from("milestone_forfeits")
      .select("milestone, amount::text, block_time, tx_hash")
      .eq("tree_id", treeId)
      .order("milestone"),
    db
      .from("flags")
      .select(
        "id, status, reason_text, reason_hash, resolution_note, opened_at, opened_tx, resolved_at, resolved_tx, created_at",
      )
      .eq("tree_id", treeId)
      .neq("status", "pending")
      .order("created_at"),
    settledMilestones([treeId]),
    getChainNow(),
  ]);
  const campaignRow = unwrapMaybe(campaign, "load tree campaign");
  const eventRows = unwrap(events, "load tree events");

  // Keyframe thumbnails: the first keyframe of the submission behind each evidence hash.
  const hashes = [...new Set(eventRows.flatMap((e) => (e.evidence_hash ? [e.evidence_hash] : [])))];
  const submissions =
    hashes.length === 0
      ? []
      : unwrap(
          await db
            .from("submissions")
            .select("evidence_hash, kind, milestone, keyframe_paths, policy_score")
            .in("evidence_hash", hashes),
          "load evidence for timeline",
        );
  const byHash = new Map(submissions.map((s) => [s.evidence_hash, s]));
  const thumbnails = await signedKeyframeUrls(
    submissions.flatMap((s) => (s.keyframe_paths[0] ? [s.keyframe_paths[0]] : [])),
  );

  const exact = canSeeExactLocation(auth, tree);
  return json({
    tree: {
      treeId: tree.tree_id,
      campaign: campaignRow
        ? {
            address: campaignRow.address,
            title: campaignRow.title,
            species: { code: campaignRow.species_code, name: campaignRow.species_name },
            region: campaignRow.region_name,
          }
        : { address: tree.campaign_address },
      slotId: tree.slot_id,
      planter: tree.planter_address,
      status: tree.status,
      plantedAt: tree.planted_at,
      location: treeLocation(tree, exact),
      replantDeadline: tree.replant_deadline,
      pausedSeconds: Number(tree.paused_seconds),
      checkInCount: tree.check_in_count,
      latestEvidenceHash: tree.latest_evidence_hash,
      plantedTx: { hash: tree.planted_tx, url: txUrl(tree.planted_tx) },
    },
    timeline: eventRows.map((e) => {
      const evidence = e.evidence_hash ? byHash.get(e.evidence_hash) : undefined;
      const thumbnail = evidence?.keyframe_paths[0];
      return {
        type: e.kind,
        at: e.block_time,
        blockNumber: e.block_number,
        tx: { hash: e.tx_hash, url: txUrl(e.tx_hash) },
        evidenceHash: e.evidence_hash,
        data: e.data,
        evidence: evidence
          ? {
              kind: evidence.kind,
              milestone: evidence.milestone,
              score: evidence.policy_score,
              thumbnailUrl: thumbnail ? (thumbnails.get(thumbnail) ?? null) : null,
            }
          : null,
      };
    }),
    milestones: campaignRow
      ? milestoneSchedule(
          tree,
          Number(campaignRow.time_unit_seconds),
          campaignRow.per_tree_incentive,
          settled.get(treeId) ?? { paid: new Set(), forfeited: new Set() },
          nowSec,
        )
      : [],
    payouts: unwrap(payouts, "load payouts").map((p) => ({
      milestone: p.milestone,
      amount: p.amount,
      planter: p.planter_address,
      at: p.block_time,
      tx: { hash: p.tx_hash, url: txUrl(p.tx_hash) },
    })),
    forfeits: unwrap(forfeits, "load forfeits").map((f) => ({
      milestone: f.milestone,
      amount: f.amount,
      at: f.block_time,
      tx: { hash: f.tx_hash, url: txUrl(f.tx_hash) },
    })),
    flags: unwrap(flags, "load flags").map((f) => ({
      id: f.id,
      status: f.status,
      reasonText: f.reason_text,
      reasonHash: f.reason_hash,
      resolutionNote: f.status === "open" ? null : f.resolution_note,
      openedAt: f.opened_at,
      openedTx: f.opened_tx,
      resolvedAt: f.resolved_at,
      resolvedTx: f.resolved_tx,
    })),
  });
});
