import { describe, expect, it } from "vitest";
import { GET as batches } from "@/app/api/carbon/batches/route";
import { GET as holdings } from "@/app/api/carbon/holdings/route";
import { GET as retirement } from "@/app/api/carbon/retirements/[id]/route";
import { POST as estimate } from "@/app/api/operator/carbon/estimate/route";
import { POST as issue } from "@/app/api/operator/carbon/issue/route";
import { POST as setPrice } from "@/app/api/operator/carbon/price/route";
import { GET as report } from "@/app/api/reports/campaign/[address]/route";
import { getChainDeployment } from "@/lib/server/chain";
import { getSupabase } from "@/lib/server/supabase";
import { addBatch, addContribution, addPayout, addRetirement, addTreeEvent } from "../fixtures";
import {
  call,
  createCampaign,
  createTree,
  createUser,
  dbAvailable,
  field,
  randomHash,
} from "../helpers";

const ledger = () => getChainDeployment().carbonLedger.toLowerCase();

async function jobPayload(id: string) {
  const { data } = await getSupabase().from("relayer_jobs").select("payload").eq("id", id).single();
  return data?.payload;
}

describe.skipIf(!dbAvailable)("POST /api/operator/carbon/estimate", () => {
  it("estimates from the species table, stores the method and queues setEstimate", async () => {
    const operator = await createUser("operator");
    // Fixture: 8 mahogany trees (30 kg/yr at 20 years), 36 monthly units. One tree was removed.
    const campaign = await createCampaign();
    await createTree({ campaign, planter: operator.wallet, status: "removed" });

    const res = await call(estimate, { token: operator.token, body: { campaign } });
    expect(res.status).toBe(202);
    // 7 trees × 6.75 kg = 47.25 kg, rounded down to 47 units.
    expect(res.body).toMatchObject({
      estimate: {
        label: "pre-certification",
        units: "47",
        tonnes: "0.047",
        method: {
          model: "linear-maturity-v1",
          kgCo2PerYearMature: "30.00",
          yearsToMaturity: 20,
          treeCount: 7,
          commitmentMonths: 36,
          kgPerTree: "6.75",
          species: { code: "SWIETENIA_MACROPHYLLA" },
        },
      },
      job: { kind: "estimate", status: "pending" },
    });
    expect(await jobPayload(field(res.body, "job.id"))).toEqual({
      campaign,
      estimatedAmount: "47",
    });
    const stored = await getSupabase()
      .from("campaigns")
      .select("estimated_amount::text, estimate_method")
      .eq("address", campaign)
      .single();
    expect(stored.data?.estimated_amount).toBe("47");
    expect(stored.data?.estimate_method).toMatchObject({ treeCount: 7, kgPerTree: "6.75" });
  });

  it("follows the contract: active campaigns only, locked after the first batch", async () => {
    const operator = await createUser("operator");
    const funding = await createCampaign({ status: "funding" });
    const notActive = await call(estimate, { token: operator.token, body: { campaign: funding } });
    expect(notActive.status).toBe(409);
    expect(field(notActive.body, "error.code")).toBe("campaign_not_active");

    const issued = await createCampaign();
    await addBatch(issued, { inventoryUnits: 10n, ledger: ledger() });
    const locked = await call(estimate, { token: operator.token, body: { campaign: issued } });
    expect(locked.status).toBe(409);
    expect(field(locked.body, "error.code")).toBe("estimate_locked");
  });

  it("is operator only and honours Idempotency-Key", async () => {
    const campaign = await createCampaign();
    const donor = await createUser("donor");
    expect((await call(estimate, { token: donor.token, body: { campaign } })).status).toBe(403);

    const operator = await createUser("operator");
    const headers = { "idempotency-key": `estimate-${campaign}` };
    const first = await call(estimate, { token: operator.token, body: { campaign }, headers });
    const second = await call(estimate, { token: operator.token, body: { campaign }, headers });
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({
      job: { id: field(first.body, "job.id") },
      idempotent: true,
    });
  });
});

