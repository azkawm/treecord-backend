// Writes decoded chain events into the Supabase mirror (docs/database.md).
//
// Every write is idempotent, so a chunk can be applied again after a crash or during the reorg re-scan:
// - event rows are inserted once per (tx_hash, log_index), and a duplicate insert is ignored
// - state columns are set to absolute values carried by the event (totalRaised, checkInCount, ...)
// - values that only exist as deltas on-chain (paused seconds, balances, allocated amounts) are recomputed
//   from the stored event rows instead of being incremented
// Events are applied in chain order, so re-applying a range ends in the same state.
import {
  bytes8ToGeohash,
  decodeGeohash,
  type EvidencePayload,
  type Json,
  type LatLon,
  type TablesUpdate,
} from "@treecord/shared";
import { ensureMaybe, ensureOk, UNIQUE_VIOLATION, type Db, type Logger } from "@treecord/pipeline";
import { hexToString, type Address, type Hex } from "viem";
import type { EventMeta, IndexedEvent } from "./decode.js";

export interface ApplyContext {
  db: Db;
  chainId: number;
  /** Lowercase CarbonLedger address. Platform inventory is held by the ledger itself. */
  carbonLedger: Address;
  /** ISO timestamp of a block. Cached by the caller. */
  blockTime(blockNumber: bigint): Promise<string>;
  log: Logger;
}

type TreeStatus = "alive" | "flagged" | "dead" | "removed" | "completed";

/** uint256 columns are written as decimal strings (docs/database.md). */
const u256 = (value: bigint) => value.toString() as unknown as number;
const lower = <T extends string>(value: T) => value.toLowerCase() as T;
const iso = (seconds: bigint) => new Date(Number(seconds) * 1000).toISOString();

/** Accepts a write result, treating a unique violation as "already recorded". */
function once(result: { error: { code: string; message: string } | null }, context: string): void {
  if (result.error && result.error.code !== UNIQUE_VIOLATION) {
    throw new Error(`Database error during ${context}: ${result.error.message}`);
  }
}

function eventRow(meta: EventMeta) {
  return { block_number: Number(meta.blockNumber), tx_hash: meta.txHash, log_index: meta.logIndex };
}

export async function applyEvent(ctx: ApplyContext, ev: IndexedEvent): Promise<void> {
  switch (ev.source) {
    case "factory":
      if (ev.event.eventName === "CampaignCreated") {
        await onCampaignCreated(ctx, ev.meta, ev.event.args);
      }
      return;
    case "campaign":
      return applyCampaignEvent(ctx, ev.meta, ev.event);
    case "treeRegistry":
      return applyTreeEvent(ctx, ev.meta, ev.event);
    case "gateway":
      if (ev.event.eventName === "AttestationAccepted") {
        await onAttestationAccepted(ctx, ev.meta, ev.event.args.nonce);
      }
      return;
    case "carbonLedger":
      return applyCarbonEvent(ctx, ev.meta, ev.event);
  }
}

// ---------------------------------------------------------------------------
// CampaignFactory
// ---------------------------------------------------------------------------

type CampaignCreatedArgs = Extract<
  Extract<IndexedEvent, { source: "factory" }>["event"],
  { eventName: "CampaignCreated" }
>["args"];

const UUID = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i;

/** The campaign_metadata id at the end of a metadataURI from POST /api/campaigns/metadata, if any. */
export function metadataIdFromUri(uri: string): string | null {
  return UUID.exec(uri)?.[1]?.toLowerCase() ?? null;
}

/** A bytes32 species code such as bytes32("SWIETENIA_MACROPHYLLA") as text. */
export function speciesCodeFromBytes32(value: Hex): string {
  return hexToString(value, { size: 32 }).replace(/\0+$/, "");
}

