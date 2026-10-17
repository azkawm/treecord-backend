// viem clients and ABI helpers for the worker.
import {
  ANVIL_CHAIN_ID,
  campaignAbi,
  campaignFactoryAbi,
  carbonLedgerAbi,
  treecordRolesAbi,
  treeRegistryAbi,
  verificationGatewayAbi,
} from "@treecord/shared";
import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  decodeErrorResult,
  http,
  type Abi,
  type Account,
  type Chain,
  type Hex,
  type PublicClient,
  type Transport,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia, foundry } from "viem/chains";

type AbiError = Extract<Abi[number], { type: "error" }>;

export type Wallet = WalletClient<Transport, Chain, Account>;

export interface ChainClients {
  public: PublicClient;
  /** OPERATOR_ROLE and ISSUER_ROLE calls, and the scheduled maintenance calls. */
  operator: Wallet;
  /** Attestation submits. */
  relayer: Wallet;
}

export function chainFor(chainId: number): Chain {
  return chainId === ANVIL_CHAIN_ID ? foundry : baseSepolia;
}

export function createChainClients(options: {
  rpcUrl: string;
  chainId: number;
  operatorKey: Hex;
  relayerKey: Hex;
  pollingIntervalMs?: number;
}): ChainClients {
  const chain = chainFor(options.chainId);
  const transport = http(options.rpcUrl, { retryCount: 2, timeout: 20_000 });
  const pollingInterval = options.pollingIntervalMs ?? 1_000;
  const wallet = (key: Hex): Wallet =>
    createWalletClient({ account: privateKeyToAccount(key), chain, transport, pollingInterval });
  return {
    public: createPublicClient({ chain, transport, pollingInterval }) as PublicClient,
    operator: wallet(options.operatorKey),
    relayer: wallet(options.relayerKey),
  };
}

/** Every custom error any Treecord contract can revert with, so nested reverts decode too. */
export const treecordErrorsAbi: AbiError[] = (() => {
  const seen = new Map<string, AbiError>();
  const abis: Abi[] = [
    treecordRolesAbi,
    campaignFactoryAbi,
    campaignAbi,
    treeRegistryAbi,
    verificationGatewayAbi,
    carbonLedgerAbi,
  ];
  for (const abi of abis) {
    for (const item of abi) {
      if (item.type === "error" && !seen.has(item.name)) seen.set(item.name, item);
    }
  }
  return [...seen.values()];
})();

/** The custom error name of a contract revert (for example `NonceAlreadyUsed`), or null for other failures. */
export function revertErrorName(error: unknown): string | null {
  if (!(error instanceof BaseError)) return null;
  const reverted = error.walk((e) => e instanceof ContractFunctionRevertedError);
  if (!(reverted instanceof ContractFunctionRevertedError)) return null;
  if (reverted.data?.errorName) return reverted.data.errorName;
  if (reverted.raw && reverted.raw !== "0x") {
    try {
      return decodeErrorResult({ abi: treecordErrorsAbi, data: reverted.raw }).errorName;
    } catch {
      return null;
    }
  }
  return null;
}

/** A short, single-line description of an error for logs and `last_error`. */
export function describeError(error: unknown): string {
  const name = revertErrorName(error);
  if (name) return `reverted: ${name}`;
  if (error instanceof BaseError) return error.shortMessage;
  if (error instanceof Error) return error.message;
  return String(error);
}
