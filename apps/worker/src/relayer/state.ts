// Relayer job state transitions. Pure: the relayer computes the update here and writes it.
//
//   pending ──claim──▶ processing ──send──▶ sent ──receipt ok──▶ confirmed
//      ▲                   │                 │
//      └──── retry with ───┴──── revert, ────┘
//            backoff           error or timeout
//                              (failed after max_attempts, or at once for permanent errors)
//
// claim_relayer_jobs counts each claim as an attempt and reclaims jobs left in processing or sent by a
// crashed worker. A job that already has a tx hash checks its receipt before sending anything again.
import type { Database } from "@treecord/shared";

export type JobStatus = Database["public"]["Enums"]["relayer_job_status"];
export type JobKind = Database["public"]["Enums"]["relayer_job_kind"];

export interface JobUpdate {
  status: JobStatus;
  next_attempt_at?: string;
  last_error?: string | null;
  tx_hash?: string | null;
  locked_at?: string | null;
  locked_by?: string | null;
}

export const RETRY_BASE_MS = 15_000;
export const RETRY_MAX_MS = 10 * 60_000;

/** Delay before retry number `attempt` (1-based): 15 s, 30 s, 60 s, 120 s, ... capped at 10 minutes. */
export function retryDelayMs(
  attempt: number,
  baseMs = RETRY_BASE_MS,
  maxMs = RETRY_MAX_MS,
): number {
  const exponent = Math.max(0, attempt - 1);
  return Math.min(maxMs, baseMs * 2 ** exponent);
}

/**
 * Contract errors that will not change by retrying, so the job fails at once. Everything else (RPC errors,
 * timeouts, windows not yet open, flagged trees, unknown reverts) is retried with backoff.
 */
export const PERMANENT_REVERTS = new Set([
  "Unauthorized",
  "AccessControlUnauthorizedAccount",
  "ZeroAddress",
  "ZeroAmount",
  "InvalidSignature",
  "InvalidAttester",
  "InvalidAttestationKind",
  "InvalidScore",
  "InvalidPlantedAttestation",
  "TreeCampaignMismatch",
  "WrongPlanter",
  "MilestoneAlreadySettled",
  "InvalidMilestone",
  "SlotAlreadyPlanted",
  "SlotNotOwned",
  "InvalidSlot",
  "NotEnoughSlots",
  "PlanterCapExceeded",
  "ClaimWindowClosed",
  "WrongCampaignStatus",
  "UnknownCampaign",
  "UnknownTree",
  "TreeNotInCampaign",
  "ReplantDeadlinePassed",
  "EstimateLocked",
  "UnknownBatch",
  "LengthMismatch",
]);

export type Failure = "transient" | "permanent";

/** What a simulation revert means for a job of `kind`. */
export function classifyRevert(
  kind: JobKind,
  errorName: string | null,
): "already_done" | "expired" | Failure {
  if (kind === "attestation" && errorName === "NonceAlreadyUsed") return "already_done";
  if (kind === "attestation" && errorName === "AttestationExpired") return "expired";
  if (errorName !== null && PERMANENT_REVERTS.has(errorName)) return "permanent";
  return "transient";
}

const MAX_ERROR_LENGTH = 1_000;

/** After a failed attempt: retry later, or fail for good when attempts are used up or the error is permanent. */
export function afterFailure(
  job: { attempts: number; max_attempts: number },
  failure: Failure,
  message: string,
  now: Date,
): JobUpdate {
  const lastError = message.slice(0, MAX_ERROR_LENGTH);
  const unlock = { locked_at: null, locked_by: null };
  if (failure === "permanent" || job.attempts >= job.max_attempts) {
    return { status: "failed", last_error: lastError, ...unlock };
  }
  return {
    status: "pending",
    last_error: lastError,
    next_attempt_at: new Date(now.getTime() + retryDelayMs(job.attempts)).toISOString(),
    ...unlock,
  };
}

/** A transaction was broadcast. The job stays locked while the relayer waits for the receipt. */
export function afterSent(txHash: string, now: Date): JobUpdate {
  return { status: "sent", tx_hash: txHash, locked_at: now.toISOString() };
}

/**
 * Check again shortly without treating it as a failure, for example when the receipt did not arrive in time.
 * The tx hash is kept, so the next attempt checks it before sending again.
 */
export function afterReceiptTimeout(
  now: Date,
  delayMs = RETRY_BASE_MS,
  reason = "receipt not seen yet",
): JobUpdate {
  return {
    status: "pending",
    last_error: reason,
    next_attempt_at: new Date(now.getTime() + delayMs).toISOString(),
    locked_at: null,
    locked_by: null,
  };
}

/** Done. `txHash` is null when the work was already on-chain (for example a used attestation nonce). */
export function afterConfirmed(txHash: string | null): JobUpdate {
  return {
    status: "confirmed",
    last_error: null,
    ...(txHash ? { tx_hash: txHash } : {}),
    locked_at: null,
    locked_by: null,
  };
}