async function onCampaignCreated(
  ctx: ApplyContext,
  meta: EventMeta,
  args: CampaignCreatedArgs,
): Promise<void> {
  const { db } = ctx;
  const cfg = args.config;
  const address = lower(args.campaign);
  const creator = lower(args.creator);
  const metadataId = metadataIdFromUri(cfg.metadataURI);
  const speciesCode = speciesCodeFromBytes32(cfg.speciesCode);
  let geohash: string;
  try {
    geohash = bytes8ToGeohash(cfg.regionGeohash);
  } catch {
    geohash = "";
  }

  const [metadata, species, creatorProfile] = await Promise.all([
    metadataId
      ? db
          .from("campaign_metadata")
          .select("id, title, description, region_name, region_center_lat, region_center_lon")
          .eq("id", metadataId)
          .maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    db.from("species").select("scientific_name").eq("code", speciesCode).maybeSingle(),
    db.from("profiles").select("id").eq("wallet_address", creator).maybeSingle(),
  ]);
  const metadataRow = ensureMaybe(metadata, "load campaign metadata");
  const speciesRow = ensureMaybe(species, "load species");
  const profile = ensureMaybe(creatorProfile, "load creator profile");

  // The region center comes from the uploaded metadata, or from the on-chain geohash cell.
  let center: LatLon | null = metadataRow
    ? { lat: metadataRow.region_center_lat, lon: metadataRow.region_center_lon }
    : null;
  if (!center && geohash) center = decodeGeohash(geohash);

  const treeTarget = Number(cfg.treeTarget);
  const anchorSlots = Math.floor((treeTarget * cfg.anchorBps) / 10_000);

  ensureMaybe(
    await db.from("campaigns").upsert(
      {
        address,
        chain_id: ctx.chainId,
        creator_address: creator,
        creator_profile_id: profile?.id ?? null,
        metadata_id: metadataRow?.id ?? null,
        title: metadataRow?.title ?? null,
        description: metadataRow?.description ?? null,
        species_code: speciesCode || null,
        species_name: speciesRow?.scientific_name ?? null,
        region_name: metadataRow?.region_name ?? null,
        region_center_lat: center?.lat ?? null,
        region_center_lon: center?.lon ?? null,
        region_radius_m: Number(cfg.regionRadiusM),
        region_geohash: geohash,
        tree_target: treeTarget,
        anchor_slots: anchorSlots,
        open_slots: treeTarget - anchorSlots,
        per_planter_cap: cfg.perPlanterCap,
        funding_target: u256(cfg.fundingTarget),
        funding_deadline: iso(cfg.fundingDeadline),
        claim_deadline: iso(cfg.claimDeadline),
        commitment_units: cfg.commitmentUnits,
        time_unit_seconds: Number(cfg.timeUnit),
        split: {
          incentivesBps: cfg.split.incentivesBps,
          seedlingsBps: cfg.split.seedlingsBps,
          verificationBps: cfg.split.verificationBps,
          reserveBps: cfg.split.reserveBps,
          feeBps: cfg.split.feeBps,
        },
        metadata_uri: cfg.metadataURI,
        created_block: Number(meta.blockNumber),
        created_tx: meta.txHash,
      },
      { onConflict: "address" },
    ),
    "upsert campaign",
  );
  ctx.log.info({ campaign: address, block: Number(meta.blockNumber) }, "campaign indexed");
}

// ---------------------------------------------------------------------------
// Campaign
// ---------------------------------------------------------------------------

