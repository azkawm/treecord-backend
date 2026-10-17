// Evidence prechecks (PRODUCT_KNOWLEDGE.md sections 3 and 5, prompt 8). Pure functions: each takes the facts it
// needs and returns a reason code on failure or null on success. The API loads the facts, runs these, and
// rejects with every failing reason. Rules that mirror contract reverts let the backend fail early with a
// clear reason instead of a failed transaction later.
import {
  CHECK_IN_RADIUS_M,
  haversineMeters,
  MAX_FUTURE_CAPTURE_MS,
  MAX_GPS_ACCURACY_M,
  MILESTONE_DUE_UNITS,
  MILESTONE_WINDOW_UNITS,
  SERVER_VIDEO_MAX_SEC,
  SERVER_VIDEO_MIN_SEC,
  UPLOAD_WINDOW_MS,
  verifyDeviceSignature,
  type EcPublicJwk,
  type EvidenceKind,
  type LatLon,
} from "@treecord/shared";

export const PRECHECK_REASONS = [
  "device_unknown_or_revoked",
  "device_not_owned",
  "signature_invalid",
  "hash_mismatch",
  "stale_capture",
  "future_capture",
  "gps_inaccurate",
  "outside_region",
  "moved_tree",
  "duplicate_video",
  "milestone_not_open",
  "milestone_already_done",
  "slot_not_owned",
  "tree_not_owned",
  "challenge_missing",
  "video_too_long",
  "video_too_short",
  // Mirrors of contract reverts, checked early.
  "campaign_not_active",
  "wrong_tree_status",
  "replant_deadline_passed",
] as const;
export type PrecheckReason = (typeof PRECHECK_REASONS)[number];

/** Submission statuses that count as accepted evidence. */
export const ACCEPTED_STATUSES = ["passed", "attested", "onchain"] as const;

// ---------------------------------------------------------------------------
// Device and signature
// ---------------------------------------------------------------------------

export interface DeviceFacts {
  profileId: string;
  revokedAt: string | null;
}

/** The device named by the payload's deviceKey must exist, be active, and belong to the submitter. */
export function checkDevice(
  device: DeviceFacts | null,
  submitterProfileId: string,
): PrecheckReason | null {
  if (!device || device.revokedAt !== null) return "device_unknown_or_revoked";
  if (device.profileId !== submitterProfileId) return "device_not_owned";
  return null;
}

/** ECDSA P-256 signature over the canonical payload bytes. */
export async function checkSignature(
  publicKeyJwk: EcPublicJwk,
  canonical: Uint8Array,
  signature: string,
): Promise<PrecheckReason | null> {
  return (await verifyDeviceSignature(publicKeyJwk, canonical, signature))
    ? null
    : "signature_invalid";
}

/** The stored video's SHA-256, recomputed by the server, must equal the signed one. */
export function checkVideoHash(actualSha256: string, signedSha256: string): PrecheckReason | null {
  return actualSha256 === signedSha256 ? null : "hash_mismatch";
}

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

/** Capture must be at most 72 hours old and at most 5 minutes in the future. */
export function checkCaptureTime(capturedAt: string, nowMs: number): PrecheckReason | null {
  const captured = Date.parse(capturedAt);
  if (captured - nowMs > MAX_FUTURE_CAPTURE_MS) return "future_capture";
  if (nowMs - captured > UPLOAD_WINDOW_MS) return "stale_capture";
  return null;
}

/** GPS accuracy must be 30 m or better. */
export function checkGpsAccuracy(accuracyM: number): PrecheckReason | null {
  return accuracyM > MAX_GPS_ACCURACY_M ? "gps_inaccurate" : null;
}

/** Recorder duration, when known, must be 4 to 12 seconds (section 15, rule 10). */
export function checkVideoDuration(durationSec: number | null | undefined): PrecheckReason | null {
  if (durationSec === null || durationSec === undefined) return null;
  if (durationSec < SERVER_VIDEO_MIN_SEC) return "video_too_short";
  if (durationSec > SERVER_VIDEO_MAX_SEC) return "video_too_long";
  return null;
}

// ---------------------------------------------------------------------------
// Location
// ---------------------------------------------------------------------------

/** PLANTED: inside the campaign region. A campaign without a region center cannot be verified. */
export function checkInsideRegion(
  point: LatLon,
  center: LatLon | null,
  radiusM: number,
): PrecheckReason | null {
  if (!center) return "outside_region";
  return haversineMeters(point, center) <= radiusM ? null : "outside_region";
}

/** Later kinds: within 15 m of the tree's first exact location. A tree without one cannot be verified. */
export function checkNearTree(point: LatLon, treeLocation: LatLon | null): PrecheckReason | null {
  if (!treeLocation) return "moved_tree";
  return haversineMeters(point, treeLocation) <= CHECK_IN_RADIUS_M ? null : "moved_tree";
}

// ---------------------------------------------------------------------------
// Duplicates
// ---------------------------------------------------------------------------

export interface ExistingVideoFacts {
  profileId: string;
  status: string;
  kind: EvidenceKind;
  campaign: string;
  slotId: number | null;
  treeId: number | null;
  milestone: number;
}

export interface UploadTarget {
  kind: EvidenceKind;
  campaign: string;
  slotId: number | null;
  treeId: number | null;
  milestone: number;
}

/**
 * A video hash may be used once. The only exception is an upload retry: the same owner asking again for the
 * same target while the earlier submission is still `queued` (section 15, rule 8). That returns null, and the
 * caller reuses the existing submission. A rejected video still counts as a duplicate.
 */
