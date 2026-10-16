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

/** Typed Campaign contract instance. */
export function campaignContract(address: Address) {
  return getContract({ address, abi: campaignAbi, client: getPublicClient() });
}