async function applyCampaignEvent(
  ctx: ApplyContext,
  meta: EventMeta,
  event: Extract<IndexedEvent, { source: "campaign" }>["event"],
): Promise<void> {
  const { db } = ctx;
  const campaign = meta.address;
  const update = async (changes: TablesUpdate<"campaigns">, context: string) =>
    ensureMaybe(await db.from("campaigns").update(changes).eq("address", campaign), context);

  switch (event.eventName) {
    case "Contributed": {
      const { contributor, amount, totalRaised } = event.args;
      once(
        await db.from("contributions").insert({
          campaign_address: campaign,
          contributor_address: lower(contributor),
          amount: u256(amount),
          total_raised_after: u256(totalRaised),
          block_time: await ctx.blockTime(meta.blockNumber),
          ...eventRow(meta),
        }),
        "insert contribution",
      );
      await update({ funded_amount: u256(totalRaised) }, "update funded amount");
      return;
    }
    case "Activated": {
      const { activatedAt, incentivePool, perTreeIncentive, reserveAmount } = event.args;
      await update(
        {
          status: "active",
          activated_at: iso(activatedAt),
          incentive_pool: u256(incentivePool),
          per_tree_incentive: u256(perTreeIncentive),
          reserve_amount: u256(reserveAmount),
        },
        "activate campaign",
      );
      return;
    }
    case "RefundingStarted":
      await update({ status: "refunding" }, "mark campaign refunding");
      return;
    case "Refunded":
      once(
        await db.from("refunds").insert({
          campaign_address: campaign,
          contributor_address: lower(event.args.contributor),
          amount: u256(event.args.amount),
          block_time: await ctx.blockTime(meta.blockNumber),
          ...eventRow(meta),
        }),
        "insert refund",
      );
      return;
    case "SlotsClaimed":
    case "AnchorSlotsAssigned": {
      const { planter, firstSlotId, count } = event.args;
      const row = ensureOk(
        await db.from("campaigns").select("anchor_slots").eq("address", campaign).single(),
        "load anchor slot count",
      );
      const claimedAt = await ctx.blockTime(meta.blockNumber);
      const first = Number(firstSlotId);
      const slots = Array.from({ length: Number(count) }, (_, i) => first + i).map((slotId) => ({
        campaign_address: campaign,
        slot_id: slotId,
        // Rolled-over open slots assigned by an operator keep their open kind.
        kind: slotId <= row.anchor_slots ? ("anchor" as const) : ("open" as const),
        status: "claimed" as const,
        planter_address: lower(planter),
        claimed_at: claimedAt,
        claimed_tx: meta.txHash,
      }));
      ensureMaybe(
        await db.from("slots").upsert(slots, { onConflict: "campaign_address,slot_id" }),
        "upsert claimed slots",
      );
      return;
    }
    case "SlotPlanted":
      ensureMaybe(
        await db
          .from("slots")
          .update({ status: "planted", tree_id: Number(event.args.treeId) })
          .eq("campaign_address", campaign)
          .eq("slot_id", Number(event.args.slotId)),
        "mark slot planted",
      );
      return;
    case "MilestonePaid": {
      const { treeId, milestone, planter, amount } = event.args;
      once(
        await db.from("milestone_payouts").insert({
          campaign_address: campaign,
          tree_id: Number(treeId),
          milestone,
          planter_address: lower(planter),
          amount: u256(amount),
          block_time: await ctx.blockTime(meta.blockNumber),
          ...eventRow(meta),
        }),
        "insert milestone payout",
      );
      return;
    }
    case "MilestoneForfeited": {
      const { treeId, milestone, amount } = event.args;
      once(
        await db.from("milestone_forfeits").insert({
          campaign_address: campaign,
          tree_id: Number(treeId),
          milestone,
          amount: u256(amount),
          block_time: await ctx.blockTime(meta.blockNumber),
          ...eventRow(meta),
        }),
        "insert milestone forfeit",
      );
      return;
    }
    case "CampaignCompleted":
      await update(
        {
          status: "completed",
          refund_pool: u256(event.args.refundPool),
          completed_at: await ctx.blockTime(meta.blockNumber),
        },
        "complete campaign",
      );
      return;
    default:
      // BucketsReleased, ReserveDrawn and Initialized carry nothing the mirror stores.
      return;
  }
}

// ---------------------------------------------------------------------------
// TreeRegistry
// ---------------------------------------------------------------------------

async function applyTreeEvent(
  ctx: ApplyContext,
  meta: EventMeta,
  event: Extract<IndexedEvent, { source: "treeRegistry" }>["event"],
): Promise<void> {
  const { db } = ctx;

  if (event.eventName === "TreePlanted") {
    await onTreePlanted(ctx, meta, event.args);
    return;
  }

  const treeId = Number(event.args.treeId);
  const tree = ensureMaybe(
    await db.from("trees").select("tree_id, status").eq("tree_id", treeId).maybeSingle(),
    "load tree",
  );
  if (!tree) {
    ctx.log.warn({ treeId, event: event.eventName }, "event for a tree that is not indexed");
    return;
  }

  const setTree = async (changes: TablesUpdate<"trees">, context: string) =>
    ensureMaybe(await db.from("trees").update(changes).eq("tree_id", treeId), context);

  switch (event.eventName) {
    case "CheckInRecorded":
      await recordTreeEvent(ctx, meta, treeId, "check_in", event.args.evidenceHash, {
        checkInCount: event.args.checkInCount,
      });
      await setTree(
        {
          check_in_count: event.args.checkInCount,
          latest_evidence_hash: lower(event.args.evidenceHash),
        },
        "record check-in",
      );
      return;
    case "TreeDied":
      await recordTreeEvent(ctx, meta, treeId, "died", event.args.evidenceHash, {
        replantDeadline: event.args.replantDeadline.toString(),
      });
      await setTree(
        {
          status: "dead",
          replant_deadline: iso(event.args.replantDeadline),
          latest_evidence_hash: lower(event.args.evidenceHash),
        },
        "mark tree dead",
      );
      return;
    case "TreeReplanted":
      await recordTreeEvent(ctx, meta, treeId, "replanted", event.args.evidenceHash, {});
      await setTree(
        {
          status: "alive",
          replant_deadline: null,
          latest_evidence_hash: lower(event.args.evidenceHash),
        },
        "mark tree replanted",
      );
      return;
    case "TreeRemoved": {
      const reason = event.args.reason === 0 ? "replant_expired" : "flag_upheld";
      await recordTreeEvent(ctx, meta, treeId, "removed", null, { reason });
      await setTree({ status: "removed", replant_deadline: null }, "mark tree removed");
      return;
    }
    case "TreeFlagged":
      await onTreeFlagged(
        ctx,
        meta,
        treeId,
        tree.status,
        event.args.flagger,
        event.args.reasonHash,
      );
      return;
    case "FlagResolved":
      await onFlagResolved(ctx, meta, treeId, event.args);
      return;
    case "TreeCompleted":
      await recordTreeEvent(ctx, meta, treeId, "completed", null, {});
      await setTree({ status: "completed" }, "mark tree completed");
      return;
  }
}

