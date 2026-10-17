import { bytesToBase64Url, canonicalBytes, type EvidencePayload } from "@treecord/shared";
import { describe, expect, it } from "vitest";
import {
  checkCampaignActive,
  checkCaptureTime,
  checkChallenge,
  checkDevice,
  checkDuplicateVideo,
  checkGpsAccuracy,
  checkInsideRegion,
  checkMilestoneNotDone,
  checkMilestoneOpen,
  checkNearTree,
  checkSignature,
  checkSlotOwnership,
  checkTreeOwnership,
  checkTreeStatus,
  checkVideoDuration,
  checkVideoHash,
  collectReasons,
  milestoneWindow,
  PRECHECK_REASONS,
  type TreeFacts,
  type UploadTarget,
} from "@/lib/server/precheck";
import { newDevice } from "./helpers-crypto";

const WALLET = "0x90f79bf6eb2c4f870365e785982e1f101e93b906";
const OTHER = "0x15d34aaf54267db7d7c367839aaf71a00a2c6a65";
const JAKARTA = { lat: -6.2, lon: 106.816666 };
const NOW = Date.parse("2026-10-20T03:15:00.000Z");

/** Moves a point north by roughly `meters`. */
const north = (point: { lat: number; lon: number }, meters: number) => ({
  lat: point.lat + meters / 111_195,
  lon: point.lon,
});

const tree = (overrides: Partial<TreeFacts> = {}): TreeFacts => ({
  planter: WALLET,
  status: "alive",
  plantedAtSec: 1_000_000,
  pausedSeconds: 0,
  replantDeadlineSec: null,
  ...overrides,
});

describe("device and signature", () => {
  it("device_unknown_or_revoked", () => {
    expect(checkDevice(null, "p1")).toBe("device_unknown_or_revoked");
    expect(checkDevice({ profileId: "p1", revokedAt: "2026-10-01T00:00:00Z" }, "p1")).toBe(
      "device_unknown_or_revoked",
    );
    expect(checkDevice({ profileId: "p1", revokedAt: null }, "p1")).toBeNull();
  });

  it("device_not_owned", () => {
    expect(checkDevice({ profileId: "p2", revokedAt: null }, "p1")).toBe("device_not_owned");
  });

  it("signature_invalid", async () => {
    const device = await newDevice();
    const other = await newDevice();
    const payload: EvidencePayload = {
      v: 1,
      kind: "PLANTED",
      campaign: "0x856e4424f806d16e8cbc702b3c0f2ede5468eae5",
      slotId: "1",
      treeId: null,
      milestone: 0,
      videoSha256: "a".repeat(64),
      lat: -6.2,
      lon: 106.816666,
      acc: 8.5,
      capturedAt: "2026-10-20T03:15:00.000Z",
      challenge: null,
      deviceKey: device.thumbprint,
    };
    const bytes = canonicalBytes(payload);
    const signature = await device.sign(bytes);

    expect(await checkSignature(device.jwk, bytes, signature)).toBeNull();
    expect(await checkSignature(other.jwk, bytes, signature)).toBe("signature_invalid");
    const tampered = canonicalBytes({ ...payload, acc: 9.5 });
    expect(await checkSignature(device.jwk, tampered, signature)).toBe("signature_invalid");
    expect(await checkSignature(device.jwk, bytes, bytesToBase64Url(new Uint8Array(64)))).toBe(
      "signature_invalid",
    );
  });

  it("hash_mismatch", () => {
    expect(checkVideoHash("a".repeat(64), "a".repeat(64))).toBeNull();
    expect(checkVideoHash("a".repeat(64), "b".repeat(64))).toBe("hash_mismatch");
  });
});