describe.skipIf(!dbAvailable)("POST /api/operator/carbon/issue", () => {
  const body = (campaign: string) => ({
    campaign,
    registry: "SRN-PPI",
    serialStart: "IDN-2027-000001",
    serialEnd: "IDN-2027-012500",
    vintage: 2027,
    tonnes: "12.5",
  });

  it("queues issueBatch with the amount in carbon units", async () => {
    const operator = await createUser("operator");
    const campaign = await createCampaign({ status: "completed" });
    const res = await call(issue, { token: operator.token, body: body(campaign) });
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({
      issuance: { units: "12500", tonnes: "12.500" },
      job: { kind: "issue" },
    });
    expect(await jobPayload(field(res.body, "job.id"))).toEqual({
      campaign,
      registry: "SRN-PPI",
      serialStart: "IDN-2027-000001",
      serialEnd: "IDN-2027-012500",
      vintage: 2027,
      amount: "12500",
    });
  });

  it("rejects campaigns that never activated, bad tonnes and non-operators", async () => {
    const operator = await createUser("operator");
    const refunding = await createCampaign({ status: "refunding" });
    const res = await call(issue, { token: operator.token, body: body(refunding) });
    expect(res.status).toBe(409);
    expect(field(res.body, "error.code")).toBe("campaign_not_issuable");
    const campaign = await createCampaign();
    expect(
      (await call(issue, { token: operator.token, body: { ...body(campaign), tonnes: "1.2345" } }))
        .status,
    ).toBe(400);
    expect(
      (await call(issue, { token: (await createUser("auditor")).token, body: body(campaign) }))
        .status,
    ).toBe(403);
  });
});

describe.skipIf(!dbAvailable)("POST /api/operator/carbon/price", () => {
  it("queues setPrice for a mirrored batch and honours Idempotency-Key", async () => {
    const operator = await createUser("operator");
    const campaign = await createCampaign();
    const batchId = await addBatch(campaign, { inventoryUnits: 500n, ledger: ledger() });
    const body = { batchId: String(batchId), usdcPerTonne: "2500000" };
    const headers = { "idempotency-key": `price-${batchId}` };
    const res = await call(setPrice, { token: operator.token, body, headers });
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({
      price: { batchId, current: "15000000", requested: "2500000" },
      job: { kind: "set_price", status: "pending" },
      idempotent: false,
    });
    expect(await jobPayload(field(res.body, "job.id"))).toEqual({
      batchId: String(batchId),
      usdcPerTonne: "2500000",
    });
    const again = await call(setPrice, { token: operator.token, body, headers });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ job: { id: field(res.body, "job.id") }, idempotent: true });
  });

  it("404s unknown batches, validates input and is operator only", async () => {
    const operator = await createUser("operator");
    const unknown = await call(setPrice, {
      token: operator.token,
      body: { batchId: "999999999999", usdcPerTonne: "1" },
    });
    expect(unknown.status).toBe(404);
    for (const body of [
      { batchId: "0", usdcPerTonne: "1" },
      { batchId: "1", usdcPerTonne: "1.5" },
      { batchId: "1", usdcPerTonne: 1 },
    ]) {
      expect((await call(setPrice, { token: operator.token, body })).status).toBe(400);
    }
    const donor = await createUser("donor");
    expect(
      (await call(setPrice, { token: donor.token, body: { batchId: "1", usdcPerTonne: "1" } }))
        .status,
    ).toBe(403);
  });
});

