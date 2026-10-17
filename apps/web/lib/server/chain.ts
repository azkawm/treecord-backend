import "server-only";
import {
  ANVIL_CHAIN_ID,
  campaignAbi,
  getDeployment,
  type TreecordDeployment,
} from "@treecord/shared";
import { createPublicClient, getContract, http, type Address, type PublicClient } from "viem";
import { baseSepolia, foundry } from "viem/chains";
import { getServerEnv } from "./env";

let client: PublicClient | undefined;

/** Read-only client for the configured chain (Base Sepolia, or anvil locally). */
export function getPublicClient(): PublicClient {
  if (!client) {
    const env = getServerEnv();
    client = createPublicClient({
      chain: env.CHAIN_ID === ANVIL_CHAIN_ID ? foundry : baseSepolia,
      transport: http(env.BASE_SEPOLIA_RPC_URL),
    }) as PublicClient;
  }
  return client;
}

/** Contract addresses for the configured chain. */
export function getChainDeployment(): TreecordDeployment {
  return getDeployment(getServerEnv().CHAIN_ID);
}

type ChainClock = () => Promise<number>;

const blockClock: ChainClock = async () => {
  const block = await getPublicClient().getBlock({ blockTag: "latest" });
  return Number(block.timestamp);
};

let clock: ChainClock = blockClock;

/**
 * Chain time in seconds (latest block timestamp). Milestone windows and attestation expiry use chain time,
 * because that is what the contracts compare against (PRODUCT_KNOWLEDGE.md section 15, rule 4).
 */
export function getChainNow(): Promise<number> {
  return clock();
}

/** Test hook: replaces the chain clock. Pass null to restore the real one. */
export function setChainClock(next: ChainClock | null): void {
  clock = next ?? blockClock;
}

export interface BlockRef {
  number: bigint;
  hash: `0x${string}`;
}

type BlockSource = () => Promise<BlockRef>;

const latestBlock: BlockSource = async () => {
  const block = await getPublicClient().getBlock({ blockTag: "latest" });
  if (block.hash === null) throw new Error("Latest block has no hash");
  return { number: block.number, hash: block.hash };
};

let blockSource: BlockSource = latestBlock;

/** Number and hash of the latest block. Audit sample seeds use the hash. */
export function getLatestBlock(): Promise<BlockRef> {
  return blockSource();
}

/** Test hook: replaces the latest-block source. Pass null to restore the real one. */
export function setLatestBlockSource(next: BlockSource | null): void {
  blockSource = next ?? latestBlock;
}

/** Block explorer link for a transaction, or null on a local chain. */
export function txUrl(txHash: string | null): string | null {
  if (!txHash) return null;
  return getServerEnv().CHAIN_ID === ANVIL_CHAIN_ID
    ? null
    : `https://sepolia.basescan.org/tx/${txHash}`;
}

/** Typed Campaign contract instance. */
export function campaignContract(address: Address) {
  return getContract({ address, abi: campaignAbi, client: getPublicClient() });
}
