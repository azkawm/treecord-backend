import { decodeGeohash } from "@treecord/shared";
import { keccak256, stringToBytes } from "viem";
import { describe, expect, it } from "vitest";
import { POST as createFlag } from "@/app/api/flags/route";
import { POST as resolveFlag } from "@/app/api/operator/flags/[id]/resolve/route";
import { GET as getTree } from "@/app/api/trees/[treeId]/route";
import { getSupabase } from "@/lib/server/supabase";
import { addContribution, addOpenFlag, addPayout, addTreeEvent } from "../fixtures";
import {
  call,
  createCampaign,
  createTree,
  createUser,
  dbAvailable,
  field,
  nowSec,
  randomHash,
} from "../helpers";

const EXACT = { lat: -6.20012, lon: 106.81671 };

describe.skipIf(!dbAvailable)("GET /api/trees/:treeId", () => {
  async function plantedTree() {
    const planter = await createUser("planter");
    const campaign = await createCampaign();
    await getSupabase()
      .from("campaigns")
      .update({ per_tree_incentive: "10000000" as unknown as number })
      .eq("address", campaign);
    // Planted 4 units (of 60 s) ago: milestone 0 paid, milestone 1 window [180, 240] has just closed.
    const treeId = await createTree({
      campaign,
      planter: planter.wallet,
      exact: EXACT,
      plantedAtSec: nowSec() - 250,
    });
    return { planter, campaign, treeId };
  }

  it("shows the public timeline with the geohash center to anonymous callers", async () => {
    const { planter, campaign, treeId } = await plantedTree();
    const plantedTx = await addTreeEvent(treeId, "planted", { data: { slotId: "1" } });
    await addTreeEvent(treeId, "check_in", {
      evidenceHash: randomHash(),
      data: { checkInCount: 1 },
    });
    await addPayout(campaign, treeId, 0, planter.wallet, 1_000_000n);

    const res = await call(getTree, { params: { treeId: String(treeId) } });
    expect(res.status).toBe(200);
    const center = decodeGeohash("qqguwvt");
    expect(field(res.body, "tree.location")).toEqual({
      precision: "geohash",
      lat: center.lat,
      lon: center.lon,
      geohash: "qqguwvt",
    });
    expect(JSON.stringify(res.body)).not.toContain(String(EXACT.lat));
    expect(field<{ type: string }[]>(res.body, "timeline").map((e) => e.type)).toEqual([
      "planted",
      "check_in",
    ]);
    expect(field(res.body, "timeline.0.tx.hash")).toBe(plantedTx);
    expect(field(res.body, "payouts")).toEqual([
      expect.objectContaining({ milestone: 0, amount: "1000000", planter: planter.wallet }),
    ]);
    expect(
      field<{ milestone: number; state: string; amount: string }[]>(res.body, "milestones").map(
        (m) => [m.milestone, m.state, m.amount],
      ),
    ).toEqual([
      [0, "paid", "1000000"],
      [1, "missed", "1000000"],
      [2, "upcoming", "1000000"],
      [3, "upcoming", "1500000"],
      [4, "upcoming", "1500000"],
      [5, "upcoming", "4000000"],
    ]);
  });

  it("shows exact GPS to the planter, operators and auditors only", async () => {
    const { planter, treeId } = await plantedTree();
    const params = { treeId: String(treeId) };
    for (const user of [planter, await createUser("operator"), await createUser("auditor")]) {
      const res = await call(getTree, { token: user.token, params });
      expect(field(res.body, "tree.location")).toEqual({
        precision: "exact",
        ...EXACT,
        geohash: "qqguwvt",
      });
    }
    const other = await call(getTree, { token: (await createUser("donor")).token, params });
    expect(field(other.body, "tree.location.precision")).toBe("geohash");
  });

  it("validates the id, 404s unknown trees and rejects a bad token", async () => {
    expect((await call(getTree, { params: { treeId: "abc" } })).status).toBe(400);
    expect((await call(getTree, { params: { treeId: "999999999999" } })).status).toBe(404);
    const { treeId } = await plantedTree();
    expect(
      (await call(getTree, { token: "nope", params: { treeId: String(treeId) } })).status,
    ).toBe(401);
  });
});

