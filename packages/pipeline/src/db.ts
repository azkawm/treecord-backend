import type { PostgrestError, SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json, Tables } from "@treecord/shared";

export type Db = SupabaseClient<Database>;
export type SubmissionStatus = Database["public"]["Enums"]["submission_status"];
export type RelayerJobKind = Database["public"]["Enums"]["relayer_job_kind"];

/** Postgres unique violation. */
export const UNIQUE_VIOLATION = "23505";

/** Submission columns, with the uint256 nonce cast to text so it survives PostgREST. */
export const SUBMISSION_COLUMNS =
  "id, profile_id, device_id, campaign_address, slot_id, tree_id, kind, milestone, video_path, video_sha256, " +
  "size_bytes, duration_sec, payload, canonical, signature, evidence_hash, captured_at, received_at, status, " +
  "reject_reasons, ai_response, keyframe_paths, policy_decision, policy_score, attestation, " +
  "attestation_nonce::text, challenge_id, tx_hash, error, reviewed_by_profile_id, review_note, reviewed_at, " +
  "created_at, updated_at";

export type SubmissionRow = Omit<Tables<"submissions">, "attestation_nonce"> & {
  attestation_nonce: string | null;
};

/** Storage buckets (supabase/migrations/20261016120400_security.sql). */
export const EVIDENCE_BUCKET = "evidence";
export const KEYFRAMES_BUCKET = "keyframes";

/** Lifetime of signed read URLs handed to the AI service. */
export const SIGNED_READ_URL_SECONDS = 15 * 60;

/** Minimal pino-compatible logger. */
export interface Logger {
  info(object: object, message: string): void;
  warn(object: object, message: string): void;
  error(object: object, message: string): void;
}

export const consoleLogger: Logger = {
  info: (object, message) => console.info(message, object),
  warn: (object, message) => console.warn(message, object),
  error: (object, message) => console.error(message, object),
};

export class PipelineDbError extends Error {
  constructor(
    context: string,
    readonly pgError: PostgrestError,
  ) {
    super(`Database error during ${context}: ${pgError.message}`);
    this.name = "PipelineDbError";
  }
}

interface Result<T> {
  data: T;
  error: PostgrestError | null;
}

/** Data of a query that returns rows (`.single()`, lists, writes with `.select()`). Throws on error. */
export function ensureOk<T>(result: Result<T>, context: string): NonNullable<T> {
  if (result.error) throw new PipelineDbError(context, result.error);
  return result.data as NonNullable<T>;
}

/** Data of a `.maybeSingle()` query, or for writes without a returned row. Throws on error. */
export function ensureMaybe<T>(result: Result<T>, context: string): T {
  if (result.error) throw new PipelineDbError(context, result.error);
  return result.data;
}

export async function loadSubmission(db: Db, id: string): Promise<SubmissionRow | null> {
  const row = ensureMaybe(
    await db.from("submissions").select(SUBMISSION_COLUMNS).eq("id", id).maybeSingle(),
    "load submission",
  );
  return row as unknown as SubmissionRow | null;
}

/**
 * Updates a submission only while it is in one of `from`. Returns the updated row, or null when the
 * submission had already moved on (another request or job got there first).
 */
export async function transitionSubmission(
  db: Db,
  id: string,
  from: SubmissionStatus[],
  changes: Database["public"]["Tables"]["submissions"]["Update"],
): Promise<SubmissionRow | null> {
  const result = await db
    .from("submissions")
    .update(changes)
    .eq("id", id)
    .in("status", from)
    .select(SUBMISSION_COLUMNS)
    .maybeSingle();
  return ensureMaybe(result, "update submission") as unknown as SubmissionRow | null;
}

/**
 * Inserts a relayer job under a natural idempotency key, or returns the existing job's id when one was
 * already created with that key.
 */
export async function ensureJob(
  db: Db,
  kind: RelayerJobKind,
  payload: { [key: string]: Json },
  idempotencyKey: string,
  profileId: string | null,
): Promise<string> {
  const inserted = await db
    .from("relayer_jobs")
    .insert({ kind, payload, idempotency_key: idempotencyKey, created_by_profile_id: profileId })
    .select("id")
    .single();
  if (inserted.error?.code === UNIQUE_VIOLATION) {
    const existing = ensureOk(
      await db.from("relayer_jobs").select("id").eq("idempotency_key", idempotencyKey).single(),
      "load existing job",
    );
    return existing.id;
  }
  return ensureOk(inserted, "insert relayer job").id;
}

/** Idempotency key of the score job for a submission. */
export const scoreJobKey = (submissionId: string) => `score:${submissionId}`;
/** Idempotency key of the attestation job for a submission. */
export const attestationJobKey = (submissionId: string) => `attestation:${submissionId}`;
