// Polls Treecord contract logs into the Supabase mirror (prompt 9).
import { ensureMaybe, ensureOk, type Db, type Logger } from "@treecord/pipeline";
import type { TreecordDeployment } from "@treecord/shared";
import type { Address, PublicClient } from "viem";
import type { Metrics } from "../metrics.js";
import { applyEvent } from "./apply.js";
import { decodeLogs, type RawLog, type WatchedAddresses } from "./decode.js";

export interface IndexerOptions {
  db: Db;
  client: PublicClient;
  deployment: TreecordDeployment;
  log: Logger;
  metrics: Metrics;
  /** Row in chain_cursor. Lets tests and parallel deployments keep separate cursors. */
  cursorName?: string;
  /** First block to index when there is no cursor yet. Defaults to the deploy block. */
  startBlock?: bigint;
  /** Blocks per eth_getLogs call. */
  chunkBlocks?: number;
  /** Only blocks this deep are indexed. */
  confirmations?: number;
  /** Already indexed blocks scanned again every cycle, to pick up reorged logs. */
  rescanBlocks?: number;
}

export interface IndexRange {
  fromBlock: bigint;
  toBlock: bigint;
}

export interface TickResult extends IndexRange {
  /** True when the confirmed head is reached, so the next cycle can wait for new blocks. */
  caughtUp: boolean;
}

/**
 * The block range for the next cycle: from just after the cursor (minus the re-scan margin, never before the
 * start block) up to one chunk of new blocks, capped at the confirmed head. Null when nothing is confirmed yet.
 */
export function nextRange(options: {
  cursor: bigint | null;
  startBlock: bigint;
  head: bigint;
  confirmations: number;
  chunkBlocks: number;
  rescanBlocks: number;
}): IndexRange | null {
  const safeHead = options.head - BigInt(options.confirmations);
  const firstNew = options.cursor === null ? options.startBlock : options.cursor + 1n;
  let fromBlock = firstNew - BigInt(options.rescanBlocks);
  if (fromBlock < options.startBlock) fromBlock = options.startBlock;
  let toBlock = firstNew + BigInt(options.chunkBlocks) - 1n;
  if (toBlock > safeHead) toBlock = safeHead;
  if (toBlock < fromBlock) return null;
  return { fromBlock, toBlock };
}

export class Indexer {
  readonly cursorName: string;
  private readonly startBlock: bigint;
  private readonly chunkBlocks: number;
  private readonly confirmations: number;
  private readonly rescanBlocks: number;
  private readonly watched: WatchedAddresses;
  private campaignsLoaded = false;
  private blockTimes = new Map<bigint, string>();

  /** Last indexed block and chain head, for /health. */
  status: { lastBlock: bigint | null; head: bigint | null; lastRunAt: Date | null } = {
    lastBlock: null,
    head: null,
    lastRunAt: null,
  };

  constructor(private readonly options: IndexerOptions) {
    const d = options.deployment;
    this.cursorName = options.cursorName ?? `indexer:${d.chainId}`;
    this.startBlock = options.startBlock ?? d.deployBlock;
    this.chunkBlocks = options.chunkBlocks ?? 2_000;
    this.confirmations = options.confirmations ?? 2;
    this.rescanBlocks = options.rescanBlocks ?? 5;
    this.watched = {
      factory: lower(d.campaignFactory),
      treeRegistry: lower(d.treeRegistry),
      gateway: lower(d.verificationGateway),
      carbonLedger: lower(d.carbonLedger),
      campaigns: new Set(),
    };
  }

