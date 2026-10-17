// Test helpers: a throwaway anvil node with every Treecord contract deployed the way Deploy.s.sol does it.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ANVIL_CHAIN_ID, treecordRolesAbi, type TreecordDeployment } from "@treecord/shared";
import {
  createPublicClient,
  createWalletClient,
  http,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";

/** anvil's well-known default dev keys (public, never used on a real network), as in packages/contracts/.env.anvil. */
export const ANVIL_KEYS = {
  deployer: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  operator: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  attester: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  relayer: "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  treasury: "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
  donor: "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
} as const satisfies Record<string, Hex>;

const contractsOut = fileURLToPath(new URL("../../../../packages/contracts/out/", import.meta.url));

/** The anvil binary from PATH or the default Foundry install folder, or null if Foundry is not installed. */
export function findAnvil(): string | null {
  const exe = process.platform === "win32" ? "anvil.exe" : "anvil";
  const candidates = [
    ...(process.env.PATH ?? "")
      .split(process.platform === "win32" ? ";" : ":")
      .map((dir) => join(dir, exe)),
    join(homedir(), ".foundry", "bin", exe),
  ];
  return candidates.find((path) => path && existsSync(path)) ?? null;
}

export function artifactsBuilt(): boolean {
  return existsSync(join(contractsOut, "Campaign.sol", "Campaign.json"));
}

function artifact(file: string, name = file): { abi: Abi; bytecode: Hex } {
  const json = JSON.parse(
    readFileSync(join(contractsOut, `${file}.sol`, `${name}.json`), "utf8"),
  ) as {
    abi: Abi;
    bytecode: { object: Hex };
  };
  return { abi: json.abi, bytecode: json.bytecode.object };
}

export interface LocalChain {
  rpcUrl: string;
  client: PublicClient;
  deployment: TreecordDeployment;
  stop(): Promise<void>;
}

/** Starts anvil on `port`, deploys and wires the contracts, then turns on 1 second interval mining. */
export async function startLocalChain(anvilPath: string, port: number): Promise<LocalChain> {
  const child: ChildProcess = spawn(anvilPath, ["--port", String(port), "--silent"], {
    stdio: "ignore",
  });
  const rpcUrl = `http://127.0.0.1:${port}`;
  const transport = http(rpcUrl);
  const client = createPublicClient({
    chain: foundry,
    transport,
    pollingInterval: 100,
  }) as PublicClient;
  const stop = async () => {
    if (child.exitCode === null) {
      child.kill();
      await new Promise((resolve) => child.once("exit", resolve));
    }
  };

  try {
    const deadline = Date.now() + 15_000;
    for (;;) {
      try {
        await client.getChainId();
        break;
      } catch (error) {
        if (Date.now() > deadline) throw error;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }

    const deployer = createWalletClient({
      account: privateKeyToAccount(ANVIL_KEYS.deployer),
      chain: foundry,
      transport,
    });
    const address = (key: Hex) => privateKeyToAccount(key).address;
    const deploy = async (file: string, args: unknown[]): Promise<Address> => {
      const { abi, bytecode } = artifact(file);
      const hash = await deployer.deployContract({ abi, bytecode, args } as never);
      const receipt = await client.waitForTransactionReceipt({ hash });
      if (!receipt.contractAddress) throw new Error(`${file} was not deployed`);
      return receipt.contractAddress;
    };
    const deployBlock = await client.getBlockNumber();

    const usdc = await deploy("MockUSDC", []);
    const roles = await deploy("TreecordRoles", [
      deployer.account.address,
      address(ANVIL_KEYS.treasury),
    ]);
    const treeRegistry = await deploy("TreeRegistry", [roles]);
    const implementation = await deploy("Campaign", [roles, usdc, treeRegistry]);
    const factory = await deploy("CampaignFactory", [roles, implementation]);
    const gateway = await deploy("VerificationGateway", [roles]);
    const ledger = await deploy("CarbonLedger", [roles, usdc, "http://localhost/carbon/{id}.json"]);

    const role = (functionName: "OPERATOR_ROLE" | "ISSUER_ROLE" | "ATTESTER_ROLE") =>
      client.readContract({ address: roles, abi: treecordRolesAbi, functionName });
    const wire: [string, unknown[]][] = [
      ["setFactory", [factory]],
      ["setTreeRegistry", [treeRegistry]],
      ["setGateway", [gateway]],
      ["setCarbonLedger", [ledger]],
      ["grantRole", [await role("OPERATOR_ROLE"), address(ANVIL_KEYS.operator)]],
      ["grantRole", [await role("ISSUER_ROLE"), address(ANVIL_KEYS.operator)]],
      ["grantRole", [await role("ATTESTER_ROLE"), address(ANVIL_KEYS.attester)]],
    ];
    for (const [functionName, args] of wire) {
      const hash = await deployer.writeContract({
        address: roles,
        abi: treecordRolesAbi,
        functionName,
        args,
      } as never);
      await client.waitForTransactionReceipt({ hash });
    }

    // Empty blocks every second, so confirmation depth is reached without new transactions.
    await client.request({ method: "evm_setIntervalMining", params: [1] } as never);

    return {
      rpcUrl,
      client,
      stop,
      deployment: {
        chainId: ANVIL_CHAIN_ID,
        deployBlock,
        deployer: deployer.account.address,
        operator: address(ANVIL_KEYS.operator),
        attester: address(ANVIL_KEYS.attester),
        treasury: address(ANVIL_KEYS.treasury),
        usdc,
        treecordRoles: roles,
        treeRegistry,
        campaignImplementation: implementation,
        campaignFactory: factory,
        verificationGateway: gateway,
        carbonLedger: ledger,
      },
    };
  } catch (error) {
    await stop();
    throw error;
  }
}