describe.skipIf(!dbAvailable)("carbon reads", () => {
  it("lists batches with platform inventory, holdings per holder, and retirement certificates", async () => {
    const donor = await createUser("donor");
    const planter = await createUser("planter");
    const campaign = await createCampaign();
    await createTree({ campaign, planter: planter.wallet });
    const batchId = await addBatch(campaign, {
      holder: donor.wallet,
      holderUnits: 3_000n,
      inventoryUnits: 9_500n,
      ledger: ledger(),
    });
    await getSupabase()
      .from("carbon_reservations")
      .insert({
        campaign_address: campaign,
        holder_address: donor.wallet,
        reserved_amount: "4000" as unknown as number,
        allocated_amount: "3000" as unknown as number,
      });
    const retirementId = await addRetirement(batchId, donor.wallet, 500n);

    const list = await call(batches, { query: { campaign } });
    expect(list.status).toBe(200);
    expect(list.body).toMatchObject({
      batches: [
        {
          batchId,
          label: "issued",
          campaign: { address: campaign, title: "Mahogany for Jakarta" },
          registry: "SRN-PPI",
          units: "12500",
          tonnes: "12.500",
          priceUsdcPerTonne: "15000000",
          inventory: { units: "9500", tonnes: "9.500" },
        },
      ],
    });

    const mine = await call(holdings, { token: donor.token });
    expect(mine.body).toMatchObject({
      reservations: [
        {
          campaign,
          label: "pre-certification",
          reservedUnits: "4000",
          unfilledUnits: "1000",
          unfilledTonnes: "1.000",
        },
      ],
      balances: [{ batchId, label: "issued", units: "3000", tonnes: "3.000", vintage: 2027 }],
      retirements: [
        {
          retirementId,
          units: "500",
          beneficiary: "PT Hijau Lestari",
          registryRetirementStatus: "pending",
        },
      ],
    });
    // Planters hold no carbon.
    expect((await call(holdings, { token: planter.token })).body).toMatchObject({
      reservations: [],
      balances: [],
      retirements: [],
    });

    const cert = await call(retirement, { params: { id: String(retirementId) } });
    expect(cert.status).toBe(200);
    expect(cert.body).toMatchObject({
      certificate: {
        retirementId,
        units: "500",
        tonnes: "0.500",
        holder: donor.wallet,
        batch: { batchId, registry: "SRN-PPI", serialStart: `IDN-${batchId}-0001`, vintage: 2027 },
        campaign: { address: campaign, species: { code: "SWIETENIA_MACROPHYLLA" } },
        trees: { count: 1, list: [expect.objectContaining({ geohash: "qqguwvt" })] },
        registryRetirement: { status: "pending", reference: null },
      },
    });
    expect(JSON.stringify(cert.body)).not.toContain("exact");
    expect((await call(retirement, { params: { id: "0" } })).status).toBe(400);
    expect((await call(retirement, { params: { id: "999999999999" } })).status).toBe(404);
    expect((await call(holdings, {})).status).toBe(401);
  });
});

describe.skipIf(!dbAvailable)("GET /api/reports/campaign/:address", () => {
  it("reports trees, incentives, the estimate with its method, issued credits and evidence hashes", async () => {
    const operator = await createUser("operator");
    const planter = await createUser("planter");
    const donor = await createUser("donor");
    const campaign = await createCampaign();
    await addContribution(campaign, donor.wallet, 1_000_000_000n);
    const treeId = await createTree({ campaign, planter: planter.wallet });
    await createTree({ campaign, planter: planter.wallet, slotId: 2, status: "dead" });
    const plantedHash = randomHash();
    await addTreeEvent(treeId, "planted", { evidenceHash: plantedHash });
    await addTreeEvent(treeId, "flagged", { data: {} });
    await addPayout(campaign, treeId, 0, planter.wallet, 8_750_000n);
    await call(estimate, { token: operator.token, body: { campaign } });
    await addBatch(campaign, { inventoryUnits: 2_000n, ledger: ledger() });

    const res = await call(report, {
      params: { address: campaign.toUpperCase().replace("0X", "0x") },
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      report: {
        campaign: { address: campaign },
        funding: { raised: "1000000000", contributors: 1 },
        trees: { planted: 2, alive: 1, dead: 1, survivalRateBps: 5000, averageAgeDays: 0 },
        incentives: {
          paid: "8750000",
          byMilestone: expect.arrayContaining([{ milestone: 0, payouts: 1, amount: "8750000" }]),
        },
        carbon: {
          estimate: {
            label: "pre-certification",
            units: "54",
            method: { treeCount: 8, kgPerTree: "6.75" },
          },
          issued: { label: "issued", units: "2000", tonnes: "2.000" },
        },
        // Only events that carry an evidence hash.
        evidence: [{ treeId, event: "planted", evidenceHash: plantedHash }],
      },
    });
    expect((await call(report, { params: { address: "0x1234" } })).status).toBe(400);
  });
});