type TreePlantedArgs = Extract<
  Extract<IndexedEvent, { source: "treeRegistry" }>["event"],
  { eventName: "TreePlanted" }
>["args"];

async function onTreePlanted(ctx: ApplyContext, meta: EventMeta, args: TreePlantedArgs) {
  const { db } = ctx;
  const evidenceHash = lower(args.evidenceHash);
  // Exact GPS stays off-chain: take it from the planting submission with the same evidence hash.
  const planting = ensureMaybe(
    await db
      .from("submissions")
      .select("payload")
      .eq("evidence_hash", evidenceHash)
      .eq("kind", "PLANTED")
      .limit(1)
      .maybeSingle(),
    "load planting submission",
  );
  const payload = planting?.payload as EvidencePayload | null | undefined;
  let geohash: string;
  try {
    geohash = bytes8ToGeohash(args.geohash);
  } catch {
    geohash = args.geohash;
  }

  const treeId = Number(args.treeId);
  ensureMaybe(
    await db.from("trees").upsert(
      {
        tree_id: treeId,
        campaign_address: lower(args.campaign),
        slot_id: Number(args.slotId),
        planter_address: lower(args.planter),
        planted_at: iso(args.plantedAt),
        geohash,
        exact_lat: payload?.lat ?? null,
        exact_lon: payload?.lon ?? null,
        latest_evidence_hash: evidenceHash,
        planted_tx: meta.txHash,
      },
      { onConflict: "tree_id" },
    ),
    "upsert tree",
  );
  await recordTreeEvent(ctx, meta, treeId, "planted", evidenceHash, {
    slotId: args.slotId.toString(),
  });
}

async function onTreeFlagged(
  ctx: ApplyContext,
  meta: EventMeta,
  treeId: number,
  statusBefore: TreeStatus,
  flagger: Address,
  reasonHash: Hex,
) {
  const { db } = ctx;
  // Remember the status the flag interrupted, so a dismissal can restore it. A replay keeps the first value.
  await recordTreeEvent(ctx, meta, treeId, "flagged", null, {
    flagger: lower(flagger),
    reasonHash: lower(reasonHash),
    previousStatus: statusBefore,
  });
  ensureMaybe(
    await db.from("trees").update({ status: "flagged" }).eq("tree_id", treeId),
    "mark tree flagged",
  );

  const already = ensureMaybe(
    await db.from("flags").select("id").eq("opened_tx", meta.txHash).limit(1).maybeSingle(),
    "find linked flag",
  );
  if (already) return;

  const openedAt = await ctx.blockTime(meta.blockNumber);
  // Link the oldest pending flag the API created with this reason hash.
  const pending = ensureMaybe(
    await db
      .from("flags")
      .select("id")
      .eq("tree_id", treeId)
      .eq("reason_hash", lower(reasonHash))
      .eq("status", "pending")
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle(),
    "find pending flag",
  );
  if (pending) {
    ensureMaybe(
      await db
        .from("flags")
        .update({ status: "open", opened_tx: meta.txHash, opened_at: openedAt })
        .eq("id", pending.id),
      "open flag",
    );
    return;
  }

  // Flagged directly on-chain without the API: keep a row so operators see it.
  const tree = ensureOk(
    await db.from("trees").select("campaign_address").eq("tree_id", treeId).single(),
    "load flagged tree",
  );
  once(
    await db.from("flags").insert({
      tree_id: treeId,
      campaign_address: tree.campaign_address,
      flagger_address: lower(flagger),
      reason_text: "(flagged on-chain without a reason submitted to the app)",
      reason_hash: lower(reasonHash),
      status: "open",
      opened_tx: meta.txHash,
      opened_at: openedAt,
    }),
    "insert on-chain flag",
  );
}

