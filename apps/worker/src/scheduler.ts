// Maintenance calls the contracts leave to "anyone" (prompt 9), sent by the operator wallet once a minute:
// - Campaign.forfeitMilestone for milestone windows that closed unpaid
// - TreeRegistry.expireDead for dead trees whose replant deadline passed
// - TreeRegistry.markCompleted for alive trees with every milestone settled
// - Campaign.complete for campaigns whose trees are all settled after the commitment period
// Candidates come from the mirror and every call is simulated first, so a stale mirror only costs a
// simulation. Calls are sent back to back with local nonces and their receipts awaited together.
import { ensureOk, type Db, type Logger } from "@treecord/pipeline";
import {
  campaignAbi,
  MILESTONE_COUNT,
  MILESTONE_DUE_UNITS,
  MILESTONE_WINDOW_UNITS,
  treeRegistryAbi,
  type TreecordDeployment,
} from "@treecord/shared";
import type { Address, Hex } from "viem";
import { describeError, revertErrorName, type ChainClients } from "./chain.js";
import type { Metrics } from "./metrics.js";
import type { PreparedCall } from "./relayer/calls.js";
import type { NonceManager } from "./relayer/nonces.js";

export interface TreeFact {
  treeId: number;
  campaign: string;
  status: "alive" | "flagged" | "dead" | "removed" | "completed";
  plantedAtSec: number;
  pausedSeconds: number;
  replantDeadlineSec: number | null;
  /** Milestones paid or forfeited. */
  settled: Set<number>;
}

export interface CampaignFact {
  address: string;
  status: "funding" | "active" | "refunding" | "completed";
  timeUnitSeconds: number;
  commitmentUnits: number;
  claimDeadlineSec: number;
}

export type Task =
  | { kind: "forfeit"; campaign: string; treeId: number; milestone: number }
  | { kind: "expireDead"; treeId: number }
  | { kind: "markCompleted"; treeId: number }
  | { kind: "completeCampaign"; campaign: string };

export const taskKey = (task: Task): string =>
  task.kind === "forfeit"
    ? `forfeit:${task.treeId}:${task.milestone}`
    : task.kind === "completeCampaign"
      ? `complete:${task.campaign}`
      : `${task.kind}:${task.treeId}`;

/** Every maintenance call that is due at chain time `nowSec`, mirroring the contracts' conditions. */
export function dueTasks(campaigns: CampaignFact[], trees: TreeFact[], nowSec: number): Task[] {
  const byAddress = new Map(campaigns.map((c) => [c.address, c]));
  const tasks: Task[] = [];

  for (const tree of trees) {
    const campaign = byAddress.get(tree.campaign);
    if (!campaign) continue;
    const unit = campaign.timeUnitSeconds;

    // Campaign.forfeitMilestone: not while Flagged, window closed (now > closesAt), not settled.
    if (tree.status === "alive" || tree.status === "dead") {
      for (let m = 0; m < MILESTONE_COUNT; m++) {
        if (tree.settled.has(m)) continue;
        const dueUnits = MILESTONE_DUE_UNITS[m] ?? 0;
        const opensAt = tree.plantedAtSec + tree.pausedSeconds + dueUnits * unit;
        const closesAt = opensAt + MILESTONE_WINDOW_UNITS * unit;
        if (nowSec > closesAt) {
          tasks.push({
            kind: "forfeit",
            campaign: tree.campaign,
            treeId: tree.treeId,
            milestone: m,
          });
        }
      }
    }

    // TreeRegistry.expireDead: Dead and now > replantDeadline.
    if (
      tree.status === "dead" &&
      tree.replantDeadlineSec !== null &&
      nowSec > tree.replantDeadlineSec
    ) {
      tasks.push({ kind: "expireDead", treeId: tree.treeId });
    }

    // TreeRegistry.markCompleted: Alive and every milestone settled.
    if (tree.status === "alive" && tree.settled.size >= MILESTONE_COUNT) {
      tasks.push({ kind: "markCompleted", treeId: tree.treeId });
    }
  }

  // Campaign.complete: every planted tree Completed or Removed, and the commitment period plus the final
  // window has passed since the later of the last planting and the claim deadline.
  for (const campaign of campaigns) {
    if (campaign.status !== "active") continue;
    const own = trees.filter((t) => t.campaign === campaign.address);
    if (own.some((t) => t.status !== "completed" && t.status !== "removed")) continue;
    const lastPlanted = Math.max(0, ...own.map((t) => t.plantedAtSec));
    const start = Math.max(lastPlanted, campaign.claimDeadlineSec);
    const endsAt = start + (campaign.commitmentUnits + 1) * campaign.timeUnitSeconds;
    if (nowSec >= endsAt) tasks.push({ kind: "completeCampaign", campaign: campaign.address });
  }
  return tasks;
}

