import "server-only";
import {
  attestationJobKey,
  loadSubmission,
  scoreJobKey,
  type SubmissionRow,
} from "@treecord/pipeline";
import type { AiScoreResponse, EvidenceKind, EvidencePayload, LatLon } from "@treecord/shared";
import { loadCampaign, type CampaignRow } from "./campaigns";
import { getChainNow } from "./chain";
import { ApiError, notFound } from "./errors";
import {
  ACCEPTED_STATUSES,
  checkCampaignActive,
  checkMilestoneNotDone,
  checkMilestoneOpen,
  checkSlotOwnership,
  checkTreeOwnership,
  checkTreeStatus,
  checkVideoDuration,
  collectReasons,
  type MilestoneHistory,
  type PrecheckReason,
  type SlotFacts,
  type TreeFacts,
  type UploadTarget,
} from "./precheck";
import { check, getSupabase, unwrap, unwrapMaybe } from "./supabase";

export type { SubmissionRow };

/** Everything the target-level prechecks need, loaded from the mirror. */
export interface TargetFacts {
  campaign: CampaignRow;
  /** PLANTED only. */
  slot: SlotFacts | null;
  /** Non-PLANTED only. */
  tree: (TreeFacts & { location: LatLon | null }) | null;
  history: MilestoneHistory;
  activeChallenge: { id: string; code: string } | null;
  chainNowSec: number;
}

/**
 * Loads campaign, slot or tree, milestone history and any active challenge for an evidence target.
 * 404 when the campaign or tree does not exist (or the tree is in another campaign).
 * `excludeSubmissionId` leaves the submission being checked out of the duplicate-acceptance count.
 */
export async function loadTargetFacts(
  target: UploadTarget,
  excludeSubmissionId?: string,
): Promise<TargetFacts> {
  const db = getSupabase();
  const campaign = await loadCampaign(target.campaign);
  const chainNowSec = await getChainNow();
  const exclude = excludeSubmissionId ?? "00000000-0000-0000-0000-000000000000";

  if (target.kind === "PLANTED") {
    const slotId = target.slotId ?? 0;
    const [slot, tree, accepted] = await Promise.all([
      db
        .from("slots")
        .select("planter_address, status, tree_id")
        .eq("campaign_address", target.campaign)
        .eq("slot_id", slotId)
        .maybeSingle(),
      db
        .from("trees")
        .select("tree_id", { count: "exact", head: true })
        .eq("campaign_address", target.campaign)
        .eq("slot_id", slotId),
      db
        .from("submissions")
        .select("id", { count: "exact", head: true })
        .eq("kind", "PLANTED")
        .eq("campaign_address", target.campaign)
        .eq("slot_id", slotId)
        .in("status", [...ACCEPTED_STATUSES])
        .neq("id", exclude),
    ]);
    const slotRow = unwrapMaybe(slot, "load slot");
    check(tree, "count trees for slot");
    check(accepted, "count plantings");
    return {
      campaign,
      slot: slotRow ? { planter: slotRow.planter_address } : null,
      tree: null,
      history: {
        settledOnChain:
          (tree.count ?? 0) > 0 ||
          slotRow?.status === "planted" ||
          (slotRow?.tree_id ?? null) !== null,
        acceptedSubmission: (accepted.count ?? 0) > 0,
      },
      activeChallenge: null,
      chainNowSec,
    };
  }

  const treeId = target.treeId ?? 0;
  const treeRow = unwrapMaybe(
    await db
      .from("trees")
      .select(
        "tree_id, campaign_address, slot_id, planter_address, status, planted_at, paused_seconds, replant_deadline, exact_lat, exact_lon",
      )
      .eq("tree_id", treeId)
      .maybeSingle(),
    "load tree",
  );
  if (!treeRow || treeRow.campaign_address !== target.campaign) throw notFound("Tree");

  const [payout, accepted, challenge, location] = await Promise.all([
    db
      .from("milestone_payouts")
      .select("id", { count: "exact", head: true })
      .eq("tree_id", treeId)
      .eq("milestone", target.milestone),
    db
      .from("submissions")
      .select("id", { count: "exact", head: true })
      .eq("kind", "ALIVE")
      .eq("tree_id", treeId)
      .eq("milestone", target.milestone)
      .in("status", [...ACCEPTED_STATUSES])
      .neq("id", exclude),
    db
      .from("challenges")
      .select("id, code")
      .eq("tree_id", treeId)
      .is("fulfilled_submission_id", null)
      .gt("expires_at", new Date().toISOString())
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    treeLocation(treeRow),
  ]);
  check(payout, "count payouts");
  check(accepted, "count check-ins");

  return {
    campaign,
    slot: null,
    tree: {
      planter: treeRow.planter_address,
      status: treeRow.status,
      plantedAtSec: Math.floor(Date.parse(treeRow.planted_at) / 1000),
      pausedSeconds: Number(treeRow.paused_seconds),
      replantDeadlineSec: treeRow.replant_deadline
        ? Math.floor(Date.parse(treeRow.replant_deadline) / 1000)
        : null,
      location,
    },
    history: {
      settledOnChain: (payout.count ?? 0) > 0,
      acceptedSubmission: (accepted.count ?? 0) > 0,
    },
    activeChallenge: unwrapMaybe(challenge, "load challenge"),
    chainNowSec,
  };
}

