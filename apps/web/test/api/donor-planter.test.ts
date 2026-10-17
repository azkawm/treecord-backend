import { describe, expect, it } from "vitest";
import { GET as dashboard } from "@/app/api/donor/dashboard/route";
import { GET as planterChallenges } from "@/app/api/planter/challenges/route";
import { GET as planterTrees } from "@/app/api/planter/trees/route";
import { getSupabase } from "@/lib/server/supabase";
import { addContribution, addOpenFlag, addPayout } from "../fixtures";
import {
  call,
  createCampaign,
  createTree,
  createUser,
  dbAvailable,
  field,
  nowSec,
} from "../helpers";

const u256 = (value: string) => value as unknown as number;

describe.skipIf(!dbAvailable)("GET /api/donor/dashboard", () => {
  it("summarizes funding share, tree health, payouts, carbon and open flags per campaign", async () => {
    const donor = await createUser("donor");
    const other = await createUser("donor");
    const planter = await createUser("planter");
    // Fixture campaigns are fully funded at 1000 USDC.
    const campaign = await createCampaign();
    await addContribution(campaign, donor.wallet, 250_000_000n);
    await addContribution(campaign, donor.wallet, 50_000_000n);
    await addContribution(campaign, other.wallet, 700_000_000n);

    const alive = await createTree({ campaign, planter: planter.wallet, slotId: 1 });
    await createTree({ campaign, planter: planter.wallet, slotId: 2, status: "dead" });
    await createTree({ campaign, planter: planter.wallet, slotId: 3, status: "flagged" });
    await createTree({ campaign, planter: planter.wallet, slotId: 4, status: "removed" });
    await addPayout(campaign, alive, 0, planter.wallet, 8_750_000n);
    await addPayout(campaign, alive, 1, planter.wallet, 8_750_000n);
    await addOpenFlag(alive, campaign, other.wallet);

    const db = getSupabase();
    await db
      .from("campaigns")
      .update({ estimated_amount: u256("67") })
      .eq("address", campaign);
    await db.from("carbon_reservations").insert({
      campaign_address: campaign,
      holder_address: donor.wallet,
      reserved_amount: u256("20"),
      allocated_amount: u256("5"),
    });

    const res = await call(dashboard, { token: donor.token });
    expect(res.status).toBe(200);
    const views = field<{ campaign: { address: string } }[]>(res.body, "campaigns");
    expect(views).toHaveLength(1);
    expect(views[0]).toMatchObject({
      campaign: { address: campaign, raised: "1000000000" },
      contributed: "300000000",
      fundingShareBps: 3000,
      trees: {
        planted: 4,
        alive: 1,
        dead: 1,
        flagged: 1,
        removed: 1,
        completed: 0,
        survivalRateBps: 5000,
      },
      payoutsReleased: "17500000",
      carbon: {
        campaignEstimate: { label: "pre-certification", units: "67", tonnes: "0.067" },
        reserved: { label: "pre-certification", units: "20", declined: false },
        issued: { label: "issued", allocatedUnits: "5" },
      },
      openFlags: [expect.objectContaining({ treeId: alive, status: "open" })],
    });
    expect(res.body).toMatchObject({
      wallet: donor.wallet,
      totals: {
        campaigns: 1,
        contributed: "300000000",
        treesPlanted: 4,
        survivalRateBps: 5000,
        openFlags: 1,
      },
    });
  });

  it("is empty for a donor without contributions, and needs the donor or operator role", async () => {
    const res = await call(dashboard, { token: (await createUser("donor")).token });
    expect(res.body).toMatchObject({
      campaigns: [],
      totals: { campaigns: 0, treesPlanted: 0, survivalRateBps: null },
    });
    expect((await call(dashboard, { token: (await createUser("planter")).token })).status).toBe(
      403,
    );
    expect((await call(dashboard, {})).status).toBe(401);
  });
});

describe.skipIf(!dbAvailable)("planter endpoints", () => {
  it("GET /api/planter/trees lists my trees with the next milestone window and amount", async () => {
    const planter = await createUser("planter");
    const campaign = await createCampaign();
    await getSupabase()
      .from("campaigns")
      .update({ per_tree_incentive: u256("10000000") })
      .eq("address", campaign);
    const plantedAt = nowSec() - 100;
    const treeId = await createTree({ campaign, planter: planter.wallet, plantedAtSec: plantedAt });
    await addPayout(campaign, treeId, 0, planter.wallet, 1_000_000n);
    // Someone else's tree is not listed.
    await createTree({ campaign, planter: (await createUser("planter")).wallet, slotId: 2 });

    const res = await call(planterTrees, { token: planter.token });
    expect(res.status).toBe(200);
    const trees = field<{ treeId: number }[]>(res.body, "trees");
    expect(trees.map((t) => t.treeId)).toEqual([treeId]);
    // Time unit 60 s: milestone 1 opens 3 units after planting and closes one unit later.
    expect(trees[0]).toMatchObject({
      status: "alive",
      location: { precision: "exact" },
      nextMilestone: {
        milestone: 1,
        state: "upcoming",
        amount: "1000000",
        opensAt: new Date((plantedAt + 180) * 1000).toISOString(),
        closesAt: new Date((plantedAt + 240) * 1000).toISOString(),
      },
    });
    expect(field(res.body, "trees.0.milestones.0.state")).toBe("paid");
  });

  it("GET /api/planter/challenges lists open challenges on my trees only", async () => {
    const planter = await createUser("planter");
    const auditor = await createUser("auditor");
    const campaign = await createCampaign();
    const treeId = await createTree({ campaign, planter: planter.wallet });
    const db = getSupabase();
    const soon = new Date(Date.now() + 60_000).toISOString();
    await db.from("challenges").insert([
      { tree_id: treeId, code: "K7Q2", issued_by_profile_id: auditor.profileId, expires_at: soon },
      // Expired: not listed.
      {
        tree_id: treeId,
        code: "OLD1",
        issued_by_profile_id: auditor.profileId,
        expires_at: new Date(Date.now() - 1000).toISOString(),
      },
    ]);

    const res = await call(planterChallenges, { token: planter.token });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      challenges: [{ treeId, campaign, code: "K7Q2", expiresAt: expect.any(String) }],
    });
    expect(field<unknown[]>(res.body, "challenges")).toHaveLength(1);
    expect((await call(planterChallenges, { token: auditor.token })).status).toBe(403);
  });
});