export interface SchedulerOptions {
  db: Db;
  clients: ChainClients;
  deployment: TreecordDeployment;
  nonces: NonceManager;
  log: Logger;
  metrics: Metrics;
  chainNow: () => Promise<number>;
  /** At most this many calls per run. */
  maxCallsPerRun?: number;
  receiptTimeoutMs?: number;
}

/** A task whose simulation failed is not tried again for this long. */
const SKIP_AFTER_FAILURE_MS = 10 * 60_000;
/** Rows per page (the PostgREST default maximum) and ids per `in` filter. */
const PAGE_SIZE = 1_000;
const ID_CHUNK = 200;

/** Every row of a query, fetched `PAGE_SIZE` rows at a time. */
async function allPages<T>(
  context: string,
  page: (
    from: number,
    to: number,
  ) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await page(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`Database error during ${context}: ${error.message}`);
    rows.push(...(data ?? []));
    if (!data || data.length < PAGE_SIZE) return rows;
  }
}

export class Scheduler {
  private readonly skipUntil = new Map<string, number>();

  constructor(private readonly options: SchedulerOptions) {}

  /** Runs one maintenance pass. Returns the tasks whose transactions succeeded. */
  async tick(): Promise<Task[]> {
    const { clients, nonces, log, metrics } = this.options;
    const nowSec = await this.options.chainNow();
    const { campaigns, trees } = await this.loadFacts();
    const nowMs = Date.now();
    const tasks = dueTasks(campaigns, trees, nowSec)
      .filter((task) => (this.skipUntil.get(taskKey(task)) ?? 0) <= nowMs)
      .slice(0, this.options.maxCallsPerRun ?? 25);

    const operator = clients.operator;
    const sent: { task: Task; hash: Hex }[] = [];
    for (const task of tasks) {
      const call = this.callFor(task);
      try {
        await call.simulate(clients.public, operator.account);
      } catch (error) {
        this.skipUntil.set(taskKey(task), nowMs + SKIP_AFTER_FAILURE_MS);
        log.info(
          { task: taskKey(task), reason: revertErrorName(error) ?? describeError(error) },
          "maintenance call skipped",
        );
        continue;
      }
      try {
        const hash = await nonces.withNonce(operator.account.address, (nonce) =>
          call.send(operator, nonce),
        );
        sent.push({ task, hash });
      } catch (error) {
        log.warn({ task: taskKey(task), error: describeError(error) }, "maintenance call not sent");
      }
    }

    const done: Task[] = [];
    await Promise.all(
      sent.map(async ({ task, hash }) => {
        try {
          const receipt = await clients.public.waitForTransactionReceipt({
            hash,
            timeout: this.options.receiptTimeoutMs ?? 90_000,
          });
          if (receipt.status === "success") {
            done.push(task);
            metrics.inc(`scheduler.${task.kind}`);
          } else {
            log.warn({ task: taskKey(task), tx: hash }, "maintenance call reverted");
          }
        } catch (error) {
          log.warn(
            { task: taskKey(task), tx: hash, error: describeError(error) },
            "maintenance receipt not seen",
          );
        }
      }),
    );
    if (done.length > 0) log.info({ calls: done.map(taskKey) }, "maintenance calls confirmed");
    metrics.inc("scheduler.runs");
    return done;
  }

