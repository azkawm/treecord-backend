// Mirror rows the indexer would write, for route tests of the read endpoints.
import type { Json } from "@treecord/shared";
import { getSupabase } from "@/lib/server/supabase";
import { randomHash } from "./helpers";

let block = 1_000;
const eventRow = () => ({
  block_number: ++block,
  block_time: new Date().toISOString(),
  tx_hash: randomHash(),
  log_index: 0,
});

/** uint256 columns are written as decimal strings. */
const u256 = (value: bigint | number) => value.toString() as unknown as number;

async function ok(result: PromiseLike<{ error: { message: string } | null }>) {
  const { error } = await result;
  if (error) throw new Error(error.message);
}

export async function addContribution(campaign: string, contributor: string, amount: bigint) {
  await ok(
    getSupabase()
      .from("contributions")
      .insert({
        campaign_address: campaign,
        contributor_address: contributor,
        amount: u256(amount),
        total_raised_after: u256(amount),
        ...eventRow(),
      }),
  );
}

export async function addTreeEvent(
  treeId: number,
  kind:
    | "planted"
    | "check_in"
    | "died"
    | "replanted"
    | "removed"
    | "flagged"
    | "flag_resolved"
    | "completed",
  options: { evidenceHash?: string; data?: { [key: string]: Json } } = {},
) {
  const row = eventRow();
  await ok(
    getSupabase()
      .from("tree_events")
      .insert({
        tree_id: treeId,
        kind,
        evidence_hash: options.evidenceHash ?? null,
        data: options.data ?? {},
        ...row,
      }),
  );
  return row.tx_hash;
}

export async function addPayout(
  campaign: string,
  treeId: number,
  milestone: number,
  planter: string,
  amount: bigint,
) {
  await ok(
    getSupabase()
      .from("milestone_payouts")
      .insert({
        campaign_address: campaign,
        tree_id: treeId,
        milestone,
        planter_address: planter,
        amount: u256(amount),
        ...eventRow(),
      }),
  );
}

export async function addForfeit(
  campaign: string,
  treeId: number,
  milestone: number,
  amount: bigint,
) {
  await ok(
    getSupabase()
      .from("milestone_forfeits")
      .insert({
        campaign_address: campaign,
        tree_id: treeId,
        milestone,
        amount: u256(amount),
        ...eventRow(),
      }),
  );
}

/** An on-chain (open) flag, as the indexer leaves it after TreeFlagged. */
export async function addOpenFlag(
  treeId: number,
  campaign: string,
  flagger: string,
): Promise<string> {
  const { data, error } = await getSupabase()
    .from("flags")
    .insert({
      tree_id: treeId,
      campaign_address: campaign,
      flagger_address: flagger,
      reason_text: "The tree in the video is not at this location",
      reason_hash: randomHash(),
      status: "open",
      opened_tx: randomHash(),
      opened_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  return data.id;
}

let batchSeq = Math.floor(Date.now() / 1000) * 100;
let retirementSeq = Math.floor(Date.now() / 1000) * 100;

/** An issued batch with an allocation to `holder` and the rest in inventory (the ledger address). */
export async function addBatch(
  campaign: string,
  options: { holder?: string; holderUnits?: bigint; inventoryUnits?: bigint; ledger: string },
): Promise<number> {
  const batchId = ++batchSeq;
  const holderUnits = options.holderUnits ?? 0n;
  const inventoryUnits = options.inventoryUnits ?? 0n;
  const db = getSupabase();
  await ok(
    db.from("carbon_batches").insert({
      batch_id: batchId,
      campaign_address: campaign,
      registry: "SRN-PPI",
      serial_start: `IDN-${batchId}-0001`,
      serial_end: `IDN-${batchId}-0100`,
      vintage: 2027,
      amount: u256(holderUnits + inventoryUnits),
      price_usdc_per_tonne: u256(15_000_000n),
      issued_block: ++block,
      issued_tx: randomHash(),
    }),
  );
  const balances = [
    ...(options.holder && holderUnits > 0n ? [{ holder: options.holder, units: holderUnits }] : []),
    ...(inventoryUnits > 0n ? [{ holder: options.ledger, units: inventoryUnits }] : []),
  ];
  for (const b of balances) {
    await ok(
      db.from("carbon_balances").insert({
        batch_id: batchId,
        holder_address: b.holder,
        amount: u256(b.units),
        updated_block: block,
      }),
    );
  }
  return batchId;
}

export async function addRetirement(
  batchId: number,
  holder: string,
  units: bigint,
): Promise<number> {
  const retirementId = ++retirementSeq;
  await ok(
    getSupabase()
      .from("retirements")
      .insert({
        retirement_id: retirementId,
        batch_id: batchId,
        holder_address: holder,
        amount: u256(units),
        beneficiary: "PT Hijau Lestari",
        purpose: "2026 scope 3 offset",
        retired_at: new Date().toISOString(),
        tx_hash: randomHash(),
        log_index: 0,
      }),
  );
  return retirementId;
}