describe.skipIf(!dbAvailable)("POST /api/flags", () => {
  const reasonText = "The video shows a different tree than last month";

  async function setup() {
    const planter = await createUser("planter");
    const donor = await createUser("donor");
    const campaign = await createCampaign();
    const treeId = await createTree({ campaign, planter: planter.wallet });
    await addContribution(campaign, donor.wallet, 5_000_000n);
    return { donor, campaign, treeId };
  }

  it("stores the text and returns its keccak256 for TreeRegistry.flag", async () => {
    const { donor, treeId } = await setup();
    const res = await call(createFlag, {
      token: donor.token,
      body: { treeId: String(treeId), reasonText },
    });
    expect(res.status).toBe(201);
    const reasonHash = keccak256(stringToBytes(reasonText));
    expect(res.body).toMatchObject({
      flag: { treeId, status: "pending", reasonText, reasonHash },
      reasonHash,
      call: { function: "flag(uint256,bytes32)", args: [String(treeId), reasonHash] },
      idempotent: false,
    });
    const row = await getSupabase()
      .from("flags")
      .select("reason_hash, flagger_address, status")
      .eq("id", field<string>(res.body, "flag.id"))
      .single();
    // The indexer links the on-chain TreeFlagged event to this row by reason_hash.
    expect(row.data).toEqual({
      reason_hash: reasonHash,
      flagger_address: donor.wallet,
      status: "pending",
    });

    const again = await call(createFlag, {
      token: donor.token,
      body: { treeId: String(treeId), reasonText },
    });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({
      flag: { id: field(res.body, "flag.id") },
      idempotent: true,
    });
  });

  it("allows contributors of the tree's campaign only", async () => {
    const { treeId } = await setup();
    const stranger = await createUser("donor");
    const res = await call(createFlag, {
      token: stranger.token,
      body: { treeId: String(treeId), reasonText },
    });
    expect(res.status).toBe(403);
    expect(field(res.body, "error.code")).toBe("not_contributor");
  });

  it("refuses trees the contract cannot flag, and validates input", async () => {
    const { donor, campaign } = await setup();
    const flagged = await createTree({
      campaign,
      planter: donor.wallet,
      slotId: 2,
      status: "flagged",
    });
    const res = await call(createFlag, {
      token: donor.token,
      body: { treeId: String(flagged), reasonText },
    });
    expect(res.status).toBe(409);
    expect(field(res.body, "error.code")).toBe("tree_not_flaggable");

    const short = await call(createFlag, {
      token: donor.token,
      body: { treeId: "1", reasonText: "bad" },
    });
    expect(short.status).toBe(400);
    expect((await call(createFlag, { body: { treeId: "1", reasonText } })).status).toBe(401);
  });
});

describe.skipIf(!dbAvailable)("POST /api/operator/flags/:id/resolve", () => {
  async function openFlag() {
    const planter = await createUser("planter");
    const campaign = await createCampaign();
    const treeId = await createTree({ campaign, planter: planter.wallet, status: "flagged" });
    return { treeId, flagId: await addOpenFlag(treeId, campaign, planter.wallet) };
  }

  it("stores the note and queues resolveFlag with the note's hash", async () => {
    const operator = await createUser("operator");
    const { treeId, flagId } = await openFlag();
    const note = "Site visit confirmed the tree is alive and in place";
    const res = await call(resolveFlag, {
      token: operator.token,
      params: { id: flagId },
      body: { uphold: false, note },
    });
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({
      job: { kind: "resolve_flag", status: "pending" },
      idempotent: false,
    });

    const noteHash = keccak256(stringToBytes(note));
    const job = await getSupabase()
      .from("relayer_jobs")
      .select("payload")
      .eq("id", field<string>(res.body, "job.id"))
      .single();
    expect(job.data?.payload).toEqual({ treeId: String(treeId), uphold: false, noteHash });
    const flag = await getSupabase()
      .from("flags")
      .select("status, resolution_note, note_hash, resolved_by_profile_id")
      .eq("id", flagId)
      .single();
    // Still open until the indexer sees FlagResolved.
    expect(flag.data).toEqual({
      status: "open",
      resolution_note: note,
      note_hash: noteHash,
      resolved_by_profile_id: operator.profileId,
    });

    const same = await call(resolveFlag, {
      token: operator.token,
      params: { id: flagId },
      body: { uphold: false, note },
    });
    expect(same.status).toBe(200);
    expect(same.body).toMatchObject({ job: { id: field(res.body, "job.id") }, idempotent: true });
    const different = await call(resolveFlag, {
      token: operator.token,
      params: { id: flagId },
      body: { uphold: true, note },
    });
    expect(different.status).toBe(409);
    expect(field(different.body, "error.code")).toBe("flag_resolution_pending");
  });

  it("requires an operator and an on-chain flag", async () => {
    const { flagId } = await openFlag();
    const body = { uphold: true, note: "Upheld after review" };
    const donor = await createUser("donor");
    expect(
      (await call(resolveFlag, { token: donor.token, params: { id: flagId }, body })).status,
    ).toBe(403);

    const operator = await createUser("operator");
    const pending = await getSupabase()
      .from("flags")
      .update({ status: "pending", opened_tx: null, opened_at: null })
      .eq("id", flagId);
    expect(pending.error).toBeNull();
    const res = await call(resolveFlag, { token: operator.token, params: { id: flagId }, body });
    expect(res.status).toBe(409);
    expect(field(res.body, "error.code")).toBe("flag_not_open");
    expect(
      (
        await call(resolveFlag, {
          token: operator.token,
          params: { id: crypto.randomUUID() },
          body,
        })
      ).status,
    ).toBe(404);
  });
});
