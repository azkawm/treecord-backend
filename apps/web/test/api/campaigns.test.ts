import { describe, expect, it } from "vitest";
import { GET as listCampaigns } from "@/app/api/campaigns/route";
import { GET as getCampaign } from "@/app/api/campaigns/[address]/route";
import { POST as postMetadata } from "@/app/api/campaigns/metadata/route";
import { GET as getMetadata } from "@/app/api/campaigns/metadata/[id]/route";
import {
  assignSlots,
  call,
  createCampaign,
  createUser,
  dbAvailable,
  field,
  randomAddress,
} from "../helpers";

const metadata = {
  title: "Mahogany for Jakarta",
  description: "Restoring the Ciliwung riverbank.",
  speciesCode: "SWIETENIA_MACROPHYLLA",
  regionName: "Jakarta",
  regionCenter: { lat: -6.2, lon: 106.816666 },
  regionRadiusM: 5000,
};

describe.skipIf(!dbAvailable)("campaign metadata", () => {
  it("stores metadata and returns a resolvable metadataURI", async () => {
    const donor = await createUser("donor");
    const res = await call(postMetadata, { token: donor.token, body: metadata });
    expect(res.status).toBe(201);
    const id = field<string>(res.body, "id");
    expect(field(res.body, "metadataURI")).toBe(
      `http://localhost:3000/api/campaigns/metadata/${id}`,
    );

    const resolved = await call(getMetadata, { params: { id } });
    expect(resolved.status).toBe(200);
    expect(resolved.body).toMatchObject({
      title: metadata.title,
      species: { code: "SWIETENIA_MACROPHYLLA", localName: "Mahoni" },
      region: { name: "Jakarta", radiusM: 5000 },
      imageUrls: [],
    });
  });

  it("rejects unknown species and non-donors", async () => {
    const donor = await createUser("donor");
    const unknown = await call(postMetadata, {
      token: donor.token,
      body: { ...metadata, speciesCode: "BAMBOO" },
    });
    expect(unknown.status).toBe(400);
    expect(unknown.body).toMatchObject({ error: { code: "unknown_species" } });

    const planter = await createUser("planter");
    const forbidden = await call(postMetadata, { token: planter.token, body: metadata });
    expect(forbidden.status).toBe(403);

    const invalid = await call(postMetadata, {
      token: donor.token,
      body: { ...metadata, regionRadiusM: 10 },
    });
    expect(invalid.status).toBe(400);
    expect(invalid.body).toMatchObject({ error: { code: "validation_error" } });
  });

  it("returns 404 for unknown metadata", async () => {
    const res = await call(getMetadata, { params: { id: "00000000-0000-4000-8000-000000000000" } });
    expect(res.status).toBe(404);
  });
});

describe.skipIf(!dbAvailable)("GET /api/campaigns", () => {
  it("filters by status, species and region, and pages with a cursor", async () => {
    const region = `Region-${Math.random().toString(36).slice(2)}`;
    const active = await createCampaign({ regionName: region, status: "active" });
    const funding = await createCampaign({ regionName: region, status: "funding" });
    const durian = await createCampaign({
      regionName: region,
      status: "active",
      speciesCode: "DURIO_ZIBETHINUS",
    });

    const byRegion = await call(listCampaigns, { query: { region: region.toLowerCase() } });
    expect(byRegion.status).toBe(200);
    const addresses = (byRegion.body.items as { address: string }[]).map((c) => c.address);
    expect(new Set(addresses)).toEqual(new Set([active, funding, durian]));

    const activeOnly = await call(listCampaigns, { query: { region, status: "active" } });
    expect((activeOnly.body.items as { address: string }[]).map((c) => c.address).sort()).toEqual(
      [active, durian].sort(),
    );

    const species = await call(listCampaigns, { query: { region, species: "DURIO_ZIBETHINUS" } });
    expect((species.body.items as { address: string }[]).map((c) => c.address)).toEqual([durian]);

    const page1 = await call(listCampaigns, { query: { region, limit: "2" } });
    expect(page1.body.items).toHaveLength(2);
    const cursor = field<string>(page1.body, "nextCursor");
    expect(cursor).toBe("2");
    const page2 = await call(listCampaigns, { query: { region, limit: "2", cursor } });
    expect(page2.body.items).toHaveLength(1);
    expect(page2.body.nextCursor).toBeNull();
  });

  it("returns money as decimal strings", async () => {
    const region = `Region-${Math.random().toString(36).slice(2)}`;
    await createCampaign({ regionName: region });
    const res = await call(listCampaigns, { query: { region } });
    expect(res.body.items).toEqual([
      expect.objectContaining({
        funding: expect.objectContaining({
          target: "1000000000",
          raised: "1000000000",
          progressBps: 10000,
        }),
        perTreeIncentive: "87500000",
      }),
    ]);
  });

  it("rejects bad filters", async () => {
    expect((await call(listCampaigns, { query: { status: "paused" } })).status).toBe(400);
    expect((await call(listCampaigns, { query: { limit: "1000" } })).status).toBe(400);
    expect((await call(listCampaigns, { query: { cursor: "abc" } })).status).toBe(400);
    expect((await call(listCampaigns, { query: { unknown: "x" } })).status).toBe(400);
  });
});

describe.skipIf(!dbAvailable)("GET /api/campaigns/:address", () => {
  it("returns slot counts and a labeled pre-certification carbon estimate", async () => {
    const campaign = await createCampaign({ estimatedAmount: "12345" });
    const planter = randomAddress();
    await assignSlots(campaign, [
      { slotId: 1, kind: "anchor", planter },
      { slotId: 3, kind: "open", planter },
      { slotId: 4, kind: "open", planter },
    ]);

    const res = await call(getCampaign, {
      params: { address: campaign.toUpperCase().replace("0X", "0x") },
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      campaign: {
        address: campaign,
        slots: {
          total: 8,
          anchor: 2,
          open: 6,
          openClaimed: 2,
          anchorAssigned: 1,
          planted: 0,
          openAvailable: 4,
        },
        carbon: { label: "pre-certification", estimatedUnits: "12345", estimatedTonnes: "12.345" },
      },
    });
  });

  it("returns 404 for unknown campaigns and 400 for bad addresses", async () => {
    expect((await call(getCampaign, { params: { address: randomAddress() } })).status).toBe(404);
    expect((await call(getCampaign, { params: { address: "0x123" } })).status).toBe(400);
  });
});
