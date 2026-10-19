// Demo seed: wallets, profiles, devices, one funded campaign with four planted trees. Everything a user would
// do goes through the real API or the user's own wallet, so every check runs. Safe to run again: finished
// steps are skipped.
//
//   pnpm demo:seed
//
// Needs the web app (with DEMO_WALLET_AUTH=true) and the worker running. See README.md.
import { createClient } from "@supabase/supabase-js";
import {
  DEFAULT_ANCHOR_BPS,
  DEFAULT_PER_PLANTER_CAP,
  DEFAULT_SPLIT,
  MIN_COMMITMENT_UNITS,
  campaignAbi,
  campaignFactoryAbi,
  encodeGeohash,
  geohashToBytes8,
  type Database,
} from "@treecord/shared";
import {
  erc20Abi,
  formatEther,
  parseAbi,
  parseEther,
  parseEventLogs,
  stringToHex,
  type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ApiRequestError, DemoApi, waitFor } from "./lib/api.js";
import { chainNow, deployment, getPublicClient, sendTx, walletFor } from "./lib/chain.js";
import { demoEnv } from "./lib/env.js";
import { submitEvidence, newDevice } from "./lib/evidence.js";
import { addressLink, fail, info, ok, setLogChain, step, txLink, usdc, warn } from "./lib/log.js";
import { loadState, saveState, stateFile, type PlanterKey, type TreeRole } from "./lib/state.js";
import { DEMO_USERS, demoUsers, resolveMnemonic, type DemoUser } from "./lib/users.js";

const SPECIES = "SWIETENIA_MACROPHYLLA";
const REGION_CENTER = { lat: -6.2, lon: 106.816666 };
const REGION_RADIUS_M = 5000;
const TREE_TARGET = 4;
const FUNDING_UNITS = 20;
const CLAIM_UNITS = 40;
/** Extra USDC for the individual donor's carbon purchase in the lifecycle. */
const PURCHASE_BUDGET = 1_000_000n;

/** Which slot each planter takes, and the part the tree plays in the lifecycle. */
const PLAN: {
  role: TreeRole;
  planter: PlanterKey;
  kind: "open" | "anchor";
  offset: [number, number];
}[] = [
  { role: "steady", planter: "planterA", kind: "open", offset: [0.001, 0.001] },
  { role: "anchor", planter: "planterA", kind: "anchor", offset: [0.0012, -0.0008] },
  { role: "replanted", planter: "planterB", kind: "open", offset: [-0.0009, 0.0011] },
  { role: "flagged", planter: "planterC", kind: "open", offset: [-0.0011, -0.001] },
];

const mockUsdcAbi = parseAbi(["function mint(address to, uint256 amount)"]);

interface CampaignView {
  address: string;
  status: string;
  funding: { target: string; raised: string };
}
interface PlanterSlot {
  campaign: { address: string };
  slotId: number;
  kind: "open" | "anchor";
}
interface PlanterTree {
  treeId: number;
  campaign: { address: string };
  slotId: number;
}