type FlagResolvedArgs = Extract<
  Extract<IndexedEvent, { source: "treeRegistry" }>["event"],
  { eventName: "FlagResolved" }
>["args"];

async function onFlagResolved(
  ctx: ApplyContext,
  meta: EventMeta,
  treeId: number,
  args: FlagResolvedArgs,
) {
  const { db } = ctx;
  await recordTreeEvent(ctx, meta, treeId, "flag_resolved", null, {
    upheld: args.upheld,
    noteHash: lower(args.noteHash),
    pausedSeconds: args.pausedSeconds.toString(),
  });
  ensureMaybe(
    await db
      .from("flags")
      .update({
        status: args.upheld ? "upheld" : "dismissed",
        note_hash: lower(args.noteHash),
        resolved_tx: meta.txHash,
        resolved_at: await ctx.blockTime(meta.blockNumber),
      })
      .eq("tree_id", treeId)
      .eq("status", "open"),
    "resolve flag",
  );
  // An upheld flag is followed by TreeRemoved in the same transaction.
  if (args.upheld) return;

  const restored = treeStateAfterDismissal(await loadTimeline(db, treeId), meta);
  ensureMaybe(
    await db
      .from("trees")
      .update({
        status: restored.status,
        paused_seconds: restored.pausedSeconds,
        ...(restored.status === "dead" && restored.replantDeadlineSec !== null
          ? { replant_deadline: iso(BigInt(restored.replantDeadlineSec)) }
          : {}),
      })
      .eq("tree_id", treeId),
    "restore tree after dismissed flag",
  );
}

export interface TimelineEvent {
  kind: string;
  data: Json;
  block_number: number;
  log_index: number;
}

async function loadTimeline(db: Db, treeId: number): Promise<TimelineEvent[]> {
  return ensureOk(
    await db
      .from("tree_events")
      .select("kind, data, block_number, log_index")
      .eq("tree_id", treeId)
      .order("block_number", { ascending: true })
      .order("log_index", { ascending: true }),
    "load tree timeline",
  );
}

/**
 * Tree state after the dismissal at `at`, rebuilt from the timeline up to and including it, the way
 * TreeRegistry.resolveFlag computes it: the status before the flag comes back, every dismissed flag's
 * duration adds to the pause offset, and a dead tree's replant deadline moves by the durations since it died.
 */
export function treeStateAfterDismissal(
  timeline: TimelineEvent[],
  at: Pick<EventMeta, "blockNumber" | "logIndex">,
): { status: TreeStatus; pausedSeconds: number; replantDeadlineSec: number | null } {
  const atBlock = Number(at.blockNumber);
  let status: TreeStatus = "alive";
  let pausedSeconds = 0;
  let replantDeadlineSec: number | null = null;
  let previousStatus: TreeStatus = "alive";
  for (const e of timeline) {
    if (e.block_number > atBlock || (e.block_number === atBlock && e.log_index > at.logIndex))
      break;
    const data = (e.data ?? {}) as Record<string, Json>;
    switch (e.kind) {
      case "died":
        status = "dead";
        replantDeadlineSec = Number(data.replantDeadline ?? 0);
        break;
      case "replanted":
        status = "alive";
        replantDeadlineSec = null;
        break;
      case "flagged":
        previousStatus = (data.previousStatus as TreeStatus | undefined) ?? status;
        status = "flagged";
        break;
      case "flag_resolved":
        if (data.upheld === true) break;
        pausedSeconds += Number(data.pausedSeconds ?? 0);
        status = previousStatus;
        if (status === "dead" && replantDeadlineSec !== null) {
          replantDeadlineSec += Number(data.pausedSeconds ?? 0);
        }
        break;
      case "removed":
        status = "removed";
        break;
      case "completed":
        status = "completed";
        break;
    }
  }
  return { status, pausedSeconds, replantDeadlineSec };
}

