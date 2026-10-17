import { randomBytes, randomUUID } from "node:crypto";
import {
  auditSeed,
  base64UrlToBytes,
  canonicalBytes,
  canonicalize,
  computeEvidenceHash,
  reportHash,
  sampleTreeIds,
  sha256Hex,
  type EvidencePayload,
  type Json,
  type JsonValue,
} from "@treecord/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST as closeSession } from "@/app/api/audit/sessions/[id]/close/route";
import { POST as challenge } from "@/app/api/audit/sessions/[id]/challenges/route";
import { POST as finding } from "@/app/api/audit/sessions/[id]/findings/route";
import { GET as reproduce } from "@/app/api/audit/sessions/[id]/reproduce/route";
import { GET as getSession } from "@/app/api/audit/sessions/[id]/route";
import { GET as bundle } from "@/app/api/audit/sessions/[id]/trees/[treeId]/route";
import { POST as createSession } from "@/app/api/audit/sessions/route";
import { setLatestBlockSource } from "@/lib/server/chain";
import { getSupabase } from "@/lib/server/supabase";
import {
  call,
  createCampaign,
  createTree,
  createUser,
  dbAvailable,
  field,
  randomHash,
  registerDevice,
  type TestUser,
} from "../helpers";

const BLOCK = { number: 4_242n, hash: `0x${"5e".repeat(32)}` as `0x${string}` };
beforeAll(() => setLatestBlockSource(async () => BLOCK));
afterAll(() => setLatestBlockSource(null));

/** A campaign with `count` trees (the last one removed) and an auditor session sampling `size` of them. */
async function sessionFor(count: number, size: number) {
  const auditor = await createUser("auditor");
  const planter = await createUser("planter");
  const campaign = await createCampaign({ treeTarget: 20 });
  const trees: number[] = [];
  for (let slot = 1; slot <= count; slot++) {
    trees.push(
      await createTree({
        campaign,
        planter: planter.wallet,
        slotId: slot,
        status: slot === count ? "removed" : "alive",
      }),
    );
  }
  const res = await call(createSession, {
    token: auditor.token,
    body: { campaign, sampleSize: size },
  });
  return { auditor, planter, campaign, trees, res, id: field<string>(res.body, "session.id") };
}

const sampledIds = (body: unknown) =>
  field<{ treeId: number }[]>(body, "session.samples").map((s) => s.treeId);

describe.skipIf(!dbAvailable)("audit sessions: sampling", () => {
  it("samples from the campaign's trees with a seed from the session id and the latest block hash", async () => {
    const { res, id, trees } = await sessionFor(8, 4);
    expect(res.status).toBe(201);
    const population = trees.slice(0, 7).map(BigInt); // the removed tree is excluded
    const seed = auditSeed(id, BLOCK.hash);
    expect(res.body).toMatchObject({
      session: {
        status: "open",
        seed: { seed, blockNumber: 4242, blockHash: BLOCK.hash },
        populationSize: 7,
        sampleSize: 4,
      },
    });
    // Same inputs, same sample: recomputed here from the published inputs alone.
    expect(sampledIds(res.body)).toEqual(sampleTreeIds(population, seed, 4).map(Number));
  });

  it("reproduce is public and recomputes the same sample", async () => {
    const { id } = await sessionFor(6, 3);
    const res = await call(reproduce, { params: { id } });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      sessionId: id,
      blockHash: BLOCK.hash,
      blockNumber: "4242",
      sampleSize: 3,
      check: { seedMatches: true, sampleMatches: true },
    });
    const body = res.body as { population: string[]; sample: string[]; seed: `0x${string}` };
    expect(body.population).toHaveLength(5);
    expect(sampleTreeIds(body.population.map(BigInt), body.seed, 3).map(String)).toEqual(
      body.sample,
    );
    expect(field(res.body, "algorithm")).toContain("keccak256");
    expect((await call(reproduce, { params: { id: randomUUID() } })).status).toBe(404);
  });

  it("caps the sample at the population, and needs trees and the auditor role", async () => {
    const { res } = await sessionFor(3, 10);
    expect(field(res.body, "session.sampleSize")).toBe(2);

    const auditor = await createUser("auditor");
    const empty = await createCampaign();
    const none = await call(createSession, {
      token: auditor.token,
      body: { campaign: empty, sampleSize: 3 },
    });
    expect(none.status).toBe(409);
    expect(field(none.body, "error.code")).toBe("no_trees");

    const operator = await createUser("operator");
    expect(
      (
        await call(createSession, {
          token: operator.token,
          body: { campaign: empty, sampleSize: 3 },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call(createSession, {
          token: auditor.token,
          body: { campaign: empty, sampleSize: 0 },
        })
      ).status,
    ).toBe(400);
  });

  it("sessions are private to their auditor", async () => {
    const { auditor, id } = await sessionFor(3, 2);
    expect((await call(getSession, { token: auditor.token, params: { id } })).status).toBe(200);
    const other = await createUser("auditor");
    expect((await call(getSession, { token: other.token, params: { id } })).status).toBe(404);
  });
});

