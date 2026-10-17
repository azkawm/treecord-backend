import { randomBytes } from "node:crypto";
import {
  deserializeAttestation,
  EVIDENCE_BUCKET,
  KEYFRAMES_BUCKET,
  MockAiClient,
  processScoreJob,
  type SerializedAttestation,
} from "@treecord/pipeline";
import {
  attestationTypes,
  base64UrlToBytes,
  canonicalize,
  computeEvidenceHash,
  encodeGeohash,
  geohashToBytes8,
  getDeployment,
  hashAttestation,
  sha256Hex,
  utf8,
  type EvidencePayload,
} from "@treecord/shared";
import { recoverTypedDataAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { GET as getEvidence } from "@/app/api/evidence/[submissionId]/route";
import { POST as submit } from "@/app/api/evidence/[submissionId]/submit/route";
import { POST as uploadUrl } from "@/app/api/evidence/upload-url/route";
import { POST as review } from "@/app/api/operator/submissions/[id]/review/route";
import { getSupabase } from "@/lib/server/supabase";
import type { TestDevice } from "../helpers-crypto";
import { newDevice } from "../helpers-crypto";
import {
  assignSlots,
  call,
  createCampaign,
  createTree,
  createUser,
  dbAvailable,
  field,
  nowSec,
  registerDevice,
  scoreDeps,
  type TestUser,
} from "../helpers";

const JAKARTA = { lat: -6.2, lon: 106.816666 };
const GATEWAY = getDeployment(31337).verificationGateway;
const ATTESTER = privateKeyToAccount(process.env.ATTESTER_PRIVATE_KEY as `0x${string}`).address;

interface Target {
  kind: EvidencePayload["kind"];
  campaign: `0x${string}`;
  slotId?: string;
  treeId?: string;
  milestone: number;
}

interface Planter {
  user: TestUser;
  device: TestDevice;
}

async function newPlanter(): Promise<Planter> {
  const user = await createUser("planter");
  return { user, device: await registerDevice(user) };
}

/** A campaign with slot 3 assigned to the planter. */
async function plantingTarget(planter: Planter): Promise<Target> {
  const campaign = await createCampaign();
  await assignSlots(campaign, [{ slotId: 3, kind: "open", planter: planter.user.wallet }]);
  return { kind: "PLANTED", campaign, slotId: "3", milestone: 0 };
}

const newVideo = () => new Uint8Array(randomBytes(4096));

async function announce(planter: Planter, target: Target, video: Uint8Array, extra = {}) {
  return call(uploadUrl, {
    token: planter.user.token,
    body: {
      ...target,
      sha256: await sha256Hex(video),
      sizeBytes: video.length,
      durationSec: 7.2,
      ...extra,
    },
  });
}

async function upload(announced: { body: Record<string, unknown> }, video: Uint8Array) {
  const { error } = await getSupabase()
    .storage.from(EVIDENCE_BUCKET)
    .uploadToSignedUrl(
      field<string>(announced.body, "path"),
      field<string>(announced.body, "token"),
      video,
      {
        contentType: "video/mp4",
      },
    );
  if (error) throw error;
}

async function payloadFor(
  planter: Planter,
  target: Target,
  video: Uint8Array,
  overrides: Partial<EvidencePayload> = {},
): Promise<EvidencePayload> {
  return {
    v: 1,
    kind: target.kind,
    campaign: target.campaign,
    slotId: target.slotId ?? null,
    treeId: target.treeId ?? null,
    milestone: target.milestone,
    videoSha256: await sha256Hex(video),
    lat: JAKARTA.lat,
    lon: JAKARTA.lon,
    acc: 8.5,
    capturedAt: new Date(Date.now() - 60_000).toISOString(),
    challenge: null,
    deviceKey: planter.device.thumbprint,
    ...overrides,
  };
}

async function submitPayload(
  planter: Planter,
  submissionId: string,
  payload: EvidencePayload,
  signer: TestDevice = planter.device,
) {
  const canonical = canonicalize(payload);
  return call(submit, {
    token: planter.user.token,
    params: { submissionId },
    body: { payload, canonical, signature: await signer.sign(utf8(canonical)) },
  });
}

/** Announce, upload and submit in one go. */
async function fullSubmit(
  planter: Planter,
  target: Target,
  overrides: Partial<EvidencePayload> = {},
) {
  const video = newVideo();
  const announced = await announce(planter, target, video);
  expect(announced.status).toBe(201);
  await upload(announced, video);
  const submissionId = field<string>(announced.body, "submissionId");
  const payload = await payloadFor(planter, target, video, overrides);
  const res = await submitPayload(planter, submissionId, payload);
  return { submissionId, payload, res };
}

async function loadJob(id: string) {
  const { data, error } = await getSupabase()
    .from("relayer_jobs")
    .select("*")
    .eq("id", id)
    .single();
  if (error) throw error;
  return data;
}

describe.skipIf(!dbAvailable)("evidence pipeline: upload → submit → score → attest", () => {
  it("attests a valid planting with a signature that recovers to the attester", async () => {
    const planter = await newPlanter();
    const target = await plantingTarget(planter);
    const { submissionId, payload, res } = await fullSubmit(planter, target);

    // Submit runs prechecks and hands scoring to the worker.
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({
      submissionId,
      status: "checking",
      reasons: [],
      policyScore: null,
    });
    const scoreJob = await loadJob(field<string>(res.body, "jobId"));
    expect(scoreJob).toMatchObject({ kind: "score", status: "pending", payload: { submissionId } });

    // The worker's score job, with the mock AI.
    const ai = new MockAiClient();
    const scored = await processScoreJob(scoreDeps(ai), submissionId);
    expect(scored).toMatchObject({ status: "attested", reasons: [], skipped: false });
    expect(scored.policyScore).toBeGreaterThan(9000);
    expect(ai.requests[0]).toMatchObject({
      submissionId,
      kind: "PLANTED",
      species: "Swietenia macrophylla",
      challengeCode: null,
      tree: null,
    });
    expect(ai.requests[0]?.video.url).toMatch(/^http/);

    // The attestation job carries a valid EIP-712 attestation.
    const job = await loadJob(scored.jobId ?? "");
    expect(job.kind).toBe("attestation");
    const jobPayload = job.payload as unknown as {
      submissionId: string;
      nonce: string;
      attestation: SerializedAttestation;
      signature: `0x${string}`;
    };
    expect(jobPayload.submissionId).toBe(submissionId);
    const attestation = deserializeAttestation(jobPayload.attestation);
    expect(jobPayload.nonce).toBe(attestation.nonce.toString());

    const canonical = utf8(canonicalize(payload));
    const submitted = (
      await getSupabase()
        .from("submissions")
        .select("signature, attestation")
        .eq("id", submissionId)
        .single()
    ).data;
    expect(attestation).toMatchObject({
      kind: 0,
      campaign: target.campaign,
      slotId: 3n,
      treeId: 0n,
      planter: planter.user.wallet,
      milestone: 0,
      evidenceHash: computeEvidenceHash(canonical, base64UrlToBytes(submitted?.signature ?? "")),
      geohash: geohashToBytes8(encodeGeohash(JAKARTA.lat, JAKARTA.lon, 7)),
      score: scored.policyScore,
    });
    expect(Number(attestation.expiry)).toBeGreaterThanOrEqual(nowSec() + 3500);

    const digest = hashAttestation(attestation, 31337, GATEWAY);
    expect((submitted?.attestation as { digest: string }).digest).toBe(digest);
    const recovered = await recoverTypedDataAddress({
      domain: { name: "Treecord", version: "1", chainId: 31337, verifyingContract: GATEWAY },
      types: attestationTypes,
      primaryType: "Attestation",
      message: attestation,
      signature: jobPayload.signature,
    });
    expect(recovered).toBe(ATTESTER);

    // Keyframes were copied into the backend's own bucket.
    const stored = await getSupabase()
      .from("submissions")
      .select("keyframe_paths")
      .eq("id", submissionId)
      .single();
    expect(stored.data?.keyframe_paths).toEqual([`${submissionId}/0.jpg`]);
    const keyframe = await getSupabase()
      .storage.from(KEYFRAMES_BUCKET)
      .download(`${submissionId}/0.jpg`);
    expect(keyframe.error).toBeNull();

    // The status endpoint shows the outcome.
    const status = await call(getEvidence, { token: planter.user.token, params: { submissionId } });
    expect(status.status).toBe(200);
    expect(status.body).toMatchObject({
      submission: {
        status: "attested",
        policyDecision: "pass",
        jobId: job.id,
        attestation: { nonce: attestation.nonce.toString(), digest },
      },
    });
  });

  it("is idempotent: repeated submits and score runs change nothing", async () => {
    const planter = await newPlanter();
    const target = await plantingTarget(planter);
    const { submissionId, payload, res } = await fullSubmit(planter, target);
    const again = await submitPayload(planter, submissionId, payload);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({
      status: "checking",
      idempotent: true,
      jobId: field(res.body, "jobId"),
    });

    const first = await processScoreJob(scoreDeps(), submissionId);
    const second = await processScoreJob(scoreDeps(), submissionId);
    expect(second).toMatchObject({ status: "attested", skipped: true, jobId: first.jobId });
    const jobs = await getSupabase()
      .from("relayer_jobs")
      .select("id")
      .eq("kind", "attestation")
      .eq("payload->>submissionId", submissionId);
    expect(jobs.data).toHaveLength(1);

    const replay = await submitPayload(planter, submissionId, payload);
    expect(replay.body).toMatchObject({ status: "attested", jobId: first.jobId });
  });
});

describe.skipIf(!dbAvailable)("POST /api/evidence/upload-url", () => {
  it("returns a signed upload URL for a queued submission", async () => {
    const planter = await newPlanter();
    const target = await plantingTarget(planter);
    const video = newVideo();
    const res = await announce(planter, target, video);
    expect(res.status).toBe(201);
    const submissionId = field<string>(res.body, "submissionId");
    expect(res.body).toMatchObject({
      path: `${planter.user.profileId}/${submissionId}.mp4`,
      idempotent: false,
    });
    expect(field<string>(res.body, "uploadUrl")).toContain(
      "/storage/v1/object/upload/sign/evidence/",
    );

    const row = await getSupabase()
      .from("submissions")
      .select("status")
      .eq("id", submissionId)
      .single();
    expect(row.data?.status).toBe("queued");

    const webm = await announce(planter, target, newVideo(), { contentType: "video/webm" });
    expect(field<string>(webm.body, "path")).toMatch(/\.webm$/);
  });

  it("reuses a queued submission for an upload retry, and rejects other reuse as duplicate_video", async () => {
    const planter = await newPlanter();
    const target = await plantingTarget(planter);
    const video = newVideo();
    const first = await announce(planter, target, video);
    const retry = await announce(planter, target, video);
    expect(retry.status).toBe(200);
    expect(retry.body).toMatchObject({
      submissionId: field(first.body, "submissionId"),
      idempotent: true,
    });

    const other = await newPlanter();
    const stolen = await announce(other, await plantingTarget(other), video);
    expect(stolen.status).toBe(422);
    expect(stolen.body).toMatchObject({
      error: { code: "precheck_failed", details: { reasons: ["duplicate_video"] } },
    });
  });

  it("runs target prechecks before the upload", async () => {
    const planter = await newPlanter();
    const campaign = await createCampaign();
    const notMine = await announce(
      planter,
      { kind: "PLANTED", campaign, slotId: "4", milestone: 0 },
      newVideo(),
    );
    expect(notMine.status).toBe(422);
    expect(notMine.body).toMatchObject({ error: { details: { reasons: ["slot_not_owned"] } } });

    const target = await plantingTarget(planter);
    const long = await announce(planter, target, newVideo(), { durationSec: 20 });
    expect(long.body).toMatchObject({ error: { details: { reasons: ["video_too_long"] } } });

    const funding = await createCampaign({ status: "funding" });
    await assignSlots(funding, [{ slotId: 3, kind: "open", planter: planter.user.wallet }]);
    const inactive = await announce(
      planter,
      { kind: "PLANTED", campaign: funding, slotId: "3", milestone: 0 },
      newVideo(),
    );
    expect(inactive.body).toMatchObject({
      error: { details: { reasons: ["campaign_not_active"] } },
    });
  });

  it("checks role, input and existence", async () => {
    const donor = await createUser("donor");
    const forbidden = await call(uploadUrl, { token: donor.token, body: {} });
    expect(forbidden.status).toBe(403);

    const planter = await newPlanter();
    const target = await plantingTarget(planter);
    const tooBig = await announce(planter, target, newVideo(), { sizeBytes: 26 * 1024 * 1024 });
    expect(tooBig.status).toBe(400);
    const wrongShape = await announce(planter, { ...target, milestone: 1 }, newVideo());
    expect(wrongShape.status).toBe(400);

    const missingTree = await announce(
      planter,
      { kind: "ALIVE", campaign: target.campaign, treeId: "999999999", milestone: 1 },
      newVideo(),
    );
    expect(missingTree.status).toBe(404);
  });
});

describe.skipIf(!dbAvailable)("POST /api/evidence/:id/submit prechecks", () => {
  it("rejects bad GPS with every failing reason, and replays the rejection", async () => {
    const planter = await newPlanter();
    const target = await plantingTarget(planter);
    const { submissionId, payload, res } = await fullSubmit(planter, target, {
      lat: -7.5,
      acc: 45,
    });
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({
      status: "rejected",
      reasons: ["gps_inaccurate", "outside_region"],
      error: { code: "evidence_rejected" },
    });
    const replay = await submitPayload(planter, submissionId, payload);
    expect(replay.status).toBe(422);
    expect(replay.body).toMatchObject({
      idempotent: true,
      reasons: ["gps_inaccurate", "outside_region"],
    });
  });

  it("recomputes the stored file hash (hash_mismatch)", async () => {
    const planter = await newPlanter();
    const target = await plantingTarget(planter);
    const video = newVideo();
    const announced = await announce(planter, target, video);
    await upload(announced, newVideo());
    const res = await submitPayload(
      planter,
      field<string>(announced.body, "submissionId"),
      await payloadFor(planter, target, video),
    );
    expect(res.body).toMatchObject({ reasons: ["hash_mismatch"] });
  });

  it("verifies the device signature and device ownership", async () => {
    /** A fresh planter with an uploaded planting video, ready to submit. */
    async function uploaded() {
      const planter = await newPlanter();
      const target = await plantingTarget(planter);
      const video = newVideo();
      const announced = await announce(planter, target, video);
      await upload(announced, video);
      return { planter, target, video, id: field<string>(announced.body, "submissionId") };
    }

    const a = await uploaded();
    const wrongKey = await submitPayload(
      a.planter,
      a.id,
      await payloadFor(a.planter, a.target, a.video),
      await newDevice(),
    );
    expect(wrongKey.body).toMatchObject({ reasons: ["signature_invalid"] });

    const b = await uploaded();
    const stranger = await newDevice();
    const unknown = await submitPayload(
      b.planter,
      b.id,
      await payloadFor(b.planter, b.target, b.video, { deviceKey: stranger.thumbprint }),
      stranger,
    );
    expect(unknown.body).toMatchObject({ reasons: ["device_unknown_or_revoked"] });

    const c = await uploaded();
    const borrowed = await submitPayload(
      c.planter,
      c.id,
      await payloadFor(c.planter, c.target, c.video, { deviceKey: a.planter.device.thumbprint }),
      a.planter.device,
    );
    expect(borrowed.body).toMatchObject({ reasons: ["device_not_owned"] });

    const d = await uploaded();
    await getSupabase()
      .from("devices")
      .update({ revoked_at: new Date().toISOString() })
      .eq("thumbprint", d.planter.device.thumbprint)
      .throwOnError();
    const revoked = await submitPayload(
      d.planter,
      d.id,
      await payloadFor(d.planter, d.target, d.video),
    );
    expect(revoked.body).toMatchObject({ reasons: ["device_unknown_or_revoked"] });
  });

  it("rejects stale captures", async () => {
    const planter = await newPlanter();
    const target = await plantingTarget(planter);
    const { res } = await fullSubmit(planter, target, {
      capturedAt: new Date(Date.now() - 73 * 3_600_000).toISOString(),
    });
    expect(res.body).toMatchObject({ reasons: ["stale_capture"] });
  });

  it("asks for the upload first, without burning the submission", async () => {
    const planter = await newPlanter();
    const target = await plantingTarget(planter);
    const video = newVideo();
    const announced = await announce(planter, target, video);
    const id = field<string>(announced.body, "submissionId");
    const payload = await payloadFor(planter, target, video);

    const early = await submitPayload(planter, id, payload);
    expect(early.status).toBe(409);
    expect(early.body).toMatchObject({ error: { code: "video_not_uploaded" } });

    await upload(announced, video);
    expect((await submitPayload(planter, id, payload)).status).toBe(202);
  });

  it("requires the payload to match the announced upload and its canonical form", async () => {
    const planter = await newPlanter();
    const target = await plantingTarget(planter);
    const video = newVideo();
    const announced = await announce(planter, target, video);
    const id = field<string>(announced.body, "submissionId");
    const payload = await payloadFor(planter, target, video);

    const mismatch = await submitPayload(planter, id, { ...payload, slotId: "4" });
    expect(mismatch.status).toBe(400);
    expect(mismatch.body).toMatchObject({
      error: { code: "payload_mismatch", details: { fields: ["slotId"] } },
    });

    const canonical = await call(submit, {
      token: planter.user.token,
      params: { submissionId: id },
      body: {
        payload,
        canonical: JSON.stringify(payload),
        signature: await planter.device.sign(utf8("x")),
      },
    });
    expect(canonical.status).toBe(400);
    expect(canonical.body).toMatchObject({ error: { code: "canonical_mismatch" } });
  });

  it("hides other planters' submissions", async () => {
    const planter = await newPlanter();
    const target = await plantingTarget(planter);
    const video = newVideo();
    const announced = await announce(planter, target, video);
    const other = await newPlanter();
    const res = await submitPayload(
      other,
      field<string>(announced.body, "submissionId"),
      await payloadFor(planter, target, video),
    );
    expect(res.status).toBe(404);
  });
});

describe.skipIf(!dbAvailable)("check-ins on an existing tree", () => {
  /** A tree planted so that milestone 1 (due after 3 units of 60 s) is open now. */
  async function treeTarget(planter: Planter, milestone = 1): Promise<Target> {
    const campaign = await createCampaign();
    const treeId = await createTree({
      campaign,
      planter: planter.user.wallet,
      plantedAtSec: nowSec() - 3 * 60 - 10,
    });
    return { kind: "ALIVE", campaign, treeId: String(treeId), milestone };
  }

  it("scores an ALIVE check-in with the tree's previous keyframes as context", async () => {
    const planter = await newPlanter();
    const target = await treeTarget(planter);
    const { submissionId, res } = await fullSubmit(planter, target);
    expect(res.status).toBe(202);
    const ai = new MockAiClient();
    expect((await processScoreJob(scoreDeps(ai), submissionId)).status).toBe("attested");
    expect(ai.requests[0]?.tree).toMatchObject({ treeId: target.treeId, previousKeyframes: [] });

    const job = await loadJob((await processScoreJob(scoreDeps(), submissionId)).jobId ?? "");
    const attestation = deserializeAttestation(
      (job.payload as unknown as { attestation: SerializedAttestation }).attestation,
    );
    expect(attestation).toMatchObject({
      kind: 1,
      slotId: 0n,
      treeId: BigInt(target.treeId ?? 0),
      milestone: 1,
    });
  });

  it("rejects closed milestones, moved trees, other planters' trees and missing challenges", async () => {
    const planter = await newPlanter();
    const notYet = await announce(planter, await treeTarget(planter, 2), newVideo());
    expect(notYet.body).toMatchObject({ error: { details: { reasons: ["milestone_not_open"] } } });

    const moved = await fullSubmit(planter, await treeTarget(planter), {
      lat: JAKARTA.lat + 0.0003,
    });
    expect(moved.res.body).toMatchObject({ reasons: ["moved_tree"] });

    const other = await newPlanter();
    const theirs = await announce(planter, await treeTarget(other), newVideo());
    expect(theirs.body).toMatchObject({ error: { details: { reasons: ["tree_not_owned"] } } });

    const target = await treeTarget(planter);
    const operator = await createUser("operator");
    await getSupabase()
      .from("challenges")
      .insert({
        tree_id: Number(target.treeId),
        code: "K7Q2",
        issued_by_profile_id: operator.profileId,
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      })
      .throwOnError();
    const unanswered = await fullSubmit(planter, target);
    expect(unanswered.res.body).toMatchObject({ reasons: ["challenge_missing"] });
    const answered = await fullSubmit(planter, target, { challenge: "K7Q2" });
    expect(answered.res.status).toBe(202);
    expect((await processScoreJob(scoreDeps(), answered.submissionId)).status).toBe("attested");
    const challenge = await getSupabase()
      .from("challenges")
      .select("fulfilled_submission_id")
      .eq("tree_id", Number(target.treeId))
      .single();
    expect(challenge.data?.fulfilled_submission_id).toBe(answered.submissionId);
  });

  it("rejects a second accepted check-in for the same milestone", async () => {
    const planter = await newPlanter();
    const target = await treeTarget(planter);
    const first = await fullSubmit(planter, target);
    const second = await fullSubmit(planter, target);
    expect((await processScoreJob(scoreDeps(), first.submissionId)).status).toBe("attested");
    // The second was accepted for scoring before the first was attested: the unique index stops it.
    const ai = new MockAiClient();
    expect(await processScoreJob(scoreDeps(ai), second.submissionId)).toMatchObject({
      status: "rejected",
      reasons: ["milestone_already_done"],
    });
    // The AI saw the first check-in's stored keyframe as growth context.
    expect(ai.requests[0]?.tree?.previousKeyframes).toHaveLength(1);
    expect(ai.requests[0]?.tree?.previousKeyframes[0]).toContain(
      `/storage/v1/object/sign/keyframes/${first.submissionId}/0.jpg`,
    );
    const third = await announce(planter, target, newVideo());
    expect(third.body).toMatchObject({
      error: { details: { reasons: ["milestone_already_done"] } },
    });
  });
});

describe.skipIf(!dbAvailable)("scoring outcomes and operator review", () => {
  async function scoredWith(challenge: string) {
    const planter = await newPlanter();
    const target = await plantingTarget(planter);
    const { submissionId } = await fullSubmit(planter, target, { challenge });
    return { planter, submissionId, outcome: await processScoreJob(scoreDeps(), submissionId) };
  }

  it("rejects failing scores and unreadable videos", async () => {
    expect((await scoredWith("FAIL-LIVENESS")).outcome).toMatchObject({
      status: "rejected",
      reasons: ["liveness_low"],
    });
    expect((await scoredWith("UNREADABLE")).outcome).toMatchObject({
      status: "rejected",
      reasons: ["video_unreadable"],
    });
    expect((await scoredWith("BAD-INPUT")).outcome).toMatchObject({ status: "failed" });
  });

  it("retries a busy AI service and fails the submission on the last attempt", async () => {
    const planter = await newPlanter();
    const target = await plantingTarget(planter);
    const { submissionId } = await fullSubmit(planter, target, { challenge: "BUSY" });
    await expect(processScoreJob(scoreDeps(), submissionId)).rejects.toMatchObject({ status: 503 });
    const row = await getSupabase()
      .from("submissions")
      .select("status")
      .eq("id", submissionId)
      .single();
    expect(row.data?.status).toBe("checking");
    expect(await processScoreJob(scoreDeps(), submissionId, { finalAttempt: true })).toMatchObject({
      status: "failed",
    });
  });

  it("sends borderline scores to review, where an operator can approve", async () => {
    const { planter, submissionId, outcome } = await scoredWith("REVIEW-LIVENESS");
    expect(outcome).toMatchObject({ status: "needs_review", reasons: ["liveness_borderline"] });

    const asPlanter = await call(review, {
      token: planter.user.token,
      params: { id: submissionId },
      body: { approve: true, note: "looks fine" },
    });
    expect(asPlanter.status).toBe(403);

    const operator = await createUser("operator");
    const approved = await call(review, {
      token: operator.token,
      params: { id: submissionId },
      body: { approve: true, note: "Seedling clearly visible, camera shake explains liveness." },
    });
    expect(approved.status).toBe(200);
    expect(approved.body).toMatchObject({
      submission: {
        status: "attested",
        policyDecision: "needs_review",
        review: { note: expect.any(String) },
      },
    });
    const job = await loadJob(field<string>(approved.body, "submission.jobId"));
    expect(job.kind).toBe("attestation");

    const repeat = await call(review, {
      token: operator.token,
      params: { id: submissionId },
      body: { approve: true, note: "again" },
    });
    expect(repeat.body).toMatchObject({ idempotent: true, submission: { jobId: job.id } });
    const flipped = await call(review, {
      token: operator.token,
      params: { id: submissionId },
      body: { approve: false, note: "changed my mind" },
    });
    expect(flipped.status).toBe(409);
  });

  it("lets an operator reject a submission in review", async () => {
    const { submissionId } = await scoredWith("REVIEW-LIVENESS");
    const operator = await createUser("operator");
    const rejected = await call(review, {
      token: operator.token,
      params: { id: submissionId },
      body: { approve: false, note: "Different tree than the slot photo." },
    });
    expect(rejected.body).toMatchObject({
      submission: { status: "rejected", reasons: ["liveness_borderline", "operator_rejected"] },
    });
  });

  it("shows submissions to their planter, operators and auditors only", async () => {
    const { planter, submissionId } = await scoredWith("FAIL-RECAPTURE");
    const own = await call(getEvidence, { token: planter.user.token, params: { submissionId } });
    expect(own.body).toMatchObject({
      submission: { status: "rejected", reasons: ["recapture_high"], scores: { recapture: 0.6 } },
    });
    const other = await createUser("planter");
    expect((await call(getEvidence, { token: other.token, params: { submissionId } })).status).toBe(
      404,
    );
    for (const role of ["operator", "auditor"] as const) {
      const user = await createUser(role);
      expect(
        (await call(getEvidence, { token: user.token, params: { submissionId } })).status,
      ).toBe(200);
    }
  });
});
