// Demo lifecycle on the seeded campaign: milestone check-ins in real time, a dead tree that is replanted, a
// flagged tree that is removed, the carbon estimate, a mirrored registry issuance, a purchase, a retirement
// and an audit. Prints each step with its transaction links. Safe to run again: finished steps are skipped.
//
//   pnpm demo:lifecycle               wait for each milestone window in real time
//   pnpm demo:lifecycle --fast        anvil only: move chain time forward instead of waiting
//   pnpm demo:lifecycle --until 2     stop the check-ins after milestone 2, then do the carbon steps
import { parseArgs } from "node:util";
import {
  MILESTONE_COUNT,
  MILESTONE_DUE_UNITS,
  carbonLedgerAbi,
  treeRegistryAbi,
} from "@treecord/shared";
import { erc20Abi, parseEventLogs, type Hex } from "viem";
import { DemoApi, waitFor } from "./lib/api.js";
import { chainNow, deployment, sendTx, waitForChainTime, walletFor } from "./lib/chain.js";
import { demoEnv } from "./lib/env.js";
import { submitEvidence } from "./lib/evidence.js";
import { addressLink, fail, info, ok, setLogChain, step, txLink, usdc, warn } from "./lib/log.js";
import { loadState, saveState, type DemoState, type TreeState } from "./lib/state.js";
import { demoUsers, resolveMnemonic } from "./lib/users.js";

/** Tonnes the demo registry issues, the inventory price, and what the buyer purchases and retires. */
const ISSUED_TONNES = "1";
const PRICE_USDC_PER_TONNE = 1_000_000n;
const PURCHASE_UNITS = 200n;

interface MilestoneView {
  milestone: number;
  opensAt: string;
  closesAt: string;
  amount: string | null;
  state: "paid" | "forfeited" | "upcoming" | "open" | "missed";
}
interface PlanterTree {
  treeId: number;
  status: string;
  milestones: MilestoneView[];
}
interface TreeView {
  tree: { status: string; replantDeadline: string | null };
}
interface Batch {
  batchId: number;
  units: string;
  priceUsdcPerTonne: string | null;
  inventory: { units: string; tonnes: string };
  issuedTx: { hash: string } | null;
}
interface Holdings {
  reservations: { campaign: string; reservedUnits: string; allocatedUnits: string }[];
  balances: { batchId: number; units: string; tonnes: string }[];
}

const { values: args } = parseArgs({
  options: {
    fast: { type: "boolean", default: false },
    until: { type: "string", default: String(MILESTONE_COUNT - 1) },
  },
});