/** A PLANTED submission for the tree with a real device signature and an uploaded video. */
async function signedPlanting(planter: TestUser, campaign: string, slotId: number) {
  const device = await registerDevice(planter);
  const video = randomBytes(256);
  const payload: EvidencePayload = {
    v: 1,
    kind: "PLANTED",
    campaign,
    slotId: String(slotId),
    treeId: null,
    milestone: 0,
    videoSha256: await sha256Hex(new Uint8Array(video)),
    lat: -6.2,
    lon: 106.816666,
    acc: 5,
    capturedAt: new Date().toISOString(),
    challenge: null,
    deviceKey: device.thumbprint,
  };
  const bytes = canonicalBytes(payload);
  const signature = await device.sign(bytes);
  const id = randomUUID();
  const path = `${planter.profileId}/${id}.mp4`;
  const db = getSupabase();
  const upload = await db.storage
    .from("evidence")
    .upload(path, video, { contentType: "video/mp4" });
  if (upload.error) throw upload.error;
  const deviceRow = await db
    .from("devices")
    .select("id")
    .eq("thumbprint", device.thumbprint)
    .single();
  const inserted = await db.from("submissions").insert({
    id,
    profile_id: planter.profileId,
    device_id: deviceRow.data?.id ?? null,
    campaign_address: campaign,
    slot_id: slotId,
    kind: "PLANTED",
    milestone: 0,
    video_path: path,
    video_sha256: payload.videoSha256,
    payload: payload as unknown as Json,
    canonical: canonicalize(payload),
    signature,
    evidence_hash: computeEvidenceHash(bytes, base64UrlToBytes(signature)),
    status: "onchain",
    tx_hash: randomHash(),
  });
  if (inserted.error) throw inserted.error;
  return { id, signature };
}

describe.skipIf(!dbAvailable)("audit sessions: evidence bundle", () => {
  it("re-verifies each submission now and logs every access", async () => {
    const { auditor, planter, campaign, id, res } = await sessionFor(3, 2);
    const treeId = sampledIds(res.body)[0] as number;
    const tree = await getSupabase().from("trees").select("slot_id").eq("tree_id", treeId).single();
    const submission = await signedPlanting(planter, campaign, tree.data?.slot_id ?? 1);
    const logCount = async () =>
      (
        await getSupabase()
          .from("audit_access_log")
          .select("id", { count: "exact", head: true })
          .eq("session_id", id)
      ).count;

    const params = { id, treeId: String(treeId) };
    const first = await call(bundle, { token: auditor.token, params });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({
      tree: { treeId, location: { precision: "exact" } },
      submissions: [
        {
          id: submission.id,
          kind: "PLANTED",
          signature: submission.signature,
          video: { url: expect.stringContaining("/storage/v1/object/sign/evidence/") },
          verification: {
            signatureValid: true,
            canonicalMatchesPayload: true,
            evidenceHashMatches: true,
            videoHashMatches: true,
          },
        },
      ],
    });
    await call(bundle, { token: auditor.token, params });
    expect(await logCount()).toBe(2);
    const log = await getSupabase()
      .from("audit_access_log")
      .select("auditor_profile_id, resource")
      .eq("session_id", id);
    expect(log.data).toEqual([
      { auditor_profile_id: auditor.profileId, resource: `tree:${treeId}` },
      { auditor_profile_id: auditor.profileId, resource: `tree:${treeId}` },
    ]);

    // A signature changed after the fact no longer verifies, and neither does the evidence hash.
    const tampered = `${submission.signature.slice(0, -4)}AAAA`;
    await getSupabase().from("submissions").update({ signature: tampered }).eq("id", submission.id);
    const after = await call(bundle, { token: auditor.token, params });
    expect(field(after.body, "submissions.0.verification")).toMatchObject({
      signatureValid: false,
      evidenceHashMatches: false,
      videoHashMatches: true,
    });
  });

  it("only serves sampled trees of the auditor's own session, without logging refusals", async () => {
    const { auditor, id, trees, res } = await sessionFor(5, 1);
    const sampled = sampledIds(res.body)[0];
    const notSampled = trees.find((t) => t !== sampled) as number;
    const refused = await call(bundle, {
      token: auditor.token,
      params: { id, treeId: String(notSampled) },
    });
    expect(refused.status).toBe(404);
    const other = await createUser("auditor");
    expect(
      (await call(bundle, { token: other.token, params: { id, treeId: String(sampled) } })).status,
    ).toBe(404);
    const log = await getSupabase()
      .from("audit_access_log")
      .select("id", { count: "exact", head: true })
      .eq("session_id", id);
    expect(log.count).toBe(0);
  });
});

