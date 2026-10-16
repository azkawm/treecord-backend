import { z } from "zod";
import { ANVIL_CHAIN_ID, CHAIN_ID } from "./constants.js";

// Building blocks for the per-app env loaders (apps/web/lib/server/env.ts, apps/worker/src/env.ts).

export const privateKeySchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/, "must be a 0x-prefixed 32-byte hex private key");

export const addressSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, "must be a 0x-prefixed 20-byte hex address");

/** Base Sepolia, or local anvil for development. */
export const chainIdSchema = z.coerce
  .number()
  .pipe(z.union([z.literal(CHAIN_ID), z.literal(ANVIL_CHAIN_ID)]));

export const requiredString = z.string().min(1, "is required");

/**
 * Parses env vars against a schema and throws one readable error listing every problem.
 * Empty strings are treated as unset, so `KEY=` in a .env file counts as missing.
 */
export function parseEnv<T extends z.ZodType>(
  schema: T,
  source: Record<string, string | undefined>,
): z.infer<T> {
  const cleaned = Object.fromEntries(
    Object.entries(source).map(([key, value]) => [key, value === "" ? undefined : value]),
  );
  const result = schema.safeParse(cleaned);
  if (!result.success) {
    throw new Error(`Invalid environment variables:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}