export function checkDuplicateVideo(
  existing: ExistingVideoFacts | null,
  profileId: string,
  target: UploadTarget,
): PrecheckReason | null {
  if (!existing) return null;
  const sameRetry =
    existing.profileId === profileId &&
    existing.status === "queued" &&
    existing.kind === target.kind &&
    existing.campaign === target.campaign &&
    existing.slotId === target.slotId &&
    existing.treeId === target.treeId &&
    existing.milestone === target.milestone;
  return sameRetry ? null : "duplicate_video";
}

// ---------------------------------------------------------------------------
// Ownership and state
// ---------------------------------------------------------------------------

/** PLANTED needs an Active campaign (Campaign.onTreePlanted). */
export function checkCampaignActive(kind: EvidenceKind, status: string): PrecheckReason | null {
  return kind === "PLANTED" && status !== "active" ? "campaign_not_active" : null;
}

export interface SlotFacts {
  planter: string | null;
}

/** PLANTED: the slot must be assigned to the submitter's wallet. */
export function checkSlotOwnership(slot: SlotFacts | null, wallet: string): PrecheckReason | null {
  return slot?.planter === wallet ? null : "slot_not_owned";
}

export interface TreeFacts {
  planter: string;
  status: "alive" | "flagged" | "dead" | "removed" | "completed";
  /** Chain time of planting, seconds. */
  plantedAtSec: number;
  /** Seconds added by dismissed flags (section 15, rule 2). */
  pausedSeconds: number;
  /** Replant deadline, seconds, for dead trees. */
  replantDeadlineSec: number | null;
}

/** Non-PLANTED kinds: the tree must belong to the submitter's wallet. */
export function checkTreeOwnership(tree: TreeFacts, wallet: string): PrecheckReason | null {
  return tree.planter === wallet ? null : "tree_not_owned";
}

/**
 * Tree status per kind, mirroring TreeRegistry: ALIVE and DEAD need an Alive tree (flagged trees are paused),
 * REPLANTED needs a Dead tree whose replant deadline has not passed.
 */
export function checkTreeStatus(
  kind: EvidenceKind,
  tree: TreeFacts,
  chainNowSec: number,
): PrecheckReason | null {
  if (kind === "ALIVE" || kind === "DEAD")
    return tree.status === "alive" ? null : "wrong_tree_status";
  if (kind === "REPLANTED") {
    if (tree.status !== "dead") return "wrong_tree_status";
    if (tree.replantDeadlineSec !== null && chainNowSec > tree.replantDeadlineSec) {
      return "replant_deadline_passed";
    }
  }
  return null;
}

/**
 * The milestone window an ALIVE check-in lands in: [opensAt, closesAt], both inclusive, exactly as
 * Campaign._window. Due time shifts by the tree's paused seconds.
 */
export function milestoneWindow(
  tree: Pick<TreeFacts, "plantedAtSec" | "pausedSeconds">,
  milestone: number,
  timeUnitSeconds: number,
): { opensAt: number; closesAt: number } {
  const dueUnits = MILESTONE_DUE_UNITS[milestone];
  if (dueUnits === undefined) throw new Error(`Unknown milestone ${milestone}`);
  const opensAt = tree.plantedAtSec + tree.pausedSeconds + dueUnits * timeUnitSeconds;
  return { opensAt, closesAt: opensAt + MILESTONE_WINDOW_UNITS * timeUnitSeconds };
}

/**
 * ALIVE only: chain time must be inside the milestone window (section 15, rule 4). Milestone 0 is paid by the
 * PLANTED attestation itself, and DEAD and REPLANTED have no window.
 */
export function checkMilestoneOpen(
  kind: EvidenceKind,
  milestone: number,
  tree: Pick<TreeFacts, "plantedAtSec" | "pausedSeconds"> | null,
  timeUnitSeconds: number,
  chainNowSec: number,
): PrecheckReason | null {
  if (kind !== "ALIVE" || !tree) return null;
  const { opensAt, closesAt } = milestoneWindow(tree, milestone, timeUnitSeconds);
  return chainNowSec < opensAt || chainNowSec > closesAt ? "milestone_not_open" : null;
}

export interface MilestoneHistory {
  /** ALIVE: a payout for this tree milestone is already mirrored. PLANTED: the slot already has a tree. */
  settledOnChain: boolean;
  /** Another submission for the same target is already accepted. */
  acceptedSubmission: boolean;
}

/** One accepted submission per tree milestone, and one planting per slot. */
export function checkMilestoneNotDone(
  kind: EvidenceKind,
  history: MilestoneHistory,
): PrecheckReason | null {
  if (kind !== "ALIVE" && kind !== "PLANTED") return null;
  return history.settledOnChain || history.acceptedSubmission ? "milestone_already_done" : null;
}

// ---------------------------------------------------------------------------
// Challenges
// ---------------------------------------------------------------------------

/** When an auditor challenge is active for the tree, the signed payload must carry its code. */
export function checkChallenge(
  activeChallengeCode: string | null,
  payloadChallenge: string | null,
): PrecheckReason | null {
  if (activeChallengeCode === null) return null;
  return payloadChallenge === activeChallengeCode ? null : "challenge_missing";
}

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

/** Collects the failing reasons, in order, without duplicates. */
export function collectReasons(results: (PrecheckReason | null)[]): PrecheckReason[] {
  return [...new Set(results.filter((r): r is PrecheckReason => r !== null))];
}