/**
 * The tree's first exact location: the mirror's exact_lat/lon, set by the indexer from the planting
 * submission, or that planting submission's signed payload when the indexer has not linked it yet.
 */
async function treeLocation(tree: {
  campaign_address: string;
  slot_id: number;
  exact_lat: number | null;
  exact_lon: number | null;
}): Promise<LatLon | null> {
  if (tree.exact_lat !== null && tree.exact_lon !== null) {
    return { lat: tree.exact_lat, lon: tree.exact_lon };
  }
  const planting = unwrapMaybe(
    await getSupabase()
      .from("submissions")
      .select("payload")
      .eq("kind", "PLANTED")
      .eq("campaign_address", tree.campaign_address)
      .eq("slot_id", tree.slot_id)
      .in("status", ["attested", "onchain"])
      .limit(1)
      .maybeSingle(),
    "load planting location",
  );
  const payload = planting?.payload as EvidencePayload | null | undefined;
  return payload ? { lat: payload.lat, lon: payload.lon } : null;
}

/**
 * Target-level prechecks: campaign status, slot or tree ownership, tree status, milestone window and
 * history, and clip duration. Run at upload-url time (to fail before the upload) and again at submit.
 */
export function targetReasons(
  target: UploadTarget,
  facts: TargetFacts,
  wallet: string,
  durationSec: number | null,
): PrecheckReason[] {
  const kind: EvidenceKind = target.kind;
  return collectReasons([
    checkCampaignActive(kind, facts.campaign.status),
    kind === "PLANTED" ? checkSlotOwnership(facts.slot, wallet) : null,
    facts.tree ? checkTreeOwnership(facts.tree, wallet) : null,
    facts.tree ? checkTreeStatus(kind, facts.tree, facts.chainNowSec) : null,
    checkMilestoneOpen(
      kind,
      target.milestone,
      facts.tree,
      Number(facts.campaign.time_unit_seconds),
      facts.chainNowSec,
    ),
    checkMilestoneNotDone(kind, facts.history),
    checkVideoDuration(durationSec),
  ]);
}

/** 422 for failed prechecks before a submission exists. */
export function precheckFailed(reasons: PrecheckReason[]): ApiError {
  return new ApiError(422, "precheck_failed", "Evidence failed prechecks", { reasons });
}

export function targetOf(row: SubmissionRow): UploadTarget {
  return {
    kind: row.kind,
    campaign: row.campaign_address,
    slotId: row.slot_id,
    treeId: row.tree_id,
    milestone: row.milestone,
  };
}

export async function mustLoadSubmission(id: string): Promise<SubmissionRow> {
  const row = await loadSubmission(getSupabase(), id);
  if (!row) throw notFound("Submission");
  return row;
}

/** The most recent score or attestation job for a submission. */
export async function latestJobId(submissionId: string): Promise<string | null> {
  const rows = unwrap(
    await getSupabase()
      .from("relayer_jobs")
      .select("id")
      .in("idempotency_key", [scoreJobKey(submissionId), attestationJobKey(submissionId)])
      .order("created_at", { ascending: false })
      .limit(1),
    "load submission job",
  );
  return rows.at(0)?.id ?? null;
}

/** Public shape of a submission. Exact GPS is not included. */
export function submissionView(row: SubmissionRow, jobId: string | null) {
  const ai = row.ai_response as AiScoreResponse | null;
  const attestation = row.attestation as {
    attestation: { nonce: string; expiry: string; score: number };
    digest: string;
  } | null;
  return {
    id: row.id,
    kind: row.kind,
    campaign: row.campaign_address,
    slotId: row.slot_id,
    treeId: row.tree_id,
    milestone: row.milestone,
    status: row.status,
    reasons: row.reject_reasons,
    policyDecision: row.policy_decision,
    policyScore: row.policy_score,
    scores: ai?.scores ?? null,
    modelVersion: ai?.modelVersion ?? null,
    evidenceHash: row.evidence_hash,
    attestation: attestation
      ? {
          nonce: attestation.attestation.nonce,
          expiry: attestation.attestation.expiry,
          digest: attestation.digest,
        }
      : null,
    txHash: row.tx_hash,
    jobId,
    review: row.reviewed_at ? { note: row.review_note, reviewedAt: row.reviewed_at } : null,
    capturedAt: row.captured_at,
    receivedAt: row.received_at,
    updatedAt: row.updated_at,
  };
}