async function recordTreeEvent(
  ctx: ApplyContext,
  meta: EventMeta,
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
  evidenceHash: Hex | null,
  data: { [key: string]: Json },
): Promise<void> {
  once(
    await ctx.db.from("tree_events").insert({
      tree_id: treeId,
      kind,
      evidence_hash: evidenceHash ? lower(evidenceHash) : null,
      data,
      block_time: await ctx.blockTime(meta.blockNumber),
      ...eventRow(meta),
    }),
    "insert tree event",
  );
}

// ---------------------------------------------------------------------------
// VerificationGateway
// ---------------------------------------------------------------------------

/** The submission with this nonce is on-chain. Its attestation job is confirmed too, if the relayer missed it. */
async function onAttestationAccepted(ctx: ApplyContext, meta: EventMeta, nonce: bigint) {
  const { db } = ctx;
  const value = nonce.toString();
  const updated = ensureMaybe(
    await db
      .from("submissions")
      .update({ status: "onchain", tx_hash: meta.txHash, error: null })
      .eq("attestation_nonce", value as unknown as number)
      .in("status", ["attested", "failed", "onchain"])
      .select("id"),
    "mark submission on-chain",
  );
  ensureMaybe(
    await db
      .from("relayer_jobs")
      .update({ status: "confirmed", tx_hash: meta.txHash, last_error: null })
      .eq("kind", "attestation")
      .eq("payload->>nonce", value)
      .neq("status", "confirmed"),
    "confirm attestation job",
  );
  if (!updated || updated.length === 0) {
    ctx.log.warn({ nonce: value, tx: meta.txHash }, "attestation accepted for an unknown nonce");
  }
}

// ---------------------------------------------------------------------------
// CarbonLedger
// ---------------------------------------------------------------------------

async function applyCarbonEvent(
  ctx: ApplyContext,
  meta: EventMeta,
  event: Extract<IndexedEvent, { source: "carbonLedger" }>["event"],
): Promise<void> {
  const { db } = ctx;
  switch (event.eventName) {
    case "EstimateSet":
      ensureMaybe(
        await db
          .from("campaigns")
          .update({ estimated_amount: u256(event.args.estimatedAmount) })
          .eq("address", lower(event.args.campaign)),
        "store estimate",
      );
      return;
    case "Reserved":
      ensureMaybe(
        await db.from("carbon_reservations").upsert(
          {
            campaign_address: lower(event.args.campaign),
            holder_address: lower(event.args.holder),
            reserved_amount: u256(event.args.amount),
          },
          { onConflict: "campaign_address,holder_address" },
        ),
        "upsert reservation",
      );
      return;
    case "ReservationDeclined": {
      // The contract shrinks the reservation to what was already allocated.
      const campaign = lower(event.args.campaign);
      const holder = lower(event.args.holder);
      const allocated = await allocatedFor(db, campaign, holder);
      ensureMaybe(
        await db
          .from("carbon_reservations")
          .update({
            reserved_amount: u256(allocated),
            allocated_amount: u256(allocated),
            declined: true,
          })
          .eq("campaign_address", campaign)
          .eq("holder_address", holder),
        "decline reservation",
      );
      return;
    }
    case "BatchIssued": {
      const a = event.args;
      ensureMaybe(
        await db.from("carbon_batches").upsert(
          {
            batch_id: Number(a.batchId),
            campaign_address: lower(a.campaign),
            registry: a.registry,
            serial_start: a.serialStart,
            serial_end: a.serialEnd,
            vintage: a.vintage,
            amount: u256(a.amount),
            issued_block: Number(meta.blockNumber),
            issued_tx: meta.txHash,
          },
          { onConflict: "batch_id" },
        ),
        "upsert carbon batch",
      );
      return;
    }
    case "Allocated": {
      const batchId = Number(event.args.batchId);
      const holder = lower(event.args.holder);
      once(
        await db.from("carbon_allocations").insert({
          batch_id: batchId,
          holder_address: holder,
          amount: u256(event.args.amount),
          ...eventRow(meta),
        }),
        "insert allocation",
      );
      await refreshBalance(ctx, batchId, holder, meta.blockNumber);
      if (holder !== ctx.carbonLedger) {
        const batch = ensureOk(
          await db
            .from("carbon_batches")
            .select("campaign_address")
            .eq("batch_id", batchId)
            .single(),
          "load batch campaign",
        );
        const allocated = await allocatedFor(db, batch.campaign_address, holder);
        ensureMaybe(
          await db
            .from("carbon_reservations")
            .update({ allocated_amount: u256(allocated) })
            .eq("campaign_address", batch.campaign_address)
            .eq("holder_address", holder),
          "update allocated amount",
        );
      }
      return;
    }
    case "PriceSet":
      ensureMaybe(
        await db
          .from("carbon_batches")
          .update({ price_usdc_per_tonne: u256(event.args.usdcPerTonne) })
          .eq("batch_id", Number(event.args.batchId)),
        "set batch price",
      );
      return;
    case "Purchased": {
      const batchId = Number(event.args.batchId);
      const buyer = lower(event.args.buyer);
      once(
        await db.from("carbon_purchases").insert({
          batch_id: batchId,
          buyer_address: buyer,
          amount: u256(event.args.amount),
          usdc_paid: u256(event.args.usdcPaid),
          block_time: await ctx.blockTime(meta.blockNumber),
          ...eventRow(meta),
        }),
        "insert purchase",
      );
      await refreshBalance(ctx, batchId, buyer, meta.blockNumber);
      await refreshBalance(ctx, batchId, ctx.carbonLedger, meta.blockNumber);
      return;
    }
    case "Retired": {
      const a = event.args;
      const holder = lower(a.holder);
      once(
        await db.from("retirements").insert({
          retirement_id: Number(a.retirementId),
          batch_id: Number(a.batchId),
          holder_address: holder,
          amount: u256(a.amount),
          beneficiary: a.beneficiary,
          purpose: a.purpose,
          retired_at: await ctx.blockTime(meta.blockNumber),
          tx_hash: meta.txHash,
          log_index: meta.logIndex,
        }),
        "insert retirement",
      );
      await refreshBalance(ctx, Number(a.batchId), holder, meta.blockNumber);
      return;
    }
    default:
      // ERC-1155 TransferSingle, ApprovalForAll and URI: balances are rebuilt from the events above.
      return;
  }
}