async function main() {
  const env = demoEnv();
  setLogChain(env.CHAIN_ID);
  const state = loadState(env.CHAIN_ID);
  const users = demoUsers(resolveMnemonic(state));
  saveState(state);
  const api = new DemoApi(env.apiUrl, env.CHAIN_ID);
  const d = deployment();
  const client = getPublicClient();
  const db = createClient<Database>(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // -------------------------------------------------------------------------
  step(`Demo wallets on chain ${env.CHAIN_ID}`);
  for (const spec of DEMO_USERS) {
    info(`${spec.displayName.padEnd(32)} ${users[spec.key].address}  ${spec.description}`);
  }
  if (state.mnemonic) {
    info(
      `The wallet phrase was generated and saved in ${stateFile(env.CHAIN_ID)}. Keep that file.`,
    );
  }

  // -------------------------------------------------------------------------
  step("Check the chain");
  if (!(await client.getCode({ address: d.campaignFactory }))) {
    throw new Error(
      env.isAnvil
        ? "Treecord is not deployed on this anvil chain. Run pnpm --filter @treecord/contracts deploy:local."
        : `No CampaignFactory at ${d.campaignFactory} on chain ${env.CHAIN_ID}.`,
    );
  }
  if (state.campaign && !(await client.getCode({ address: state.campaign.address }))) {
    throw new Error(
      `Campaign ${state.campaign.address} from ${stateFile(env.CHAIN_ID)} is not on this chain. ` +
        "If a local chain was restarted, run pnpm db:reset, delete that file, and seed again.",
    );
  }
  ok(`Contracts found, factory ${addressLink(d.campaignFactory)}`);

  // -------------------------------------------------------------------------
  step(`Check the API at ${env.apiUrl}`);
  try {
    await api.get(null, "/api/campaigns?limit=1");
  } catch (error) {
    if (error instanceof ApiRequestError) throw error;
    throw new Error(`The API is not reachable at ${env.apiUrl}. Start the web app first.`, {
      cause: error,
    });
  }
  const me = await api.request(users.corporate, "GET", "/api/me", { allow: [401] });
  if (me.status === 401) {
    throw new Error(
      "The API refused wallet sign-in. Set DEMO_WALLET_AUTH=true for the web app and restart it.",
    );
  }
  ok("API is up and accepts wallet sign-in");

  // -------------------------------------------------------------------------
  step("Fund the donor wallets");
  const funder = privateKeyToAccount(env.funderKey);
  const funderWallet = walletFor(funder);
  const target = BigInt(env.DEMO_FUNDING_TARGET);
  const corporateShare = (target * 7n) / 10n;
  const needs: [DemoUser, bigint][] = [
    [users.corporate, corporateShare],
    [users.individual, target - corporateShare + PURCHASE_BUDGET],
  ];
  const ethTarget = parseEther(env.DEMO_DONOR_ETH);
  for (const [donor] of needs) {
    const balance = await client.getBalance({ address: donor.address });
    if (balance >= ethTarget / 2n) {
      ok(`${donor.displayName} has ${formatEther(balance)} ETH for gas`);
      continue;
    }
    await sendTx(`Send ${formatEther(ethTarget - balance)} ETH to ${donor.displayName}`, () =>
      funderWallet.sendTransaction({
        account: funder,
        chain: funderWallet.chain,
        to: donor.address,
        value: ethTarget - balance,
      }),
    );
  }

  const shortfalls: [DemoUser, bigint][] = [];
  for (const [donor, need] of needs) {
    const balance = await client.readContract({
      address: d.usdc,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [donor.address],
    });
    if (balance >= need) ok(`${donor.displayName} has ${usdc(balance)}`);
    else shortfalls.push([donor, need - balance]);
  }
  if (env.isAnvil) {
    for (const [donor, missing] of shortfalls) {
      await sendTx(`Mint ${usdc(missing)} of mock USDC to ${donor.displayName}`, () =>
        funderWallet.writeContract({
          account: funder,
          chain: funderWallet.chain,
          address: d.usdc,
          abi: mockUsdcAbi,
          functionName: "mint",
          args: [donor.address, missing],
        }),
      );
    }
  } else if (shortfalls.length > 0) {
    const total = shortfalls.reduce((sum, [, missing]) => sum + missing, 0n);
    const funderBalance = await client.readContract({
      address: d.usdc,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [funder.address],
    });
    if (funderBalance < total) {
      throw new Error(
        [
          `The funder wallet ${funder.address} has ${usdc(funderBalance)} but the donors need ${usdc(total)}.`,
          "Get test USDC from the Circle faucet:",
          "  1. Open https://faucet.circle.com",
          "  2. Pick USDC and the Base Sepolia network",
          `  3. Paste ${funder.address} and request tokens (repeat later if one request is not enough)`,
          "  4. Run pnpm demo:seed again",
        ].join("\n"),
      );
    }
    for (const [donor, missing] of shortfalls) {
      await sendTx(`Send ${usdc(missing)} to ${donor.displayName}`, () =>
        funderWallet.writeContract({
          account: funder,
          chain: funderWallet.chain,
          address: d.usdc,
          abi: erc20Abi,
          functionName: "transfer",
          args: [donor.address, missing],
        }),
      );
    }
  }

  // -------------------------------------------------------------------------
  step("Profiles and roles");
  for (const spec of DEMO_USERS) {
    const user = users[spec.key];
    const { profile } = await api.get<{ profile: { id: string; role: string } }>(user, "/api/me");
    if (spec.role === "auditor" || spec.role === "operator") {
      // Granted by hand in production. The service role key stands in for that here.
      const { error } = await db
        .from("profiles")
        .update({ role: spec.role, display_name: spec.displayName })
        .eq("id", profile.id);
      if (error) throw new Error(`Could not grant ${spec.role}: ${error.message}`);
    } else {
      await api.post(user, "/api/profile", {
        displayName: spec.displayName,
        ...(spec.role === "planter"
          ? { role: "planter", carbonRightsAgreementAccepted: true }
          : { role: "donor" }),
        ...(spec.buyer ? { isBuyer: true } : {}),
      });
    }
    const check = await api.get<{ role: string }>(user, "/api/me");
    ok(`${spec.displayName} is ${check.role}`);
  }

  // -------------------------------------------------------------------------
  step("Register planter devices");
  for (const key of ["planterA", "planterB", "planterC"] as const) {
    const device = state.devices[key] ?? (await newDevice());
    state.devices[key] = device;
    saveState(state);
    const res = await api.request(users[key], "POST", "/api/devices", {
      body: { publicKeyJwk: device.publicJwk, label: "Demo phone" },
      allow: [409],
    });
    ok(
      `${users[key].displayName}: device ${device.thumbprint.slice(0, 12)}... ${res.status === 409 ? "already registered" : "registered"}`,
    );
  }

  // -------------------------------------------------------------------------
  step("Create the campaign");
  let campaign = state.campaign;
  if (campaign) {
    const existing = await api.request<{ campaign: CampaignView }>(
      null,
      "GET",
      `/api/campaigns/${campaign.address}`,
      { allow: [404] },
    );
    if (existing.status === 404) {
      warn(
        `Campaign ${campaign.address} from the state file is not in the database. Creating a new one.`,
      );
      campaign = undefined;
    } else {
      ok(`Reusing campaign ${addressLink(campaign.address)}`);
    }
  }
  if (!campaign) {
    const metadata = await api.post<{ id: string; metadataURI: string }>(
      users.corporate,
      "/api/campaigns/metadata",
      {
        title: "Mahogany for the Ciliwung riverbank (demo)",
        description:
          "Demo campaign. Four mahogany trees along the Ciliwung river in Jakarta, cared for by local planters.",
        speciesCode: SPECIES,
        regionName: "Jakarta, Ciliwung riverbank",
        regionCenter: REGION_CENTER,
        regionRadiusM: REGION_RADIUS_M,
      },
    );
    ok(`Metadata stored: ${metadata.metadataURI}`);

    const unit = env.DEMO_TIME_UNIT_SECONDS;
    const now = await chainNow();
    const config = {
      creator: users.corporate.address as Address,
      metadataURI: metadata.metadataURI,
      speciesCode: stringToHex(SPECIES, { size: 32 }),
      regionGeohash: geohashToBytes8(encodeGeohash(REGION_CENTER.lat, REGION_CENTER.lon, 7)),
      regionRadiusM: REGION_RADIUS_M,
      treeTarget: TREE_TARGET,
      anchorBps: DEFAULT_ANCHOR_BPS,
      perPlanterCap: DEFAULT_PER_PLANTER_CAP,
      fundingTarget: target,
      fundingDeadline: BigInt(now + FUNDING_UNITS * unit),
      claimDeadline: BigInt(now + CLAIM_UNITS * unit),
      commitmentUnits: MIN_COMMITMENT_UNITS,
      timeUnit: BigInt(unit),
      split: DEFAULT_SPLIT,
    };
    const wallet = walletFor(users.corporate.account);
    const receipt = await sendTx("CampaignFactory.createCampaign by the corporate donor", () =>
      wallet.writeContract({
        account: users.corporate.account,
        chain: wallet.chain,
        address: d.campaignFactory,
        abi: campaignFactoryAbi,
        functionName: "createCampaign",
        args: [config],
      }),
    );
    const [created] = parseEventLogs({
      abi: campaignFactoryAbi,
      eventName: "CampaignCreated",
      logs: receipt.logs,
    });
    if (!created) throw new Error("CampaignCreated event not found");
    campaign = {
      address: created.args.campaign.toLowerCase() as `0x${string}`,
      metadataId: metadata.id,
      regionCenter: REGION_CENTER,
      timeUnitSeconds: unit,
      createdTx: receipt.transactionHash,
    };
    state.campaign = campaign;
    state.campaigns = [...new Set([...state.campaigns, campaign.address])];
    state.trees = [];
    state.done = [];
    saveState(state);
    ok(`Campaign ${addressLink(campaign.address)}, time unit ${unit} s`);
  }
  const address = campaign.address;

  await waitFor("the indexer to mirror the campaign", async () => {
    const res = await api.request(null, "GET", `/api/campaigns/${address}`, { allow: [404] });
    return res.status === 200;
  });
  const marked = await db.from("campaigns").update({ is_demo: true }).eq("address", address);
  if (marked.error) throw new Error(`Could not mark the demo campaign: ${marked.error.message}`);
  ok("Indexer mirrored the campaign. Marked it as demo data for pnpm demo:reset.");

  // -------------------------------------------------------------------------
  step("Fund the campaign to activation");
  let view = (await api.get<{ campaign: CampaignView }>(null, `/api/campaigns/${address}`))
    .campaign;
  if (view.status === "funding") {
    for (const [donor, share] of [
      [users.corporate, corporateShare],
      [users.individual, target - corporateShare],
    ] as const) {
      const already = await client.readContract({
        address,
        abi: campaignAbi,
        functionName: "contributions",
        args: [donor.address],
      });
      if (already >= share) {
        ok(`${donor.displayName} already contributed ${usdc(already)}`);
        continue;
      }
      const amount = share - already;
      const wallet = walletFor(donor.account);
      await sendTx(`${donor.displayName} approves ${usdc(amount)}`, () =>
        wallet.writeContract({
          account: donor.account,
          chain: wallet.chain,
          address: d.usdc,
          abi: erc20Abi,
          functionName: "approve",
          args: [address, amount],
        }),
      );
      await sendTx(`${donor.displayName} contributes ${usdc(amount)}`, () =>
        wallet.writeContract({
          account: donor.account,
          chain: wallet.chain,
          address,
          abi: campaignAbi,
          functionName: "contribute",
          args: [amount],
        }),
      );
    }
  }
  view = await waitFor("the campaign to become active", async () => {
    const { campaign: c } = await api.get<{ campaign: CampaignView }>(
      null,
      `/api/campaigns/${address}`,
    );
    return c.status === "active" ? c : null;
  });
  ok(
    `Active with ${usdc(view.funding.raised)} raised. Fee, seedling and verification buckets went to the treasury.`,
  );

  // -------------------------------------------------------------------------
  step("Claim slots (gasless: the operator wallet sends claimSlotsFor)");
  const slotsOf = async (key: PlanterKey) =>
    (await api.get<{ slots: PlanterSlot[] }>(users[key], "/api/planter/slots")).slots.filter(
      (s) => s.campaign.address === address,
    );
  const treesOf = async (key: PlanterKey) =>
    (await api.get<{ trees: PlanterTree[] }>(users[key], "/api/planter/trees")).trees.filter(
      (t) => t.campaign.address === address,
    );
  const planKind = (role: TreeRole) => PLAN.find((p) => p.role === role)?.kind;
  // Slots still waiting for a tree, plus trees already planted on this planter's slots of that kind.
  const held = async (key: PlanterKey, kind: "open" | "anchor") =>
    (await slotsOf(key)).filter((s) => s.kind === kind).length +
    state.trees.filter((t) => t.planter === key && t.treeId !== null && planKind(t.role) === kind)
      .length;

  for (const entry of PLAN) {
    const planter = users[entry.planter];
    const wanted = PLAN.filter((p) => p.planter === entry.planter && p.kind === entry.kind).length;
    if ((await held(entry.planter, entry.kind)) >= wanted) {
      ok(`${planter.displayName} already holds the ${entry.kind} slot`);
      continue;
    }
    const idempotencyKey = `demo:${entry.kind}:${address}:${entry.planter}`;
    const { job } =
      entry.kind === "open"
        ? await api.post<{ job: { id: string } }>(
            planter,
            `/api/campaigns/${address}/claims`,
            { count: 1 },
            { "idempotency-key": idempotencyKey },
          )
        : await api.post<{ job: { id: string } }>(
            users.operator,
            `/api/operator/campaigns/${address}/anchor-assign`,
            { planter: planter.address, count: 1 },
            { "idempotency-key": idempotencyKey },
          );
    const sender = entry.kind === "open" ? planter : users.operator;
    const done = await api.waitForJob(
      sender,
      job.id,
      `${entry.kind} slot for ${planter.displayName}`,
    );
    ok(
      `${planter.displayName} got an ${entry.kind} slot: ${entry.kind === "open" ? "claimSlotsFor" : "assignAnchorSlots"} ${txLink(done.txHash)}`,
    );
  }

  // -------------------------------------------------------------------------
  step("Plant the trees: signed PLANTED videos through the evidence pipeline");
  for (const key of ["planterA", "planterB", "planterC"] as const) {
    const planned = PLAN.filter((p) => p.planter === key);
    const slots = await waitFor(`slots of ${users[key].displayName}`, async () => {
      const [open, trees] = await Promise.all([slotsOf(key), treesOf(key)]);
      return open.length + trees.length >= planned.length ? open : null;
    });
    for (const slot of slots) {
      const entry = planned.find(
        (p) => p.kind === slot.kind && !state.trees.some((t) => t.role === p.role),
      );
      if (!entry) continue;
      state.trees.push({
        role: entry.role,
        planter: key,
        slotId: slot.slotId,
        treeId: null,
        location: {
          lat: Number((REGION_CENTER.lat + entry.offset[0]).toFixed(6)),
          lon: Number((REGION_CENTER.lon + entry.offset[1]).toFixed(6)),
        },
      });
    }
  }
  saveState(state);

  const unplanted = state.trees.filter((t) => t.treeId === null);
  await Promise.all(
    unplanted.map(async (tree) => {
      const planter = users[tree.planter];
      const device = state.devices[tree.planter];
      if (!device) throw new Error(`No device for ${tree.planter}`);
      const existing = (await treesOf(tree.planter)).find((t) => t.slotId === tree.slotId);
      if (!existing) {
        const id = await submitEvidence(api, planter, device, {
          kind: "PLANTED",
          campaign: address,
          slotId: tree.slotId,
          milestone: 0,
          location: tree.location,
        });
        const submission = await api.waitForSubmission(planter, id, `PLANTED slot ${tree.slotId}`);
        ok(
          `${planter.displayName} planted slot ${tree.slotId} (${tree.role}), score ${submission.policyScore}, ${txLink(submission.txHash)}`,
        );
      }
      const planted = await waitFor(`the tree on slot ${tree.slotId}`, async () =>
        (await treesOf(tree.planter)).find((t) => t.slotId === tree.slotId),
      );
      tree.treeId = planted.treeId;
    }),
  );
  saveState(state);

  // -------------------------------------------------------------------------
  step("Seed complete");
  info(`Campaign: ${addressLink(address)}`);
  for (const tree of state.trees) {
    info(
      `Tree ${tree.treeId} on slot ${tree.slotId}: ${users[tree.planter].displayName}, plays "${tree.role}"`,
    );
  }
  info(`Public report: ${env.apiUrl}/api/reports/campaign/${address}`);
  info("Next: pnpm demo:lifecycle");
}

main().catch(fail);