describe.skipIf(!dbAvailable)("audit sessions: challenges, findings, close", () => {
  it("issues one 4-character challenge per sampled tree, expiring in 2 time units", async () => {
    const { auditor, id, res, trees } = await sessionFor(4, 2);
    const treeId = sampledIds(res.body)[0] as number;
    const before = Date.now();
    const issued = await call(challenge, {
      token: auditor.token,
      params: { id },
      body: { treeId: String(treeId) },
    });
    expect(issued.status).toBe(201);
    expect(field(issued.body, "challenge.code")).toMatch(/^[A-Z0-9]{4}$/);
    const expires = Date.parse(field<string>(issued.body, "challenge.expiresAt"));
    // Fixture time unit is 60 s.
    expect(expires - before).toBeGreaterThanOrEqual(119_000);
    expect(expires - before).toBeLessThan(125_000);

    const again = await call(challenge, {
      token: auditor.token,
      params: { id },
      body: { treeId: String(treeId) },
    });
    expect(again.status).toBe(409);
    expect(field(again.body, "error.code")).toBe("challenge_active");

    const outside = trees.find((t) => !sampledIds(res.body).includes(t)) as number;
    expect(
      (
        await call(challenge, {
          token: auditor.token,
          params: { id },
          body: { treeId: String(outside) },
        })
      ).status,
    ).toBe(404);
  });

  it("closes only with every finding recorded, hashing the canonical report", async () => {
    const { auditor, id, res } = await sessionFor(4, 3);
    const [a, b, c] = sampledIds(res.body) as [number, number, number];
    const record = (treeId: number, value: string, notes?: string) =>
      call(finding, {
        token: auditor.token,
        params: { id },
        body: { treeId: String(treeId), finding: value, ...(notes ? { notes } : {}) },
      });

    expect((await record(a, "ok")).status).toBe(200);
    const early = await call(closeSession, { token: auditor.token, params: { id }, body: {} });
    expect(early.status).toBe(409);
    expect(early.body).toMatchObject({
      error: { code: "findings_incomplete", details: { missing: [b, c] } },
    });

    expect((await record(b, "issue", "Tree not found at the recorded spot")).body).toMatchObject({
      sample: { treeId: b, finding: "issue", notes: "Tree not found at the recorded spot" },
    });
    await record(c, "needs_followup");
    const closed = await call(closeSession, {
      token: auditor.token,
      params: { id },
      body: { summary: "One tree missing, one to revisit" },
    });
    expect(closed.status).toBe(200);
    const report = field<JsonValue>(closed.body, "session.report");
    expect(field(closed.body, "session.reportHash")).toBe(reportHash(report));
    expect(report).toMatchObject({
      sessionId: id,
      totals: { ok: 1, issue: 1, needsFollowup: 1 },
      summary: "One tree missing, one to revisit",
      seed: { blockHash: BLOCK.hash, blockNumber: "4242" },
    });
    expect(field(closed.body, "session.status")).toBe("closed");

    // Closed sessions are read-only, and closing again returns the stored report.
    expect((await record(a, "issue")).status).toBe(409);
    const again = await call(closeSession, { token: auditor.token, params: { id }, body: {} });
    expect(again.body).toMatchObject({
      idempotent: true,
      session: { reportHash: field(closed.body, "session.reportHash") },
    });
    const reproduced = await call(reproduce, { params: { id } });
    expect(field(reproduced.body, "reportHash")).toBe(field(closed.body, "session.reportHash"));
  });
});
