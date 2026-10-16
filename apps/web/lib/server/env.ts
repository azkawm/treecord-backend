import "server-only";
import {
  addressSchema,
  chainIdSchema,
  parseEnv,
  privateKeySchema,
  requiredString,
} from "@treecord/shared";
import { z } from "zod";

const serverEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

  // Chain
  BASE_SEPOLIA_RPC_URL: z.url(),
  CHAIN_ID: chainIdSchema,
  USDC_ADDRESS: addressSchema,

  // Signs EIP-712 attestations (operator review approvals). Never sends transactions.
  ATTESTER_PRIVATE_KEY: privateKeySchema,

  // Supabase (service role, server only)
  SUPABASE_URL: z.url(),
  SUPABASE_SERVICE_ROLE_KEY: requiredString,

  // Privy
  PRIVY_APP_ID: requiredString,
  PRIVY_APP_SECRET: requiredString,
});

export type ServerEnv = z.infer<typeof serverEnvSchema>;

let cached: ServerEnv | undefined;

/**
 * Validated server env. Parsed once and cached.
 * instrumentation.ts calls this at server boot so a missing var fails fast instead of on the first request.
 */
export function getServerEnv(): ServerEnv {
  cached ??= parseEnv(serverEnvSchema, process.env);
  return cached;
}
