import "server-only";
import { createClient, type PostgrestError, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@treecord/shared";
import { getServerEnv } from "./env";
import { ApiError } from "./errors";

export type Db = SupabaseClient<Database>;

let client: Db | undefined;

/**
 * Service-role Supabase client. Bypasses RLS, so it must never reach the browser.
 * Read uint256 columns with a `::text` cast (see docs/database.md).
 */
export function getSupabase(): Db {
  if (!client) {
    const env = getServerEnv();
    client = createClient<Database>(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return client;
}

/** Postgres error codes the API maps to client errors. */
export const PG = {
  uniqueViolation: "23505",
  foreignKeyViolation: "23503",
  checkViolation: "23514",
} as const;

/** Throws a 500 for an unexpected database error, keeping the Postgres detail out of the response. */
export function dbFailure(error: PostgrestError, context: string): never {
  console.error(`Database error during ${context}`, error);
  throw new ApiError(500, "database_error", "Database request failed");
}

interface Result<T> {
  data: T;
  error: PostgrestError | null;
}

/** Data of a query that must return rows (`.single()`, lists, inserts with `.select()`). Throws on error. */
export function unwrap<T>(result: Result<T>, context: string): NonNullable<T> {
  if (result.error) dbFailure(result.error, context);
  return result.data as NonNullable<T>;
}

/** Data of a `.maybeSingle()` query: the row or null. Throws on error. */
export function unwrapMaybe<T>(result: Result<T>, context: string): T {
  if (result.error) dbFailure(result.error, context);
  return result.data;
}

/** Throws on error. For count-only (`head: true`) queries and writes without a returned row. */
export function check(result: { error: PostgrestError | null }, context: string): void {
  if (result.error) dbFailure(result.error, context);
}
