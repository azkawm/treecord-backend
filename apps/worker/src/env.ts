import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chainIdSchema, parseEnv, privateKeySchema, requiredString } from "@treecord/shared";
import { z } from "zod";

// Local development reads the shared root .env (same path from src/ and dist/).
// On Railway the file is absent and platform env vars are used. Existing env vars are never overwritten.
const rootEnvFile = fileURLToPath(new URL("../../../.env", import.meta.url));
if (existsSync(rootEnvFile)) {
  process.loadEnvFile(rootEnvFile);
}

const workerEnvSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),

    // Chain
    BASE_SEPOLIA_RPC_URL: z.url(),
    CHAIN_ID: chainIdSchema,

    // Wallets: operator (OPERATOR_ROLE and ISSUER_ROLE calls), relayer (attestation submits),
    // attester (signs attestations after scoring, never sends transactions)
    OPERATOR_PRIVATE_KEY: privateKeySchema,
    RELAYER_PRIVATE_KEY: privateKeySchema,
    ATTESTER_PRIVATE_KEY: privateKeySchema,

    // Supabase (service role)
    SUPABASE_URL: z.url(),
    SUPABASE_SERVICE_ROLE_KEY: requiredString,

    // AI scoring service. URL and token are only required when MOCK_AI is false.
    MOCK_AI: z.stringbool().default(false),
    AI_SERVICE_URL: z.url().optional(),
    AI_SERVICE_TOKEN: z.string().optional(),
  })
  .superRefine((env, ctx) => {
    if (env.MOCK_AI) return;
    if (!env.AI_SERVICE_URL) {
      ctx.addIssue({
        code: "custom",
        path: ["AI_SERVICE_URL"],
        message: "is required when MOCK_AI is false",
      });
    }
    if (!env.AI_SERVICE_TOKEN) {
      ctx.addIssue({
        code: "custom",
        path: ["AI_SERVICE_TOKEN"],
        message: "is required when MOCK_AI is false",
      });
    }
  });

export type WorkerEnv = z.infer<typeof workerEnvSchema>;

/** Validates process.env and throws a readable error listing every missing or malformed var. */
export function loadEnv(): WorkerEnv {
  return parseEnv(workerEnvSchema, process.env);
}