async function sumAmounts(
  query: PromiseLike<{ data: { amount: string }[] | null; error: { message: string } | null }>,
  context: string,
): Promise<bigint> {
  const { data, error } = await query;
  if (error) throw new Error(`Database error during ${context}: ${error.message}`);
  return (data ?? []).reduce((sum, row) => sum + BigInt(row.amount), 0n);
}

/** Credits allocated to a holder across every batch of a campaign. */
async function allocatedFor(db: Db, campaign: string, holder: string): Promise<bigint> {
  const batches = ensureOk(
    await db.from("carbon_batches").select("batch_id").eq("campaign_address", campaign),
    "load campaign batches",
  );
  if (batches.length === 0) return 0n;
  return sumAmounts(
    db
      .from("carbon_allocations")
      .select("amount::text")
      .eq("holder_address", holder)
      .in(
        "batch_id",
        batches.map((b) => b.batch_id),
      ),
    "sum allocations",
  );
}

/**
 * Rebuilds one balance from the event tables: allocations plus purchases minus retirements, and for platform
 * inventory (the ledger) minus everything sold. These are the only ways CarbonLedger moves credits.
 */
async function refreshBalance(ctx: ApplyContext, batchId: number, holder: string, block: bigint) {
  const { db } = ctx;
  const [allocated, bought, retired, sold] = await Promise.all([
    sumAmounts(
      db
        .from("carbon_allocations")
        .select("amount::text")
        .eq("batch_id", batchId)
        .eq("holder_address", holder),
      "sum allocations",
    ),
    sumAmounts(
      db
        .from("carbon_purchases")
        .select("amount::text")
        .eq("batch_id", batchId)
        .eq("buyer_address", holder),
      "sum purchases",
    ),
    sumAmounts(
      db
        .from("retirements")
        .select("amount::text")
        .eq("batch_id", batchId)
        .eq("holder_address", holder),
      "sum retirements",
    ),
    holder === ctx.carbonLedger
      ? sumAmounts(
          db.from("carbon_purchases").select("amount::text").eq("batch_id", batchId),
          "sum sales",
        )
      : Promise.resolve(0n),
  ]);
  const balance = allocated + bought - retired - sold;
  ensureMaybe(
    await db.from("carbon_balances").upsert(
      {
        batch_id: batchId,
        holder_address: holder,
        amount: u256(balance < 0n ? 0n : balance),
        updated_block: Number(block),
      },
      { onConflict: "batch_id,holder_address" },
    ),
    "upsert carbon balance",
  );
}