  /**
   * Indexes one chunk. Returns the range indexed, or null when the confirmed head has nothing new.
   * The cursor moves only after every event of the chunk is applied, so a crash replays the chunk.
   */
  async tick(): Promise<TickResult | null> {
    const { client, db, log, metrics } = this.options;
    await this.loadCampaigns();

    const head = await client.getBlockNumber();
    const cursor = await this.readCursor();
    this.status = { ...this.status, head, lastBlock: cursor, lastRunAt: new Date() };
    const range = nextRange({
      cursor,
      startBlock: this.startBlock,
      head,
      confirmations: this.confirmations,
      chunkBlocks: this.chunkBlocks,
      rescanBlocks: this.rescanBlocks,
    });
    if (!range) return null;

    // Pass 1: campaigns created in this range, so their own logs in the same range are fetched too.
    const created = await this.getLogs([this.watched.factory], range);
    for (const ev of decodeLogs(created, this.watched)) {
      if (ev.source === "factory" && ev.event.eventName === "CampaignCreated") {
        this.watched.campaigns.add(lower(ev.event.args.campaign));
      }
    }

    // Pass 2: everything, applied in chain order.
    const addresses: Address[] = [
      this.watched.factory,
      this.watched.treeRegistry,
      this.watched.gateway,
      this.watched.carbonLedger,
      ...this.watched.campaigns,
    ];
    const events = decodeLogs(await this.getLogs(addresses, range), this.watched);
    const ctx = {
      db,
      chainId: this.options.deployment.chainId,
      carbonLedger: this.watched.carbonLedger,
      blockTime: (block: bigint) => this.blockTime(block),
      log,
    };
    for (const ev of events) {
      await applyEvent(ctx, ev);
      metrics.inc(`indexer.events.${ev.event.eventName}`);
    }

    await this.writeCursor(range.toBlock);
    this.status = { ...this.status, lastBlock: range.toBlock };
    metrics.inc("indexer.chunks");
    metrics.set("indexer.lastBlock", Number(range.toBlock));
    metrics.set("indexer.lagBlocks", Number(head - range.toBlock));
    if (events.length > 0) {
      log.info(
        { from: Number(range.fromBlock), to: Number(range.toBlock), events: events.length },
        "indexed chunk",
      );
    }
    // Old block timestamps are not needed again after the re-scan window.
    if (this.blockTimes.size > 10_000) this.blockTimes.clear();
    return { ...range, caughtUp: range.toBlock >= head - BigInt(this.confirmations) };
  }

  /** Indexes chunks until the confirmed head is reached. */
  async catchUp(): Promise<void> {
    for (;;) {
      const result = await this.tick();
      if (!result || result.caughtUp) return;
    }
  }

  private async getLogs(addresses: Address[], range: IndexRange): Promise<RawLog[]> {
    const logs = await this.options.client.getLogs({
      address: addresses,
      fromBlock: range.fromBlock,
      toBlock: range.toBlock,
    });
    return logs.flatMap((l) =>
      l.blockNumber === null || l.logIndex === null || l.transactionHash === null
        ? []
        : [
            {
              address: l.address,
              blockNumber: l.blockNumber,
              logIndex: l.logIndex,
              transactionHash: l.transactionHash,
              data: l.data,
              topics: l.topics,
            },
          ],
    );
  }

  private async blockTime(blockNumber: bigint): Promise<string> {
    const cached = this.blockTimes.get(blockNumber);
    if (cached) return cached;
    const block = await this.options.client.getBlock({ blockNumber });
    const time = new Date(Number(block.timestamp) * 1000).toISOString();
    this.blockTimes.set(blockNumber, time);
    return time;
  }

  /** Campaign clones already mirrored. New ones are added from CampaignCreated as they are indexed. */
  private async loadCampaigns(): Promise<void> {
    if (this.campaignsLoaded) return;
    const rows = ensureOk(
      await this.options.db
        .from("campaigns")
        .select("address")
        .eq("chain_id", this.options.deployment.chainId),
      "load campaign addresses",
    );
    for (const row of rows) this.watched.campaigns.add(lower(row.address as Address));
    this.campaignsLoaded = true;
  }

  private async readCursor(): Promise<bigint | null> {
    const row = ensureMaybe(
      await this.options.db
        .from("chain_cursor")
        .select("last_block")
        .eq("name", this.cursorName)
        .maybeSingle(),
      "read chain cursor",
    );
    return row ? BigInt(row.last_block) : null;
  }

  private async writeCursor(block: bigint): Promise<void> {
    ensureMaybe(
      await this.options.db
        .from("chain_cursor")
        .upsert({ name: this.cursorName, last_block: Number(block) }, { onConflict: "name" }),
      "write chain cursor",
    );
  }
}

function lower(address: string): Address {
  return address.toLowerCase() as Address;
}
