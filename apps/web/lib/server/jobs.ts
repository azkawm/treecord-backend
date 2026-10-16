import "server-only";
import type { Database, Json, Tables } from "@treecord/shared";
import { conflict } from "./errors";
import { getSupabase, PG, unwrap, unwrapMaybe } from "./supabase";

export type RelayerJob = Tables<"relayer_jobs">;
export type RelayerJobKind = Database["public"]["Enums"]["relayer_job_kind"];

/** Statuses that still hold capacity (slots) until the transaction confirms or fails. */
export const OPEN_JOB_STATUSES = ["pending", "processing", "sent"] as const;

interface EnqueueOptions {
  idempotencyKey?: string | undefined;
  profileId?: string | undefined;
}

/**
 * Inserts a relayer job. With an idempotency key, a repeat request returns the original job instead of
 * creating a second one. Reusing a key for a different caller or kind is a 409.
 */
export async function enqueueRelayerJob(
  kind: RelayerJobKind,
  payload: Record<string, Json>,
  options: EnqueueOptions = {},
): Promise<{ job: RelayerJob; created: boolean }> {
  const db = getSupabase();
  if (options.idempotencyKey) {
    const existing = await findByIdempotencyKey(options.idempotencyKey);
    if (existing)
      return { job: assertSameRequest(existing, kind, options.profileId), created: false };
  }

  const inserted = await db
    .from("relayer_jobs")
    .insert({
      kind,
      payload,
      idempotency_key: options.idempotencyKey ?? null,
      created_by_profile_id: options.profileId ?? null,
    })
    .select("*")
    .single();

  if (inserted.error?.code === PG.uniqueViolation && options.idempotencyKey) {
    // Lost a race with an identical request.
    const existing = await findByIdempotencyKey(options.idempotencyKey);
    if (existing)
      return { job: assertSameRequest(existing, kind, options.profileId), created: false };
  }
  return { job: unwrap(inserted, "enqueue relayer job"), created: true };
}

/** Looks up an earlier job for an idempotency key, checking it belongs to the same caller and kind. */
export async function findJobForIdempotencyKey(
  key: string | undefined,
  kind: RelayerJobKind,
  profileId: string,
): Promise<RelayerJob | null> {
  if (!key) return null;
  const existing = await findByIdempotencyKey(key);
  return existing ? assertSameRequest(existing, kind, profileId) : null;
}

async function findByIdempotencyKey(key: string): Promise<RelayerJob | null> {
  return unwrapMaybe(
    await getSupabase().from("relayer_jobs").select("*").eq("idempotency_key", key).maybeSingle(),
    "load job by idempotency key",
  );
}

function assertSameRequest(
  job: RelayerJob,
  kind: RelayerJobKind,
  profileId: string | undefined,
): RelayerJob {
  if (job.kind !== kind || (profileId && job.created_by_profile_id !== profileId)) {
    throw conflict(
      "idempotency_key_reused",
      "This Idempotency-Key was already used for a different request",
    );
  }
  return job;
}

/** Public shape of a job. */
export function jobView(job: RelayerJob, includeError: boolean) {
  return {
    id: job.id,
    kind: job.kind,
    status: job.status,
    txHash: job.tx_hash,
    attempts: job.attempts,
    lastError: includeError ? job.last_error : undefined,
    createdAt: job.created_at,
    updatedAt: job.updated_at,
  };
}
