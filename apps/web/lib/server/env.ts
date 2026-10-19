import "server-only";
import {
  addressSchema,
  chainIdSchema,
  parseEnv,
  privateKeySchema,
  requiredString,
} from "@treecord/shared";
import { z } from "zod";

const serverEnvSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

    // Public base URL of this app. Used to build campaign metadata URIs.
    PUBLIC_APP_URL: z.url().default("http://localhost:3000"),

    // Chain
    BASE_SEPOLIA_RPC_URL: z.url(),
    CHAIN_ID: chainIdSchema,
    USDC_ADDRESS: addressSchema,

    // Signs EIP-712 attestations (operator review approvals). Never sends transactions.
    ATTESTER_PRIVATE_KEY: privateKeySchema,

    // Supabase (service role, server only)
    SUPABASE_URL: z.url(),
    SUPABASE_SERVICE_ROLE_KEY: requiredString,

    // Privy. Required unless DEMO_WALLET_AUTH is on.
    PRIVY_APP_ID: requiredString.optional(),
    PRIVY_APP_SECRET: requiredString.optional(),

    // Accept wallet-signature tokens (packages/shared/src/wallet-auth.ts) for the demo scripts. Off by default.
    DEMO_WALLET_AUTH: z.stringbool().default(false),
  })
  .superRefine((env, ctx) => {
    const privyVars = [env.PRIVY_APP_ID, env.PRIVY_APP_SECRET].filter(Boolean).length;
    if (privyVars === 1 || (privyVars === 0 && !env.DEMO_WALLET_AUTH)) {
      for (const key of ["PRIVY_APP_ID", "PRIVY_APP_SECRET"] as const) {
        if (!env[key]) {
          ctx.addIssue({
            code: "custom",
            path: [key],
            message: "is required unless DEMO_WALLET_AUTH is true",
          });
        }
      }
    }
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
