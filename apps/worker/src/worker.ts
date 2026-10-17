// Wires the indexer, relayer lanes and scheduler into one process. Each loop runs on its own timer and
// keeps going immediately while it has work.
import type { Db, Logger, ScoreDeps } from "@treecord/pipeline";
import type { TreecordDeployment } from "@treecord/shared";
import { describeError, type ChainClients } from "./chain.js";
import { Indexer } from "./indexer/indexer.js";
import { Metrics } from "./metrics.js";
import { NonceManager } from "./relayer/nonces.js";
import { Relayer } from "./relayer/relayer.js";
import { Scheduler } from "./scheduler.js";
import type { HealthReport } from "./server.js";

export type WorkerMode = "all" | "indexer" | "relayer";

export interface WorkerOptions {
  mode: WorkerMode;
  db: Db;
  clients: ChainClients;
  deployment: TreecordDeployment;
  log: Logger;
  /** AI client, attester and chain clock. */
  scoreDeps: ScoreDeps;
  workerId: string;
  metrics?: Metrics;
  indexer?: {
    pollMs?: number;
    cursorName?: string;
    startBlock?: bigint;
    chunkBlocks?: number;
    confirmations?: number;
    rescanBlocks?: number;
  };
  relayer?: { pollMs?: number; receiptTimeoutMs?: number };
  scheduler?: { intervalMs?: number; enabled?: boolean; maxCallsPerRun?: number };
}

export interface LoopHealth {
  name: string;
  healthy: boolean;
  lastSuccessAt: string | null;
  lastError: string | null;
}

interface Loop {
  name: string;
  /** Returns true when it did work and should run again right away. */
  run: () => Promise<boolean>;
  intervalMs: number;
  lastSuccessAt: Date | null;
  lastError: string | null;
}

/** A loop is unhealthy when it has not succeeded for this many intervals. */
const STALE_INTERVALS = 10;

export class Worker {
  readonly metrics: Metrics;
  readonly indexer: Indexer | null;
  readonly relayer: Relayer | null;
  readonly scheduler: Scheduler | null;
  private readonly loops: Loop[] = [];
  private readonly timers = new Set<NodeJS.Timeout>();
  private readonly running = new Set<Promise<void>>();
  private stopped = true;

  constructor(private readonly options: WorkerOptions) {
    this.metrics = options.metrics ?? new Metrics();
    const { db, clients, deployment, log } = options;
    const runIndexer = options.mode !== "relayer";
    const runRelayer = options.mode !== "indexer";
    const nonces = new NonceManager((address) =>
      clients.public.getTransactionCount({ address, blockTag: "pending" }),
    );

    this.indexer = runIndexer
      ? new Indexer({
          db,
          client: clients.public,
          deployment,
          log,
          metrics: this.metrics,
          ...options.indexer,
        })
      : null;
    this.relayer = runRelayer
      ? new Relayer({
          db,
          clients,
          deployment,
          nonces,
          log,
          metrics: this.metrics,
          workerId: options.workerId,
          scoreDeps: options.scoreDeps,
          ...(options.relayer?.receiptTimeoutMs
            ? { receiptTimeoutMs: options.relayer.receiptTimeoutMs }
            : {}),
        })
      : null;
    this.scheduler =
      runRelayer && options.scheduler?.enabled !== false
        ? new Scheduler({
            db,
            clients,
            deployment,
            nonces,
            log,
            metrics: this.metrics,
            chainNow: options.scoreDeps.chainNow,
            ...(options.scheduler?.maxCallsPerRun
              ? { maxCallsPerRun: options.scheduler.maxCallsPerRun }
              : {}),
          })
        : null;

    const indexer = this.indexer;
    const relayer = this.relayer;
    const scheduler = this.scheduler;
    const relayerPoll = options.relayer?.pollMs ?? 2_000;
    if (indexer) {
      this.addLoop("indexer", options.indexer?.pollMs ?? 4_000, async () => {
        const result = await indexer.tick();
        return result !== null && !result.caughtUp;
      });
    }
    if (relayer) {
      this.addLoop("relayer.score", relayerPoll, async () => (await relayer.tickScore()) > 0);
      this.addLoop(
        "relayer.attestation",
        relayerPoll,
        async () => (await relayer.tickAttestations()) > 0,
      );
      this.addLoop("relayer.operator", relayerPoll, async () => (await relayer.tickOperator()) > 0);
    }
    if (scheduler) {
      this.addLoop("scheduler", options.scheduler?.intervalMs ?? 60_000, async () => {
        await scheduler.tick();
        return false;
      });
    }
  }

  private addLoop(name: string, intervalMs: number, run: () => Promise<boolean>): void {
    this.loops.push({ name, run, intervalMs, lastSuccessAt: null, lastError: null });
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    for (const loop of this.loops) this.schedule(loop, 0);
    this.options.log.info(
      {
        mode: this.options.mode,
        loops: this.loops.map((l) => l.name),
        worker: this.options.workerId,
      },
      "worker started",
    );
  }

  /** Stops scheduling and waits for the loops' current iterations to finish. */
  async stop(): Promise<void> {
    this.stopped = true;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    await Promise.allSettled([...this.running]);
  }

  private schedule(loop: Loop, delayMs: number): void {
    if (this.stopped) return;
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      const iteration = this.iterate(loop);
      this.running.add(iteration);
      void iteration.finally(() => this.running.delete(iteration));
    }, delayMs);
    this.timers.add(timer);
  }

  private async iterate(loop: Loop): Promise<void> {
    let again = false;
    try {
      again = await loop.run();
      loop.lastSuccessAt = new Date();
      loop.lastError = null;
    } catch (error) {
      loop.lastError = describeError(error);
      this.metrics.inc(`${loop.name}.errors`);
      this.options.log.error({ loop: loop.name, error: loop.lastError }, "loop iteration failed");
    }
    this.schedule(loop, again ? 0 : loop.intervalMs);
  }

  health(): HealthReport & { loops: LoopHealth[] } {
    const now = Date.now();
    const loops = this.loops.map((loop): LoopHealth => {
      // Before its first success a loop is healthy until it reports an error.
      const healthy =
        loop.lastSuccessAt === null
          ? loop.lastError === null
          : now - loop.lastSuccessAt.getTime() < loop.intervalMs * STALE_INTERVALS + 60_000;
      return {
        name: loop.name,
        healthy,
        lastSuccessAt: loop.lastSuccessAt?.toISOString() ?? null,
        lastError: loop.lastError,
      };
    });
    const indexer = this.indexer?.status;
    return {
      ok: !this.stopped && loops.every((l) => l.healthy),
      mode: this.options.mode,
      chainId: this.options.deployment.chainId,
      loops,
      indexer: indexer
        ? {
            lastBlock: indexer.lastBlock?.toString() ?? null,
            head: indexer.head?.toString() ?? null,
            lagBlocks:
              indexer.lastBlock !== null && indexer.head !== null
                ? Number(indexer.head - indexer.lastBlock)
                : null,
          }
        : null,
    };
  }
}
