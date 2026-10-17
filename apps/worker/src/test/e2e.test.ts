// End to end: anvil + deployed contracts + local Supabase + the worker (indexer, relayer, scoring).
// A donor contribution, a claim job and a planting attestation flow through the chain into the mirror.
// Skips with a warning when anvil, the contract artifacts or the local Supabase stack are missing.
import { randomBytes, randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import {
  Attester,
  ensureJob,
  MockAiClient,
  scoreJobKey,
  type Db,
  type Logger,
} from "@treecord/pipeline";
import {
  campaignAbi,
  campaignFactoryAbi,
  canonicalize,
  CARBON_RIGHTS_AGREEMENT_VERSION,
  DEFAULT_SPLIT,
  geohashToBytes8,
  type Database,
  type EvidencePayload,
  type Json,
} from "@treecord/shared";
import {
  createWalletClient,
  http,
  keccak256,
  parseEventLogs,
  stringToBytes,
  stringToHex,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createChainClients } from "../chain.js";
import { Worker } from "../worker.js";
import {
  ANVIL_KEYS,
  artifactsBuilt,
  findAnvil,
  startLocalChain,
  type LocalChain,
} from "./local-chain.js";

const SUPABASE_URL = process.env.TEST_SUPABASE_URL ?? "http://127.0.0.1:44321";
// The Supabase CLI's public local-development service key, not a secret.
const SUPABASE_KEY =
  process.env.TEST_SUPABASE_SERVICE_ROLE_KEY ??
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";
const ANVIL_PORT = 8547;
const JAKARTA = { lat: -6.2, lon: 106.816666 };

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

const anvil = findAnvil();
const missing = [
  anvil ? null : "anvil (Foundry)",
  artifactsBuilt() ? null : "contract artifacts (pnpm build)",
  (await supabaseUp()) ? null : `Supabase at ${SUPABASE_URL} (pnpm db:start)`,
].filter((m): m is string => m !== null);
if (missing.length > 0) {
  console.warn(`\n⚠ Skipping worker end-to-end test, missing: ${missing.join(", ")}\n`);
}

const silent: Logger = { info: () => {}, warn: () => {}, error: () => {} };

/** Polls until `check` returns a value (not null or undefined), or fails after `timeoutMs`. */
async function waitFor<T>(
  label: string,
  check: () => Promise<T>,
  timeoutMs = 45_000,
): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== null && value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

describe.skipIf(missing.length > 0)("worker end to end on anvil", () => {
  let chain: LocalChain;
  let db: Db;
  let worker: Worker;
  let mirroredCampaign: Address | undefined;
  const cursorName = `indexer:e2e:${randomUUID()}`;
  const created = { profiles: [] as string[], jobs: [] as string[] };

  beforeAll(async () => {
    db = createClient<Database>(SUPABASE_URL, SUPABASE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    chain = await startLocalChain(anvil ?? "anvil", ANVIL_PORT);
  }, 60_000);

  // Removes everything this run mirrored or created. Fresh anvil chains reuse addresses and tree ids, so
  // leftovers would collide with the next run and with the pgTAP tests.
  afterAll(async () => {
    await worker?.stop();
    await chain?.stop();
    if (!db) return;
    await removeCampaign(db, mirroredCampaign);
    if (created.jobs.length > 0) await db.from("relayer_jobs").delete().in("id", created.jobs);
    if (created.profiles.length > 0) await db.from("profiles").delete().in("id", created.profiles);
    await db.from("chain_cursor").delete().eq("name", cursorName);
  }, 30_000);

  it("mirrors a contribution, relays a claim, scores and attests a planting", async () => {
    const { deployment, client } = chain;
    const transport = http(chain.rpcUrl);
    const operator = createWalletClient({
      account: privateKeyToAccount(ANVIL_KEYS.operator),
      chain: foundry,
      transport,
    });
    const donor = createWalletClient({
      account: privateKeyToAccount(ANVIL_KEYS.donor),
      chain: foundry,
      transport,
    });
    const send = async (hash: Promise<Hex>) =>
      client.waitForTransactionReceipt({ hash: await hash });

    // --- A campaign with uploaded metadata (region center from the API, not the geohash cell). ---
    const owner = await insertProfile(db, "operator");
    created.profiles.push(owner.id);
    const metadata = ensure(
      await db
        .from("campaign_metadata")
        .insert({
          creator_profile_id: owner.id,
          title: "Mahogany for Jakarta (e2e)",
          species_code: "SWIETENIA_MACROPHYLLA",
          region_name: "Jakarta",
          region_center_lat: JAKARTA.lat,
          region_center_lon: JAKARTA.lon,
          region_radius_m: 5000,
        })
        .select("id")
        .single(),
    );
    const now = BigInt(Math.floor(Date.now() / 1000));
    const unit = 60n;
    const createdTx = await send(
      operator.writeContract({
        address: deployment.campaignFactory,
        abi: campaignFactoryAbi,
        functionName: "createCampaign",
        args: [
          {
            creator: operator.account.address,
            metadataURI: `http://localhost:3000/api/campaigns/metadata/${metadata.id}`,
            speciesCode: stringToHex("SWIETENIA_MACROPHYLLA", { size: 32 }),
            regionGeohash: geohashToBytes8("qqguwvt"),
            regionRadiusM: 5000,
            treeTarget: 10,
            anchorBps: 2000,
            perPlanterCap: 3,
            fundingTarget: 20_000_000n,
            fundingDeadline: now + 20n * unit,
            claimDeadline: now + 40n * unit,
            commitmentUnits: 36,
            timeUnit: unit,
            split: DEFAULT_SPLIT,
          },
        ],
      }),
    );
    const [createdEvent] = parseEventLogs({
      abi: campaignFactoryAbi,
      eventName: "CampaignCreated",
      logs: createdTx.logs,
    });
    if (!createdEvent) throw new Error("CampaignCreated not emitted");
    const campaign = createdEvent.args.campaign.toLowerCase() as Address;
    mirroredCampaign = campaign;

    // In case an earlier run crashed before its cleanup.
    await removeCampaign(db, campaign);

    worker = new Worker({
      mode: "all",
      db,
      clients: createChainClients({
        rpcUrl: chain.rpcUrl,
        chainId: deployment.chainId,
        operatorKey: ANVIL_KEYS.operator,
        relayerKey: ANVIL_KEYS.relayer,
        pollingIntervalMs: 100,
      }),
      deployment,
      log: silent,
      workerId: `e2e:${process.pid}`,
      scoreDeps: {
        db,
        attester: new Attester(
          ANVIL_KEYS.attester,
          deployment.chainId,
          deployment.verificationGateway,
        ),
        chainNow: async () => Number((await client.getBlock({ blockTag: "latest" })).timestamp),
        ai: new MockAiClient(),
        log: silent,
      },
      indexer: { pollMs: 250, cursorName, confirmations: 2 },
      relayer: { pollMs: 250, receiptTimeoutMs: 20_000 },
      // One pass at start, then the test triggers it. Rows other test suites left in the local database
      // are skipped after their simulations fail, and the high cap keeps them from crowding this tree out.
      scheduler: { intervalMs: 3_600_000, maxCallsPerRun: 1_000 },
    });
    worker.start();

    const mirrored = await waitFor("campaign mirror", async () =>
      ensure(
        await db
          .from("campaigns")
          .select(
            "status, title, species_name, region_center_lat, anchor_slots, open_slots, metadata_id",
          )
          .eq("address", campaign)
          .maybeSingle(),
      ),
    );
    expect(mirrored).toMatchObject({
      status: "funding",
      title: "Mahogany for Jakarta (e2e)",
      species_name: "Swietenia macrophylla",
      region_center_lat: JAKARTA.lat,
      anchor_slots: 2,
      open_slots: 8,
      metadata_id: metadata.id,
    });

    // --- 1. Contribution: the full target activates the campaign. ---
    await send(
      donor.writeContract({
        address: deployment.usdc,
        abi: mockUsdcAbi,
        functionName: "mint",
        args: [donor.account.address, 20_000_000n],
      }),
    );
    await send(
      donor.writeContract({
        address: deployment.usdc,
        abi: mockUsdcAbi,
        functionName: "approve",
        args: [campaign, 20_000_000n],
      }),
    );
    await send(
      donor.writeContract({
        address: campaign,
        abi: campaignAbi,
        functionName: "contribute",
        args: [20_000_000n],
      }),
    );

    const active = await waitFor("campaign activation", async () =>
      ensure(
        await db
          .from("campaigns")
          .select("status, funded_amount::text, per_tree_incentive::text")
          .eq("address", campaign)
          .eq("status", "active")
          .maybeSingle(),
      ),
    );
    expect(active.funded_amount).toBe("20000000");
    const contributions = ensure(
      await db
        .from("contributions")
        .select("contributor_address, amount::text")
        .eq("campaign_address", campaign),
    );
    expect(contributions).toEqual([
      { contributor_address: donor.account.address.toLowerCase(), amount: "20000000" },
    ]);

    // --- 2. Claim job: the operator wallet claims an open slot for a planter who has no gas. ---
    const planter = await insertProfile(db, "planter");
    created.profiles.push(planter.id);
    const claimJob = ensure(
      await db
        .from("relayer_jobs")
        .insert({ kind: "claim", payload: { campaign, planter: planter.wallet, count: 1 } })
        .select("id")
        .single(),
    );
    created.jobs.push(claimJob.id);
    const confirmedClaim = await waitFor("claim job", async () =>
      ensure(
        await db
          .from("relayer_jobs")
          .select("status, tx_hash, attempts")
          .eq("id", claimJob.id)
          .eq("status", "confirmed")
          .maybeSingle(),
      ),
    );
    expect(confirmedClaim.tx_hash).toMatch(/^0x[0-9a-f]{64}$/);
    // Slots 1 and 2 are anchor slots, so the first open slot is 3.
    const slot = await waitFor("claimed slot", async () =>
      ensure(
        await db
          .from("slots")
          .select("slot_id, kind, status, planter_address, claimed_tx")
          .eq("campaign_address", campaign)
          .maybeSingle(),
      ),
    );
    expect(slot).toEqual({
      slot_id: 3,
      kind: "open",
      status: "claimed",
      planter_address: planter.wallet,
      claimed_tx: confirmedClaim.tx_hash,
    });

    // --- 3. Planting: score job → mock AI → policy → attestation job → gateway → mirror. ---
    const submissionId = randomUUID();
    const videoPath = `${planter.id}/${submissionId}.mp4`;
    const video = randomBytes(64);
    const upload = await db.storage
      .from("evidence")
      .upload(videoPath, video, { contentType: "video/mp4", upsert: true });
    if (upload.error) throw upload.error;
    const payload: EvidencePayload = {
      v: 1,
      kind: "PLANTED",
      campaign,
      slotId: "3",
      treeId: null,
      milestone: 0,
      videoSha256: randomBytes(32).toString("hex"),
      lat: -6.2001,
      lon: 106.8168,
      acc: 6,
      capturedAt: new Date().toISOString(),
      challenge: null,
      deviceKey: "A".repeat(43),
    };
    const evidenceHash = `0x${randomBytes(32).toString("hex")}`;
    ensure(
      await db.from("submissions").insert({
        id: submissionId,
        profile_id: planter.id,
        campaign_address: campaign,
        slot_id: 3,
        kind: "PLANTED",
        milestone: 0,
        video_path: videoPath,
        video_sha256: payload.videoSha256,
        size_bytes: video.length,
        duration_sec: 6,
        payload: payload as unknown as Json,
        canonical: canonicalize(payload),
        signature: "A".repeat(86),
        evidence_hash: evidenceHash,
        captured_at: payload.capturedAt,
        status: "checking",
      }),
    );
    created.jobs.push(
      await ensureJob(db, "score", { submissionId }, scoreJobKey(submissionId), planter.id),
    );

    const onchain = await waitFor(
      "submission on-chain",
      async () =>
        ensure(
          await db
            .from("submissions")
            .select("status, tx_hash, policy_decision, attestation_nonce::text")
            .eq("id", submissionId)
            .eq("status", "onchain")
            .maybeSingle(),
        ),
      60_000,
    );
    expect(onchain.policy_decision).toBe("pass");
    expect(onchain.tx_hash).toMatch(/^0x[0-9a-f]{64}$/);

    const attestationJob = ensure(
      await db
        .from("relayer_jobs")
        .select("id, status, tx_hash")
        .eq("kind", "attestation")
        .eq("payload->>nonce", onchain.attestation_nonce ?? "")
        .single(),
    );
    created.jobs.push(attestationJob.id);
    expect(attestationJob).toMatchObject({ status: "confirmed", tx_hash: onchain.tx_hash });

    // The tree mirror carries the exact GPS from the submission (never on-chain) and the public geohash.
    const tree = await waitFor("tree mirror", async () =>
      ensure(
        await db
          .from("trees")
          .select(
            "tree_id, slot_id, status, planter_address, geohash, exact_lat, exact_lon, latest_evidence_hash",
          )
          .eq("campaign_address", campaign)
          .maybeSingle(),
      ),
    );
    expect(tree).toMatchObject({
      slot_id: 3,
      status: "alive",
      planter_address: planter.wallet,
      exact_lat: payload.lat,
      exact_lon: payload.lon,
      latest_evidence_hash: evidenceHash,
    });
    expect(tree.geohash).toMatch(/^qqgu/);

    // Milestone 0 is paid in the planting transaction: 10% of the per-tree incentive.
    const payout = await waitFor("milestone 0 payout", async () =>
      ensure(
        await db
          .from("milestone_payouts")
          .select("milestone, amount::text, planter_address, tx_hash")
          .eq("tree_id", tree.tree_id)
          .maybeSingle(),
      ),
    );
    expect(payout).toEqual({
      milestone: 0,
      amount: ((BigInt(active.per_tree_incentive ?? "0") * 1000n) / 10_000n).toString(),
      planter_address: planter.wallet,
      tx_hash: onchain.tx_hash,
    });
    const planted = ensure(
      await db
        .from("slots")
        .select("status, tree_id")
        .eq("campaign_address", campaign)
        .eq("slot_id", 3)
        .single(),
    );
    expect(planted).toEqual({ status: "planted", tree_id: tree.tree_id });

    // Health and metrics reflect the work.
    const health = worker.health();
    expect(health.loops.filter((l) => !l.healthy)).toEqual([]);
    expect(health.ok).toBe(true);
    expect(worker.metrics.get("relayer.claim.confirmed")).toBeGreaterThanOrEqual(1);
    expect(worker.metrics.get("relayer.attestation.confirmed")).toBeGreaterThanOrEqual(1);
    expect(worker.metrics.get("indexer.events.AttestationAccepted")).toBeGreaterThanOrEqual(1);

    // --- 4. Scheduler: milestone 1 (window 3 to 4 units after planting) closes unpaid and is forfeited. ---
    await client.request({ method: "evm_increaseTime", params: [Number(5n * unit)] } as never);
    await client.request({ method: "evm_mine", params: [] } as never);
    const scheduler = worker.scheduler;
    if (!scheduler) throw new Error("scheduler not running");
    const done = await scheduler.tick();
    expect(done).toContainEqual({ kind: "forfeit", campaign, treeId: tree.tree_id, milestone: 1 });
    // Milestone 2 closes at 7 units, so it is not forfeited yet.
    expect(done.filter((t) => t.kind === "forfeit" && t.treeId === tree.tree_id)).toHaveLength(1);
    const forfeit = await waitFor("milestone 1 forfeit", async () =>
      ensure(
        await db
          .from("milestone_forfeits")
          .select("milestone, amount::text")
          .eq("tree_id", tree.tree_id)
          .maybeSingle(),
      ),
    );
    expect(forfeit).toEqual({
      milestone: 1,
      amount: ((BigInt(active.per_tree_incentive ?? "0") * 1000n) / 10_000n).toString(),
    });
  }, 150_000);
});

// ---------------------------------------------------------------------------

const mockUsdcAbi = [
  {
    type: "function",
    name: "mint",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "value", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

function ensure<T>(result: { data: T; error: { message: string } | null }): NonNullable<T> {
  if (result.error) throw new Error(result.error.message);
  return result.data as NonNullable<T>;
}

async function insertProfile(
  db: Db,
  role: "operator" | "planter",
): Promise<{ id: string; wallet: Address }> {
  const wallet = `0x${randomBytes(20).toString("hex")}` as Address;
  const row = ensure(
    await db
      .from("profiles")
      .insert({
        privy_user_id: `did:privy:e2e-${randomUUID()}`,
        wallet_address: wallet,
        role,
        carbon_rights_agreement_hash:
          role === "planter" ? keccak256(stringToBytes(CARBON_RIGHTS_AGREEMENT_VERSION)) : null,
      })
      .select("id")
      .single(),
  );
  return { id: row.id, wallet };
}

/** Deletes a campaign's submissions (and their files), then the campaign, which cascades to its mirror rows. */
async function removeCampaign(db: Db, campaign: Address | undefined): Promise<void> {
  if (!campaign) return;
  const submissions = ensure(
    await db
      .from("submissions")
      .select("video_path, keyframe_paths")
      .eq("campaign_address", campaign),
  );
  const videos = submissions.flatMap((s) => (s.video_path ? [s.video_path] : []));
  const keyframes = submissions.flatMap((s) => s.keyframe_paths);
  if (videos.length > 0) await db.storage.from("evidence").remove(videos);
  if (keyframes.length > 0) await db.storage.from("keyframes").remove(keyframes);
  ensure(await db.from("submissions").delete().eq("campaign_address", campaign));
  ensure(await db.from("campaigns").delete().eq("address", campaign));
}
