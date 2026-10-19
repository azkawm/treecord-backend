// Chain access for the demo: clients, the deployment, and the transactions donors send themselves.
import { getDeployment, type TreecordDeployment } from "@treecord/shared";
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  http,
  type Account,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
  type WalletClient,
} from "viem";
import { baseSepolia, foundry } from "viem/chains";
import { demoEnv } from "./env.js";
import { tx } from "./log.js";

const chain = () => (demoEnv().isAnvil ? foundry : baseSepolia);

let publicClient: PublicClient | undefined;

export function getPublicClient(): PublicClient {
  publicClient ??= createPublicClient({
    chain: chain(),
    transport: http(demoEnv().BASE_SEPOLIA_RPC_URL),
  }) as PublicClient;
  return publicClient;
}

export function walletFor(account: Account): WalletClient {
  return createWalletClient({
    account,
    chain: chain(),
    transport: http(demoEnv().BASE_SEPOLIA_RPC_URL),
  });
}

export function deployment(): TreecordDeployment {
  return getDeployment(demoEnv().CHAIN_ID);
}

/** Latest block timestamp in seconds. The API and the contracts measure milestone windows with it. */
export async function chainNow(): Promise<number> {
  const block = await getPublicClient().getBlock({ blockTag: "latest" });
  return Number(block.timestamp);
}

/** Sends a transaction, waits for its receipt, logs its link, and throws if it reverted. */
export async function sendTx(label: string, send: () => Promise<Hex>): Promise<TransactionReceipt> {
  const hash = await send();
  const receipt = await getPublicClient().waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${label} reverted (${hash})`);
  tx(label, hash);
  return receipt;
}

/** anvil only: moves chain time forward and mines a block, so the demo need not wait in real time. */
export async function warp(seconds: number): Promise<void> {
  if (!demoEnv().isAnvil) throw new Error("Time travel only works on a local anvil chain");
  if (seconds <= 0) return;
  const test = createTestClient({
    chain: foundry,
    mode: "anvil",
    transport: http(demoEnv().BASE_SEPOLIA_RPC_URL),
  });
  await test.increaseTime({ seconds: Math.ceil(seconds) });
  await test.mine({ blocks: 1 });
}

/** Waits until chain time reaches `targetSec`, by sleeping or (with fast mode on anvil) by warping. */
export async function waitForChainTime(targetSec: number, fast: boolean): Promise<void> {
  for (;;) {
    const now = await chainNow();
    if (now >= targetSec) return;
    if (fast) {
      await warp(targetSec - now);
    } else {
      await sleep(Math.min(15, targetSec - now) * 1000);
    }
  }
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
