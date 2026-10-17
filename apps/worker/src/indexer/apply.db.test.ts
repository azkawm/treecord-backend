// The indexer's flag handling against the local Supabase: linking by reason hash, dismissal, on-chain-only
// flags. Skips when Supabase is not running. Only calls applyEvent, so it is safe next to other suites.
import { randomBytes, randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import type { Db, Logger } from "@treecord/pipeline";
import type { Database } from "@treecord/shared";
import { keccak256, stringToBytes, type Address, type Hex } from "viem";
import { afterAll, describe, expect, it } from "vitest";
import { applyEvent, type ApplyContext } from "./apply.js";
import type { IndexedEvent } from "./decode.js";

const SUPABASE_URL = process.env.TEST_SUPABASE_URL ?? "http://127.0.0.1:44321";
// The Supabase CLI's public local-development service key, not a secret.
const SUPABASE_KEY =
  process.env.TEST_SUPABASE_SERVICE_ROLE_KEY ??
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";

async function supabaseUp(): Promise<boolean> {
  try {
    const response = await fetch(`${SUPABASE_URL}/rest/v1/species?select=code&limit=1`, {
      headers: { apikey: SUPABASE_KEY, authorization: `Bearer ${SUPABASE_KEY}` },
      signal: AbortSignal.timeout(2000),
    });
    return response.ok;
  } catch {
    return false;
  }
}
const available = await supabaseUp();

const hex = (bytes: number) => `0x${randomBytes(bytes).toString("hex")}` as Hex;
const silent: Logger = { info: () => {}, warn: () => {}, error: () => {} };

describe.skipIf(!available)("indexer flag handling (local Supabase)", () => {
  const db: Db = createClient<Database>(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const campaign = hex(20).toLowerCase() as Address;
  const registry = hex(20).toLowerCase() as Address;
  const blockTime = new Date().toISOString();
  const ctx: ApplyContext = {
    db,
    chainId: 31337,
    carbonLedger: hex(20).toLowerCase() as Address,
    blockTime: async () => blockTime,
    log: silent,
  };
  let block = 100n;
  const meta = () => ({ address: registry, blockNumber: ++block, logIndex: 0, txHash: hex(32) });

  afterAll(async () => {
    await db.from("campaigns").delete().eq("address", campaign);
  });

  async function setup() {
    const exists = await db
      .from("campaigns")
      .select("address")
      .eq("address", campaign)
      .maybeSingle();
    if (!exists.data) {
      const { error } = await db.from("campaigns").insert({
        address: campaign,
        chain_id: 31337,
        creator_address: hex(20).toLowerCase(),
        status: "active",
        region_radius_m: 5000,
        region_geohash: "qqguwvt",
        tree_target: 10,
        anchor_slots: 2,
        open_slots: 8,
        per_planter_cap: 3,
        funding_target: "1000" as unknown as number,
        funding_deadline: blockTime,
        claim_deadline: blockTime,
        commitment_units: 36,
        time_unit_seconds: 60,
        split: {},
        metadata_uri: "treecord://test",
        created_block: 1,
        created_tx: hex(32).toLowerCase(),
      });
      if (error) throw new Error(error.message);
    }
    const treeId = Date.now() * 1000 + Math.floor(Math.random() * 1000);
    const { error } = await db.from("trees").insert({
      tree_id: treeId,
      campaign_address: campaign,
      slot_id: Math.floor(Math.random() * 1_000_000) + 1,
      planter_address: hex(20).toLowerCase(),
      planted_at: blockTime,
      geohash: "qqguwvt",
      latest_evidence_hash: hex(32).toLowerCase(),
      planted_tx: hex(32).toLowerCase(),
    });
    if (error) throw new Error(error.message);
    return treeId;
  }

  const flagged = (treeId: number, flagger: Address, reasonHash: Hex): IndexedEvent => ({
    source: "treeRegistry",
    meta: meta(),
    event: { eventName: "TreeFlagged", args: { treeId: BigInt(treeId), flagger, reasonHash } },
  });
  const resolved = (treeId: number, upheld: boolean, pausedSeconds: bigint): IndexedEvent => ({
    source: "treeRegistry",
    meta: meta(),
    event: {
      eventName: "FlagResolved",
      args: { treeId: BigInt(treeId), upheld, noteHash: hex(32), pausedSeconds },
    },
  });

  it("links TreeFlagged to the pending API flag by keccak256(reasonText), then applies a dismissal", async () => {
    const treeId = await setup();
    const flagger = hex(20).toLowerCase() as Address;
    const reasonText = `Tree looks dead in the latest video ${randomUUID()}`;
    // What POST /api/flags stores.
    const reasonHash = keccak256(stringToBytes(reasonText));
    const inserted = await db
      .from("flags")
      .insert({
        tree_id: treeId,
        campaign_address: campaign,
        flagger_address: flagger,
        reason_text: reasonText,
        reason_hash: reasonHash,
      })
      .select("id")
      .single();
    if (inserted.error) throw new Error(inserted.error.message);

    const ev = flagged(treeId, flagger, reasonHash);
    await applyEvent(ctx, ev);
    // Applying the same event again (re-scan) changes nothing.
    await applyEvent(ctx, ev);

    const flag = await db
      .from("flags")
      .select("status, opened_tx, reason_text")
      .eq("id", inserted.data.id)
      .single();
    expect(flag.data).toEqual({
      status: "open",
      opened_tx: ev.meta.txHash,
      reason_text: reasonText,
    });
    const flags = await db.from("flags").select("id").eq("tree_id", treeId);
    expect(flags.data).toHaveLength(1);
    const tree = await db.from("trees").select("status").eq("tree_id", treeId).single();
    expect(tree.data?.status).toBe("flagged");

    await applyEvent(ctx, resolved(treeId, false, 90n));
    const after = await db.from("flags").select("status").eq("id", inserted.data.id).single();
    expect(after.data?.status).toBe("dismissed");
    const restored = await db
      .from("trees")
      .select("status, paused_seconds")
      .eq("tree_id", treeId)
      .single();
    expect(restored.data).toEqual({ status: "alive", paused_seconds: 90 });
  });

  it("does not link a flag whose hash differs, and records an on-chain-only flag instead", async () => {
    const treeId = await setup();
    const flagger = hex(20).toLowerCase() as Address;
    await db.from("flags").insert({
      tree_id: treeId,
      campaign_address: campaign,
      flagger_address: flagger,
      reason_text: "Some other reason entirely",
      reason_hash: keccak256(stringToBytes("Some other reason entirely")),
    });

    const onChainHash = hex(32).toLowerCase() as Hex;
    await applyEvent(ctx, flagged(treeId, flagger, onChainHash));
    const rows = await db
      .from("flags")
      .select("status, reason_hash")
      .eq("tree_id", treeId)
      .order("created_at");
    expect(rows.data).toEqual([
      { status: "pending", reason_hash: keccak256(stringToBytes("Some other reason entirely")) },
      { status: "open", reason_hash: onChainHash },
    ]);
  });
});
