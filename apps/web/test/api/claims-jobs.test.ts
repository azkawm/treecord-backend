import { describe, expect, it } from "vitest";
import { POST as claim } from "@/app/api/campaigns/[address]/claims/route";
import { GET as getJob } from "@/app/api/jobs/[id]/route";
import { POST as anchorAssign } from "@/app/api/operator/campaigns/[address]/anchor-assign/route";
import { getSupabase } from "@/lib/server/supabase";
import {
  assignSlots,
  call,
  createCampaign,
  createUser,
  dbAvailable,
  field,
  randomAddress,
} from "../helpers";

/** Default fixture: 8 slots (2 anchor, 6 open), per-planter cap 3, claim window open. */
describe.skipIf(!dbAvailable)("POST /api/campaigns/:address/claims", () => {
  it("enqueues a claim job for the planter's wallet", async () => {
    const planter = await createUser("planter");
    const campaign = await createCampaign();
    const res = await call(claim, {
      token: planter.token,
      params: { address: campaign },
      body: { count: 2 },
    });

    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({
      job: { kind: "claim", status: "pending" },
      idempotent: false,
    });
    const job = await getSupabase()
      .from("relayer_jobs")
      .select("payload")
      .eq("id", field(res.body, "job.id"))
      .single();
    expect(job.data?.payload).toEqual({ campaign, planter: planter.wallet, count: 2 });
  });

  it("enforces the per-planter cap across held slots and queued claims", async () => {
    const planter = await createUser("planter");
    const campaign = await createCampaign();
    await assignSlots(campaign, [{ slotId: 3, kind: "open", planter: planter.wallet }]);

    const first = await call(claim, {
      token: planter.token,
      params: { address: campaign },
      body: { count: 1 },
    });
    expect(first.status).toBe(202);
    // 1 held + 1 queued, cap 3: only 1 more allowed.
    const over = await call(claim, {
      token: planter.token,
      params: { address: campaign },
      body: { count: 2 },
    });
    expect(over.status).toBe(409);
    expect(over.body).toMatchObject({
      error: { code: "planter_cap_exceeded", details: { remaining: 1, cap: 3 } },
    });
  });

  it("enforces open slot availability across all planters", async () => {
    const campaign = await createCampaign({ perPlanterCap: 10 });
    await assignSlots(campaign, [
      { slotId: 3, kind: "open", planter: randomAddress() },
      { slotId: 4, kind: "open", planter: randomAddress() },
    ]);
    const a = await createUser("planter");
    const b = await createUser("planter");
    expect(
      (await call(claim, { token: a.token, params: { address: campaign }, body: { count: 3 } }))
        .status,
    ).toBe(202);
    // 6 open - 2 held - 3 queued = 1 left
    const res = await call(claim, {
      token: b.token,
      params: { address: campaign },
      body: { count: 2 },
    });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      error: { code: "not_enough_slots", details: { available: 1 } },
    });
  });

  it("returns the original job for a repeated Idempotency-Key", async () => {
    const planter = await createUser("planter");
    const campaign = await createCampaign();
    const key = `claim-${crypto.randomUUID()}`;
    const options = {
      token: planter.token,
      params: { address: campaign },
      body: { count: 1 },
      headers: { "idempotency-key": key },
    };

    const first = await call(claim, options);
    const second = await call(claim, options);
    expect(first.status).toBe(202);
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ idempotent: true });
    expect(field(second.body, "job.id")).toBe(field(first.body, "job.id"));

    const jobs = await getSupabase().from("relayer_jobs").select("id").eq("idempotency_key", key);
    expect(jobs.data).toHaveLength(1);

    // The same key from someone else is a conflict, not a leak of the other job.
    const other = await createUser("planter");
    const stolen = await call(claim, { ...options, token: other.token });
    expect(stolen.status).toBe(409);
    expect(stolen.body).toMatchObject({ error: { code: "idempotency_key_reused" } });
  });

  it("rejects claims outside an active campaign's claim window", async () => {
    const planter = await createUser("planter");
    const funding = await createCampaign({ status: "funding" });
    const notActive = await call(claim, {
      token: planter.token,
      params: { address: funding },
      body: { count: 1 },
    });
    expect(notActive.status).toBe(409);
    expect(notActive.body).toMatchObject({ error: { code: "campaign_not_active" } });

    const closed = await createCampaign({ claimDeadline: new Date(Date.now() - 1000) });
    const late = await call(claim, {
      token: planter.token,
      params: { address: closed },
      body: { count: 1 },
    });
    expect(late.status).toBe(409);
    expect(late.body).toMatchObject({ error: { code: "claim_window_closed" } });
  });

  it("checks auth, role, input and campaign existence", async () => {
    const campaign = await createCampaign();
    expect((await call(claim, { params: { address: campaign }, body: { count: 1 } })).status).toBe(
      401,
    );

    const donor = await createUser("donor");
    const forbidden = await call(claim, {
      token: donor.token,
      params: { address: campaign },
      body: { count: 1 },
    });
    expect(forbidden.status).toBe(403);

    const planter = await createUser("planter");
    for (const body of [{ count: 0 }, { count: 51 }, { count: "2" }, {}]) {
      const res = await call(claim, { token: planter.token, params: { address: campaign }, body });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ error: { code: "validation_error" } });
    }
    const missing = await call(claim, {
      token: planter.token,
      params: { address: randomAddress() },
      body: { count: 1 },
    });
    expect(missing.status).toBe(404);
  });
});

