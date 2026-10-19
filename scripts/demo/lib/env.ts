// Env for the demo scripts. Reads the root .env like the web app and worker do.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  ANVIL_CHAIN_ID,
  DEFAULT_DEMO_TIME_UNIT_SECONDS,
  chainIdSchema,
  parseEnv,
  privateKeySchema,
  requiredString,
  uintStringSchema,
} from "@treecord/shared";
import { z } from "zod";

const rootEnvFile = fileURLToPath(new URL("../../../.env", import.meta.url));
if (existsSync(rootEnvFile)) process.loadEnvFile(rootEnvFile);

const demoEnvSchema = z.object({
  BASE_SEPOLIA_RPC_URL: z.url(),
  CHAIN_ID: chainIdSchema,

  // Funds the demo wallets with test ETH (gas for donors) and USDC. The deployer wallet by default.
  DEPLOYER_PRIVATE_KEY: privateKeySchema,
  DEMO_FUNDER_PRIVATE_KEY: privateKeySchema.optional(),

  // Grants the auditor and operator roles (done by hand in production), marks the demo campaign, resets.
  SUPABASE_URL: z.url(),
  SUPABASE_SERVICE_ROLE_KEY: requiredString,

  // The API the scripts call. Defaults to PUBLIC_APP_URL.
  DEMO_API_URL: z.url().optional(),
  PUBLIC_APP_URL: z.url().default("http://localhost:3000"),

  DEMO_TIME_UNIT_SECONDS: z.coerce.number().int().min(30).default(DEFAULT_DEMO_TIME_UNIT_SECONDS),
  // USDC base units. 5 USDC fits one Circle faucet request with room for the carbon purchase.
  DEMO_FUNDING_TARGET: uintStringSchema.default("5000000"),
  // Test ETH each donor wallet is topped up to, in ether.
  DEMO_DONOR_ETH: z
    .string()
    .regex(/^\d+(\.\d+)?$/)
    .default("0.002"),
  // BIP-39 phrase for the demo wallets. On anvil the default anvil phrase is used. Elsewhere the seed
  // generates one and keeps it in the state file.
  DEMO_MNEMONIC: z.string().trim().min(1).optional(),
  // How long to wait for a job, a submission or the indexer before giving up.
  DEMO_WAIT_SECONDS: z.coerce.number().int().positive().default(600),
});

export type DemoEnv = z.infer<typeof demoEnvSchema> & {
  apiUrl: string;
  isAnvil: boolean;
  funderKey: `0x${string}`;
};

let cached: DemoEnv | undefined;

export function demoEnv(): DemoEnv {
  if (!cached) {
    const env = parseEnv(demoEnvSchema, process.env);
    cached = {
      ...env,
      apiUrl: (env.DEMO_API_URL ?? env.PUBLIC_APP_URL).replace(/\/$/, ""),
      isAnvil: env.CHAIN_ID === ANVIL_CHAIN_ID,
      funderKey: (env.DEMO_FUNDER_PRIVATE_KEY ?? env.DEPLOYER_PRIVATE_KEY) as `0x${string}`,
    };
  }
  return cached;
}