describe("capture", () => {
  it("stale_capture after 72 hours", () => {
    const at = (ms: number) => new Date(ms).toISOString();
    expect(checkCaptureTime(at(NOW - 72 * 3_600_000), NOW)).toBeNull();
    expect(checkCaptureTime(at(NOW - 72 * 3_600_000 - 1), NOW)).toBe("stale_capture");
  });

  it("future_capture beyond 5 minutes", () => {
    const at = (ms: number) => new Date(ms).toISOString();
    expect(checkCaptureTime(at(NOW + 5 * 60_000), NOW)).toBeNull();
    expect(checkCaptureTime(at(NOW + 5 * 60_000 + 1), NOW)).toBe("future_capture");
  });

  it("gps_inaccurate above 30 m", () => {
    expect(checkGpsAccuracy(30)).toBeNull();
    expect(checkGpsAccuracy(30.1)).toBe("gps_inaccurate");
  });

  it("video_too_short and video_too_long outside 4 to 12 seconds", () => {
    expect(checkVideoDuration(3.9)).toBe("video_too_short");
    expect(checkVideoDuration(4)).toBeNull();
    expect(checkVideoDuration(12)).toBeNull();
    expect(checkVideoDuration(12.1)).toBe("video_too_long");
    expect(checkVideoDuration(null)).toBeNull();
  });
});

describe("location", () => {
  it("outside_region for PLANTED", () => {
    expect(checkInsideRegion(north(JAKARTA, 4_900), JAKARTA, 5_000)).toBeNull();
    expect(checkInsideRegion(north(JAKARTA, 5_100), JAKARTA, 5_000)).toBe("outside_region");
    expect(checkInsideRegion(JAKARTA, null, 5_000)).toBe("outside_region");
  });

  it("moved_tree beyond 15 m of the first location", () => {
    expect(checkNearTree(north(JAKARTA, 14), JAKARTA)).toBeNull();
    expect(checkNearTree(north(JAKARTA, 16), JAKARTA)).toBe("moved_tree");
    expect(checkNearTree(JAKARTA, null)).toBe("moved_tree");
  });
});

describe("duplicate_video", () => {
  const target: UploadTarget = {
    kind: "PLANTED",
    campaign: "0xabc",
    slotId: 1,
    treeId: null,
    milestone: 0,
  };
  const existing = { ...target, profileId: "p1", status: "queued" };

  it("allows a retry by the same owner for the same queued target", () => {
    expect(checkDuplicateVideo(null, "p1", target)).toBeNull();
    expect(checkDuplicateVideo(existing, "p1", target)).toBeNull();
  });

  it("rejects any other reuse, including previously rejected videos", () => {
    expect(checkDuplicateVideo(existing, "p2", target)).toBe("duplicate_video");
    expect(checkDuplicateVideo({ ...existing, status: "rejected" }, "p1", target)).toBe(
      "duplicate_video",
    );
    expect(checkDuplicateVideo({ ...existing, status: "attested" }, "p1", target)).toBe(
      "duplicate_video",
    );
    expect(checkDuplicateVideo(existing, "p1", { ...target, slotId: 2 })).toBe("duplicate_video");
  });
});

describe("ownership and state", () => {
  it("slot_not_owned", () => {
    expect(checkSlotOwnership({ planter: WALLET }, WALLET)).toBeNull();
    expect(checkSlotOwnership({ planter: OTHER }, WALLET)).toBe("slot_not_owned");
    expect(checkSlotOwnership({ planter: null }, WALLET)).toBe("slot_not_owned");
    expect(checkSlotOwnership(null, WALLET)).toBe("slot_not_owned");
  });

  it("tree_not_owned", () => {
    expect(checkTreeOwnership(tree(), WALLET)).toBeNull();
    expect(checkTreeOwnership(tree({ planter: OTHER }), WALLET)).toBe("tree_not_owned");
  });

  it("campaign_not_active for PLANTED", () => {
    expect(checkCampaignActive("PLANTED", "active")).toBeNull();
    expect(checkCampaignActive("PLANTED", "funding")).toBe("campaign_not_active");
    expect(checkCampaignActive("ALIVE", "completed")).toBeNull();
  });

  it("wrong_tree_status and replant_deadline_passed", () => {
    expect(checkTreeStatus("ALIVE", tree(), 0)).toBeNull();
    expect(checkTreeStatus("ALIVE", tree({ status: "flagged" }), 0)).toBe("wrong_tree_status");
    expect(checkTreeStatus("DEAD", tree({ status: "dead" }), 0)).toBe("wrong_tree_status");
    expect(checkTreeStatus("REPLANTED", tree(), 0)).toBe("wrong_tree_status");
    const dead = tree({ status: "dead", replantDeadlineSec: 5_000 });
    expect(checkTreeStatus("REPLANTED", dead, 5_000)).toBeNull();
    expect(checkTreeStatus("REPLANTED", dead, 5_001)).toBe("replant_deadline_passed");
  });
});