describe.skipIf(!dbAvailable)("POST /api/operator/campaigns/:address/anchor-assign", () => {
  it("lets operators assign anchor slots, ignoring the per-planter cap", async () => {
    const operator = await createUser("operator");
    const campaign = await createCampaign({ perPlanterCap: 1 });
    const planter = randomAddress();
    const res = await call(anchorAssign, {
      token: operator.token,
      params: { address: campaign },
      body: { planter: planter.toUpperCase().replace("0X", "0x"), count: 2 },
    });
    expect(res.status).toBe(202);
    const job = await getSupabase()
      .from("relayer_jobs")
      .select("payload")
      .eq("id", field(res.body, "job.id"))
      .single();
    expect(job.data?.payload).toEqual({ campaign, planter, count: 2 });

    const more = await call(anchorAssign, {
      token: operator.token,
      params: { address: campaign },
      body: { planter, count: 1 },
    });
    expect(more.status).toBe(409);
    expect(more.body).toMatchObject({
      error: { code: "not_enough_slots", details: { available: 0 } },
    });
  });

  it("counts unclaimed open slots as available after the claim deadline", async () => {
    const operator = await createUser("operator");
    const campaign = await createCampaign({ claimDeadline: new Date(Date.now() - 1000) });
    await assignSlots(campaign, [{ slotId: 3, kind: "open", planter: randomAddress() }]);
    // 2 anchor + (6 open - 1 claimed) rolled over = 7
    const res = await call(anchorAssign, {
      token: operator.token,
      params: { address: campaign },
      body: { planter: randomAddress(), count: 8 },
    });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: { details: { available: 7 } } });
  });

  it("is operator only", async () => {
    const planter = await createUser("planter");
    const campaign = await createCampaign();
    const res = await call(anchorAssign, {
      token: planter.token,
      params: { address: campaign },
      body: { planter: planter.wallet, count: 1 },
    });
    expect(res.status).toBe(403);
  });
});

describe.skipIf(!dbAvailable)("GET /api/jobs/:id", () => {
  it("shows a job to its creator and operators only", async () => {
    const planter = await createUser("planter");
    const campaign = await createCampaign();
    const created = await call(claim, {
      token: planter.token,
      params: { address: campaign },
      body: { count: 1 },
    });
    const id = field<string>(created.body, "job.id");

    const own = await call(getJob, { token: planter.token, params: { id } });
    expect(own.status).toBe(200);
    expect(own.body).toMatchObject({ job: { id, kind: "claim", status: "pending", attempts: 0 } });
    expect(field(own.body, "job.lastError")).toBeUndefined();

    const other = await createUser("planter");
    expect((await call(getJob, { token: other.token, params: { id } })).status).toBe(404);

    const operator = await createUser("operator");
    const asOperator = await call(getJob, { token: operator.token, params: { id } });
    expect(asOperator.status).toBe(200);
    expect(asOperator.body).toMatchObject({ job: { lastError: null } });
  });
});
