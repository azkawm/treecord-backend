// Decodes raw logs from Treecord contracts into typed events. Pure: no I/O.
import {
  campaignAbi,
  campaignFactoryAbi,
  carbonLedgerAbi,
  treeRegistryAbi,
  verificationGatewayAbi,
} from "@treecord/shared";
import {
  AbiEventSignatureNotFoundError,
  decodeEventLog,
  type Address,
  type DecodeEventLogReturnType,
  type Hex,
} from "viem";

/** Which contract a log came from. Campaign clones are discovered from CampaignCreated. */
export type LogSource = "factory" | "campaign" | "treeRegistry" | "gateway" | "carbonLedger";

/** The fields of an eth_getLogs entry the indexer needs. */
export interface RawLog {
  address: Address;
  blockNumber: bigint;
  logIndex: number;
  transactionHash: Hex;
  data: Hex;
  topics: [Hex, ...Hex[]] | [];
}

export interface EventMeta {
  /** Lowercase emitting contract. */
  address: Address;
  blockNumber: bigint;
  logIndex: number;
  /** Lowercase transaction hash. */
  txHash: Hex;
}

export type IndexedEvent =
  | {
      source: "factory";
      meta: EventMeta;
      event: DecodeEventLogReturnType<typeof campaignFactoryAbi>;
    }
  | { source: "campaign"; meta: EventMeta; event: DecodeEventLogReturnType<typeof campaignAbi> }
  | {
      source: "treeRegistry";
      meta: EventMeta;
      event: DecodeEventLogReturnType<typeof treeRegistryAbi>;
    }
  | {
      source: "gateway";
      meta: EventMeta;
      event: DecodeEventLogReturnType<typeof verificationGatewayAbi>;
    }
  | {
      source: "carbonLedger";
      meta: EventMeta;
      event: DecodeEventLogReturnType<typeof carbonLedgerAbi>;
    };

/** Contract addresses the indexer watches, all lowercase. */
export interface WatchedAddresses {
  factory: Address;
  treeRegistry: Address;
  gateway: Address;
  carbonLedger: Address;
  campaigns: Set<Address>;
}

export function sourceOf(address: Address, watched: WatchedAddresses): LogSource | null {
  const a = address.toLowerCase() as Address;
  if (a === watched.factory) return "factory";
  if (a === watched.treeRegistry) return "treeRegistry";
  if (a === watched.gateway) return "gateway";
  if (a === watched.carbonLedger) return "carbonLedger";
  if (watched.campaigns.has(a)) return "campaign";
  return null;
}

/**
 * Decodes one log. Returns null for logs from unknown addresses and for events the indexer does not
 * mirror (role changes, ERC-1155 transfers, initialization), which are not in the ABI subset or are skipped.
 */
export function decodeLog(log: RawLog, watched: WatchedAddresses): IndexedEvent | null {
  const source = sourceOf(log.address, watched);
  if (!source || log.topics.length === 0) return null;
  const meta: EventMeta = {
    address: log.address.toLowerCase() as Address,
    blockNumber: log.blockNumber,
    logIndex: log.logIndex,
    txHash: log.transactionHash.toLowerCase() as Hex,
  };
  const input = { data: log.data, topics: log.topics, strict: true } as const;
  try {
    switch (source) {
      case "factory":
        return { source, meta, event: decodeEventLog({ abi: campaignFactoryAbi, ...input }) };
      case "campaign":
        return { source, meta, event: decodeEventLog({ abi: campaignAbi, ...input }) };
      case "treeRegistry":
        return { source, meta, event: decodeEventLog({ abi: treeRegistryAbi, ...input }) };
      case "gateway":
        return { source, meta, event: decodeEventLog({ abi: verificationGatewayAbi, ...input }) };
      case "carbonLedger":
        return { source, meta, event: decodeEventLog({ abi: carbonLedgerAbi, ...input }) };
    }
  } catch (error) {
    if (error instanceof AbiEventSignatureNotFoundError) return null;
    throw error;
  }
}

/** Chain order: block number, then log index. */
export function compareEvents(a: { meta: EventMeta }, b: { meta: EventMeta }): number {
  if (a.meta.blockNumber !== b.meta.blockNumber)
    return a.meta.blockNumber < b.meta.blockNumber ? -1 : 1;
  return a.meta.logIndex - b.meta.logIndex;
}

/** Decodes a batch of logs and returns them in chain order. */
export function decodeLogs(logs: RawLog[], watched: WatchedAddresses): IndexedEvent[] {
  return logs
    .map((log) => decodeLog(log, watched))
    .filter((event): event is IndexedEvent => event !== null)
    .sort(compareEvents);
}