  private callFor(task: Task): PreparedCall {
    const registry = this.options.deployment.treeRegistry;
    switch (task.kind) {
      case "forfeit": {
        const address = task.campaign as Address;
        const args = [BigInt(task.treeId), task.milestone] as const;
        return {
          wallet: "operator",
          description: taskKey(task),
          simulate: (client, account) =>
            client.simulateContract({
              address,
              abi: campaignAbi,
              functionName: "forfeitMilestone",
              args,
              account,
            }),
          send: (wallet, nonce) =>
            wallet.writeContract({
              address,
              abi: campaignAbi,
              functionName: "forfeitMilestone",
              args,
              nonce,
            }),
        };
      }
      case "completeCampaign": {
        const address = task.campaign as Address;
        return {
          wallet: "operator",
          description: taskKey(task),
          simulate: (client, account) =>
            client.simulateContract({
              address,
              abi: campaignAbi,
              functionName: "complete",
              account,
            }),
          send: (wallet, nonce) =>
            wallet.writeContract({ address, abi: campaignAbi, functionName: "complete", nonce }),
        };
      }
      case "expireDead":
      case "markCompleted": {
        const functionName = task.kind;
        const args = [BigInt(task.treeId)] as const;
        return {
          wallet: "operator",
          description: taskKey(task),
          simulate: (client, account) =>
            client.simulateContract({
              address: registry,
              abi: treeRegistryAbi,
              functionName,
              args,
              account,
            }),
          send: (wallet, nonce) =>
            wallet.writeContract({
              address: registry,
              abi: treeRegistryAbi,
              functionName,
              args,
              nonce,
            }),
        };
      }
    }
  }

  // Lists go into the query string, so they are fetched page by page and id filters are split into chunks
  // (hundreds of addresses in one `in` filter exceed the URL length limit).
  private async loadFacts(): Promise<{ campaigns: CampaignFact[]; trees: TreeFact[] }> {
    const { db, deployment } = this.options;
    const campaignRows = await allPages("load campaigns for maintenance", (from, to) =>
      db
        .from("campaigns")
        .select("address, status, time_unit_seconds, commitment_units, claim_deadline")
        .eq("chain_id", deployment.chainId)
        .in("status", ["active", "completed"])
        .order("address")
        .range(from, to),
    );
    if (campaignRows.length === 0) return { campaigns: [], trees: [] };
    const known = new Set(campaignRows.map((c) => c.address));

    const treeRows = (
      await allPages("load trees for maintenance", (from, to) =>
        db
          .from("trees")
          .select("tree_id, campaign_address, status, planted_at, paused_seconds, replant_deadline")
          .order("tree_id")
          .range(from, to),
      )
    ).filter((t) => known.has(t.campaign_address));

    const treeIds = treeRows
      .filter((t) => t.status === "alive" || t.status === "dead")
      .map((t) => t.tree_id);
    const settled = new Map<number, Set<number>>();
    for (let i = 0; i < treeIds.length; i += ID_CHUNK) {
      const ids = treeIds.slice(i, i + ID_CHUNK);
      const [payouts, forfeits] = await Promise.all([
        db.from("milestone_payouts").select("tree_id, milestone").in("tree_id", ids),
        db.from("milestone_forfeits").select("tree_id, milestone").in("tree_id", ids),
      ]);
      for (const row of [
        ...ensureOk(payouts, "load payouts"),
        ...ensureOk(forfeits, "load forfeits"),
      ]) {
        const set = settled.get(row.tree_id) ?? new Set<number>();
        set.add(row.milestone);
        settled.set(row.tree_id, set);
      }
    }

    const seconds = (iso: string) => Math.floor(Date.parse(iso) / 1000);
    return {
      campaigns: campaignRows.map((c) => ({
        address: c.address,
        status: c.status,
        timeUnitSeconds: Number(c.time_unit_seconds),
        commitmentUnits: c.commitment_units,
        claimDeadlineSec: seconds(c.claim_deadline),
      })),
      trees: treeRows.map((t) => ({
        treeId: t.tree_id,
        campaign: t.campaign_address,
        status: t.status,
        plantedAtSec: seconds(t.planted_at),
        pausedSeconds: Number(t.paused_seconds),
        replantDeadlineSec: t.replant_deadline ? seconds(t.replant_deadline) : null,
        settled: settled.get(t.tree_id) ?? new Set<number>(),
      })),
    };
  }
}