describe("milestones", () => {
  const unit = 180;

  it("computes windows like Campaign._window, shifted by paused time", () => {
    expect(milestoneWindow(tree(), 1, unit)).toEqual({
      opensAt: 1_000_000 + 3 * unit,
      closesAt: 1_000_000 + 4 * unit,
    });
    expect(milestoneWindow(tree({ pausedSeconds: 50 }), 5, unit).opensAt).toBe(
      1_000_000 + 50 + 36 * unit,
    );
  });

  it("milestone_not_open before and after the window, inclusive at both ends", () => {
    const { opensAt, closesAt } = milestoneWindow(tree(), 2, unit);
    expect(checkMilestoneOpen("ALIVE", 2, tree(), unit, opensAt - 1)).toBe("milestone_not_open");
    expect(checkMilestoneOpen("ALIVE", 2, tree(), unit, opensAt)).toBeNull();
    expect(checkMilestoneOpen("ALIVE", 2, tree(), unit, closesAt)).toBeNull();
    expect(checkMilestoneOpen("ALIVE", 2, tree(), unit, closesAt + 1)).toBe("milestone_not_open");
    // Only ALIVE has a window.
    expect(checkMilestoneOpen("DEAD", 0, tree(), unit, 0)).toBeNull();
    expect(checkMilestoneOpen("PLANTED", 0, null, unit, 0)).toBeNull();
  });

  it("milestone_already_done for ALIVE and PLANTED", () => {
    const clean = { settledOnChain: false, acceptedSubmission: false };
    expect(checkMilestoneNotDone("ALIVE", clean)).toBeNull();
    expect(checkMilestoneNotDone("ALIVE", { ...clean, settledOnChain: true })).toBe(
      "milestone_already_done",
    );
    expect(checkMilestoneNotDone("PLANTED", { ...clean, acceptedSubmission: true })).toBe(
      "milestone_already_done",
    );
    // A tree can die and be replanted more than once.
    expect(
      checkMilestoneNotDone("DEAD", { settledOnChain: true, acceptedSubmission: true }),
    ).toBeNull();
  });
});

describe("challenge_missing", () => {
  it("requires the active challenge code in the payload", () => {
    expect(checkChallenge(null, null)).toBeNull();
    expect(checkChallenge(null, "K7Q2")).toBeNull();
    expect(checkChallenge("K7Q2", "K7Q2")).toBeNull();
    expect(checkChallenge("K7Q2", null)).toBe("challenge_missing");
    expect(checkChallenge("K7Q2", "AAAA")).toBe("challenge_missing");
  });
});

describe("collectReasons", () => {
  it("keeps order and drops nulls and duplicates", () => {
    expect(collectReasons([null, "moved_tree", "gps_inaccurate", "moved_tree", null])).toEqual([
      "moved_tree",
      "gps_inaccurate",
    ]);
  });

  it("covers every documented reason with a check", () => {
    expect(PRECHECK_REASONS).toHaveLength(20);
  });
});