async function main() {
  const env = demoEnv();
  setLogChain(env.CHAIN_ID);
  const fast = args.fast ?? false;
  const until = Number(args.until);
  if (!Number.isInteger(until) || until < 1 || until >= MILESTONE_COUNT) {
    throw new Error(`--until must be 1 to ${MILESTONE_COUNT - 1}`);
  }
  if (fast && !env.isAnvil) throw new Error("--fast only works on a local anvil chain");

  const state = loadState(env.CHAIN_ID);
  const campaign = state.campaign;
  if (!campaign || state.trees.length === 0 || state.trees.some((t) => t.treeId === null)) {
    throw new Error("No seeded campaign with planted trees. Run pnpm demo:seed first.");
  }
  const address = campaign.address;
  const users = demoUsers(resolveMnemonic(state));
  const api = new DemoApi(env.apiUrl, env.CHAIN_ID);
  const d = deployment();
  const tree = (role: TreeState["role"]) => {
    const found = state.trees.find((t) => t.role === role);
    if (!found || found.treeId === null) throw new Error(`No ${role} tree in the state file`);
    return { ...found, treeId: found.treeId };
  };
  const treeStatus = async (treeId: number) =>
    (await api.get<TreeView>(null, `/api/trees/${treeId}`)).tree;
  const waitForStatus = (treeId: number, status: string) =>
    waitFor(`tree ${treeId} to be ${status}`, async () => {
      const t = await treeStatus(treeId);
      return t.status === status ? t : null;
    });

  info(
    `Campaign ${addressLink(address)}, time unit ${campaign.timeUnitSeconds} s${fast ? ", fast mode" : ""}`,
  );

  // -------------------------------------------------------------------------
  await once(state, "estimate", "Pre-certification carbon estimate", async () => {
    const res = await api.request<{
      estimate: { units: string; tonnes: string; method: { kgPerTree: string; treeCount: number } };
      job: { id: string };
    }>(users.operator, "POST", "/api/operator/carbon/estimate", {
      body: { campaign: address },
      headers: { "idempotency-key": `demo:estimate:${address}` },
    });
    const { estimate, job } = res.body;
    info(
      `${estimate.method.treeCount} trees × ${estimate.method.kgPerTree} kg over the commitment = ${estimate.tonnes} t (pre-certification)`,
    );
    const done = await api.waitForJob(users.operator, job.id, "setEstimate");
    ok(`CarbonLedger.setEstimate ${txLink(done.txHash)}`);
    for (const donor of [users.corporate, users.individual]) {
      const holdings = await waitFor(`the reservation of ${donor.displayName}`, async () => {
        const h = await api.get<Holdings>(donor, "/api/carbon/holdings");
        return h.reservations.some((r) => r.campaign === address) ? h : null;
      });
      const reservation = holdings.reservations.find((r) => r.campaign === address);
      ok(
        `${donor.displayName} reserves ${reservation?.reservedUnits} kg, pro rata to their contribution`,
      );
    }
  });

  // -------------------------------------------------------------------------
  for (let m = 1; m <= until; m++) {
    await once(
      state,
      `milestone-${m}`,
      `Milestone ${m}: check-ins due month ${MILESTONE_DUE_UNITS[m]}`,
      () => checkIns(m),
    );
    if (m === 1) {
      await once(state, "replant", "A tree dies and is replanted", replant);
      await once(state, "flag", "A donor flags a tree, the operator upholds it", flagTree);
    }
  }

  // -------------------------------------------------------------------------
  await once(
    state,
    "issue",
    "The registry issues credits, the operator mirrors the batch",
    async () => {
      const year = new Date().getUTCFullYear();
      const tag = address.slice(2, 8).toUpperCase();
      const { job } = await api.post<{ job: { id: string } }>(
        users.operator,
        "/api/operator/carbon/issue",
        {
          campaign: address,
          registry: "SRN-PPI",
          serialStart: `IDN-DEMO-${tag}-${year}-000001`,
          serialEnd: `IDN-DEMO-${tag}-${year}-001000`,
          vintage: year,
          tonnes: ISSUED_TONNES,
        },
        { "idempotency-key": `demo:issue:${address}` },
      );
      const done = await api.waitForJob(users.operator, job.id, "issueBatch");
      ok(`CarbonLedger.issueBatch ${ISSUED_TONNES} t ${txLink(done.txHash)}`);
      const batch = await currentBatch();
      info(
        `Batch ${batch.batchId}: reservations are filled first, ${batch.inventory.tonnes} t goes to platform inventory`,
      );
      for (const donor of [users.corporate, users.individual]) {
        const h = await api.get<Holdings>(donor, "/api/carbon/holdings");
        const balance = h.balances.find((b) => b.batchId === batch.batchId);
        ok(`${donor.displayName} now holds ${balance?.tonnes ?? "0.000"} t of issued credits`);
      }
    },
  );

  await once(state, "price", "The operator sets the inventory price", async () => {
    const batch = await currentBatch();
    const { job } = await api.post<{ job: { id: string } }>(
      users.operator,
      "/api/operator/carbon/price",
      { batchId: String(batch.batchId), usdcPerTonne: PRICE_USDC_PER_TONNE.toString() },
      { "idempotency-key": `demo:price:${batch.batchId}` },
    );
    const done = await api.waitForJob(users.operator, job.id, "setPrice");
    await waitFor(
      "the indexer to mirror the price",
      async () => (await currentBatch()).priceUsdcPerTonne,
    );
    ok(`CarbonLedger.setPrice ${usdc(PRICE_USDC_PER_TONNE)} per tonne ${txLink(done.txHash)}`);
  });

  await once(state, "purchase", "A buyer purchases credits from inventory", async () => {
    const batch = await currentBatch();
    const buyer = users.individual;
    const cost = (PURCHASE_UNITS * PRICE_USDC_PER_TONNE + 999n) / 1000n;
    const wallet = walletFor(buyer.account);
    await sendTx(`${buyer.displayName} approves ${usdc(cost)}`, () =>
      wallet.writeContract({
        account: buyer.account,
        chain: wallet.chain,
        address: d.usdc,
        abi: erc20Abi,
        functionName: "approve",
        args: [d.carbonLedger, cost],
      }),
    );
    await sendTx(`${buyer.displayName} buys ${PURCHASE_UNITS} kg from batch ${batch.batchId}`, () =>
      wallet.writeContract({
        account: buyer.account,
        chain: wallet.chain,
        address: d.carbonLedger,
        abi: carbonLedgerAbi,
        functionName: "buy",
        args: [BigInt(batch.batchId), PURCHASE_UNITS],
      }),
    );
    ok(`Paid ${usdc(cost)} to the treasury`);
  });

  await once(state, "retire", "The buyer retires credits for a certificate", async () => {
    const batch = await currentBatch();
    const buyer = users.individual;
    const holdings = await waitFor("the purchase to be mirrored", async () => {
      const h = await api.get<Holdings>(buyer, "/api/carbon/holdings");
      const balance = h.balances.find((b) => b.batchId === batch.batchId);
      return balance && BigInt(balance.units) >= PURCHASE_UNITS ? h : null;
    });
    const units = BigInt(holdings.balances.find((b) => b.batchId === batch.batchId)?.units ?? "0");
    const wallet = walletFor(buyer.account);
    const receipt = await sendTx(`${buyer.displayName} retires ${units} kg`, () =>
      wallet.writeContract({
        account: buyer.account,
        chain: wallet.chain,
        address: d.carbonLedger,
        abi: carbonLedgerAbi,
        functionName: "retire",
        args: [BigInt(batch.batchId), units, "Rina Wijaya (demo)", "Offsetting 2026 travel (demo)"],
      }),
    );
    const [retired] = parseEventLogs({
      abi: carbonLedgerAbi,
      eventName: "Retired",
      logs: receipt.logs,
    });
    if (!retired) throw new Error("Retired event not found");
    const id = retired.args.retirementId.toString();
    const certificate = await waitFor("the retirement certificate", async () => {
      const res = await api.request<{
        certificate: {
          tonnes: string;
          beneficiary: string;
          batch: { serialStart: string; serialEnd: string; vintage: number };
          trees: { count: number };
        };
      }>(null, "GET", `/api/carbon/retirements/${id}`, { allow: [404] });
      return res.status === 200 ? res.body.certificate : null;
    });
    ok(
      `Certificate ${id}: ${certificate.tonnes} t for ${certificate.beneficiary}, serials ${certificate.batch.serialStart} to ${certificate.batch.serialEnd}, vintage ${certificate.batch.vintage}, ${certificate.trees.count} trees`,
    );
    info(`${env.apiUrl}/api/carbon/retirements/${id}`);
  });

  // -------------------------------------------------------------------------
  await once(state, "audit", "An auditor samples trees and closes a session", async () => {
    const auditor = users.auditor;
    const { session } = await api.post<{
      session: {
        id: string;
        seed: { blockNumber: number };
        populationSize: number;
        samples: { treeId: number }[];
      };
    }>(auditor, "/api/audit/sessions", { campaign: address, sampleSize: 2 });
    info(
      `Session ${session.id}: ${session.samples.length} of ${session.populationSize} trees, seeded by block ${session.seed.blockNumber}`,
    );
    for (const sample of session.samples) {
      const bundle = await api.get<{
        submissions: { kind: string; verification: Record<string, boolean | string | null> }[];
      }>(auditor, `/api/audit/sessions/${session.id}/trees/${sample.treeId}`);
      const allValid = bundle.submissions.every(
        (s) =>
          s.verification.signatureValid === true &&
          s.verification.evidenceHashMatches === true &&
          s.verification.videoHashMatches === true,
      );
      ok(
        `Tree ${sample.treeId}: ${bundle.submissions.length} submissions, signatures and hashes ${allValid ? "all verify" : "DO NOT all verify"}`,
      );
      await api.post(auditor, `/api/audit/sessions/${session.id}/findings`, {
        treeId: String(sample.treeId),
        finding: allValid ? "ok" : "issue",
        notes: allValid ? "Evidence trail complete and consistent." : "Evidence did not verify.",
      });
    }
    const closed = await api.post<{ session: { reportHash: string } }>(
      auditor,
      `/api/audit/sessions/${session.id}/close`,
      { summary: "Demo audit: sampled trees verified remotely." },
    );
    ok(`Report hash ${closed.session.reportHash}`);
    const reproduce = await api.get<{ check: { seedMatches: boolean; sampleMatches: boolean } }>(
      null,
      `/api/audit/sessions/${session.id}/reproduce`,
    );
    ok(
      `Anyone can recompute the sample: seed ${reproduce.check.seedMatches ? "matches" : "differs"}, sample ${reproduce.check.sampleMatches ? "matches" : "differs"}`,
    );
  });

  // -------------------------------------------------------------------------
  step("Impact report");
  const { report } = await api.get<{
    report: {
      trees: {
        planted: number;
        alive: number;
        completed: number;
        removed: number;
        survivalRateBps: number;
      };
      incentives: { paid: string; forfeited: string };
      carbon: {
        estimate: { tonnes: string } | null;
        issued: { tonnes: string; retiredUnits: string };
      };
    };
  }>(null, `/api/reports/campaign/${address}`);
  info(
    `Trees: ${report.trees.planted} planted, ${report.trees.alive} alive, ${report.trees.completed} completed, ${report.trees.removed} removed, survival ${(report.trees.survivalRateBps / 100).toFixed(2)}%`,
  );
  info(
    `Incentives: ${usdc(report.incentives.paid)} paid to planters, ${usdc(report.incentives.forfeited)} returned to the pool`,
  );
  info(
    `Carbon: ${report.carbon.estimate?.tonnes ?? "0.000"} t estimated (pre-certification), ${report.carbon.issued.tonnes} t issued, ${report.carbon.issued.retiredUnits} kg retired`,
  );
  info(`Full report: ${env.apiUrl}/api/reports/campaign/${address}`);
  if (until < MILESTONE_COUNT - 1) {
    info(
      `Check-ins stopped after milestone ${until}. Run again with a higher --until to continue.`,
    );
  }

  // -------------------------------------------------------------------------
  // Steps
  // -------------------------------------------------------------------------

  async function checkIns(m: number) {
    const live = state.trees.filter((t) => t.role !== "flagged" || !state.done.includes("flag"));
    const windows = await Promise.all(
      live.map(async (t) => {
        const trees = (
          await api.get<{ trees: PlanterTree[] }>(users[t.planter], "/api/planter/trees")
        ).trees;
        const view = trees.find((x) => x.treeId === t.treeId);
        return { tree: t, view, window: view?.milestones.find((w) => w.milestone === m) };
      }),
    );
    const due = windows.filter((w) => {
      if (!w.view || !w.window) return false;
      if (w.window.state === "paid") {
        ok(`Tree ${w.tree.treeId} milestone ${m} already paid`);
        return false;
      }
      if (
        w.view.status !== "alive" ||
        w.window.state === "missed" ||
        w.window.state === "forfeited"
      ) {
        warn(
          `Tree ${w.tree.treeId} is ${w.view.status} and its milestone ${m} is ${w.window.state}, skipping`,
        );
        return false;
      }
      return true;
    });
    if (due.length === 0) return;

    const opensAt = Math.max(...due.map((w) => Date.parse(w.window?.opensAt ?? "") / 1000));
    const closesAt = Math.min(...due.map((w) => Date.parse(w.window?.closesAt ?? "") / 1000));
    const wait = opensAt - (await chainNow());
    if (wait > 0) {
      info(
        fast
          ? `Moving chain time forward ${Math.ceil(wait)} s to the window`
          : `Window opens in ${Math.ceil(wait)} s (chain time). Waiting...`,
      );
      await waitForChainTime(Math.ceil(opensAt) + 1, fast);
    }
    info(`Window open until ${new Date(closesAt * 1000).toISOString()} (chain time)`);

    await Promise.all(
      due.map(async ({ tree: t, window }) => {
        const planter = users[t.planter];
        const id = await submitEvidence(api, planter, device(t), {
          kind: "ALIVE",
          campaign: address,
          treeId: t.treeId ?? 0,
          milestone: m,
          location: t.location,
        });
        const submission = await api.waitForSubmission(
          planter,
          id,
          `ALIVE tree ${t.treeId} milestone ${m}`,
        );
        ok(
          `Tree ${t.treeId} (${planter.displayName}) alive, score ${submission.policyScore}, paid ${window?.amount ? usdc(window.amount) : "?"}: ${txLink(submission.txHash)}`,
        );
      }),
    );
  }

  async function replant() {
    const t = tree("replanted");
    const planter = users[t.planter];
    const dead = await submitEvidence(api, planter, device(t), {
      kind: "DEAD",
      campaign: address,
      treeId: t.treeId,
      milestone: 0,
      location: t.location,
    });
    const deadSubmission = await api.waitForSubmission(planter, dead, `DEAD tree ${t.treeId}`);
    const deadView = await waitForStatus(t.treeId, "dead");
    ok(`Tree ${t.treeId} is dead: ${txLink(deadSubmission.txHash)}`);
    info(`Replant deadline ${deadView.replantDeadline} (2 time units)`);

    const replanted = await submitEvidence(api, planter, device(t), {
      kind: "REPLANTED",
      campaign: address,
      treeId: t.treeId,
      milestone: 0,
      location: t.location,
    });
    const replantedSubmission = await api.waitForSubmission(
      planter,
      replanted,
      `REPLANTED tree ${t.treeId}`,
    );
    await waitForStatus(t.treeId, "alive");
    ok(
      `Tree ${t.treeId} replanted and alive again, schedule continues from the original planting: ${txLink(replantedSubmission.txHash)}`,
    );
  }

  async function flagTree() {
    const t = tree("flagged");
    const donor = users.individual;
    const flag = await api.post<{ flag: { id: string }; reasonHash: Hex }>(donor, "/api/flags", {
      treeId: String(t.treeId),
      reasonText: "The latest video shows a much older tree than the planting video. Please check.",
    });
    ok(`Reason stored off-chain, hash ${flag.reasonHash}`);
    const current = await treeStatus(t.treeId);
    if (current.status !== "flagged") {
      const wallet = walletFor(donor.account);
      await sendTx(`${donor.displayName} calls TreeRegistry.flag`, () =>
        wallet.writeContract({
          account: donor.account,
          chain: wallet.chain,
          address: d.treeRegistry,
          abi: treeRegistryAbi,
          functionName: "flag",
          args: [BigInt(t.treeId), flag.reasonHash],
        }),
      );
    }
    await waitForStatus(t.treeId, "flagged");
    ok(`Tree ${t.treeId} is flagged. Its payouts and deadlines are paused.`);

    const { job } = await api.post<{ job: { id: string } }>(
      users.operator,
      `/api/operator/flags/${flag.flag.id}/resolve`,
      {
        uphold: true,
        note: "Site visit found a different, older tree at this location. Flag upheld.",
      },
    );
    const done = await api.waitForJob(users.operator, job.id, "resolveFlag");
    await waitForStatus(t.treeId, "removed");
    ok(
      `Flag upheld, tree ${t.treeId} removed. Its unpaid incentives return to the pool: ${txLink(done.txHash)}`,
    );
  }

  async function currentBatch(): Promise<Batch> {
    return waitFor("the issued batch", async () => {
      const { batches } = await api.get<{ batches: Batch[] }>(
        null,
        `/api/carbon/batches?campaign=${address}`,
      );
      return batches[0];
    });
  }

  function device(t: TreeState) {
    const found = state.devices[t.planter];
    if (!found) throw new Error(`No device for ${t.planter}. Run pnpm demo:seed.`);
    return found;
  }
}

/** Runs a named step once. Finished steps are recorded in the state file and skipped on the next run. */
async function once(state: DemoState, id: string, title: string, run: () => Promise<void>) {
  step(title);
  if (state.done.includes(id)) {
    ok("Already done in an earlier run");
    return;
  }
  await run();
  state.done.push(id);
  saveState(state);
}

main().catch(fail);
