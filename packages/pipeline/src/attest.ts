// Turns an accepted submission into a signed attestation and a queued relayer job.
// Used by the worker after a passing score and by the operator review endpoint after an approval.
import {
  encodeGeohash,
  geohashToBytes8,
  GEOHASH_PRECISION,
  type EvidencePayload,
  type Json,
} from "@treecord/shared";
import type { Address, Hex } from "viem";
import type { Attester, SignedAttestationRecord } from "./attester.js";
import {
  attestationJobKey,
  ensureJob,
  ensureMaybe,
  ensureOk,
  loadSubmission,
  PipelineDbError,
  transitionSubmission,
  UNIQUE_VIOLATION,
  type Db,
  type SubmissionRow,
  type SubmissionStatus,
} from "./db.js";

export interface AttestDeps {
  db: Db;
  attester: Attester;
  /** Current chain time in seconds. Attestation expiry is based on it. */
  chainNow: () => Promise<number>;
}

export interface Review {
  reviewerProfileId: string;
  note: string;
}

export type AttestOutcome =
  | { status: "attested"; jobId: string; submission: SubmissionRow }
  | { status: Exclude<SubmissionStatus, "attested">; jobId: null; submission: SubmissionRow };

/**
 * Signs an attestation for a submission in one of `from`, stores it, moves the submission to `attested`, and
 * enqueues the `attestation` relayer job.
 *
 * If another submission for the same tree milestone (or slot planting) was accepted first, the partial
 * unique indexes on submissions refuse the transition and this one is rejected with milestone_already_done.
 * Safe to call again for an already attested submission: it only makes sure the job exists.
 */
export async function attestSubmission(
  deps: AttestDeps,
  submission: SubmissionRow,
  from: SubmissionStatus[],
  review?: Review,
): Promise<AttestOutcome> {
  if (submission.status === "attested") return ensureAttestationJob(deps.db, submission);

  const record = await signFor(deps, submission);
  const reviewFields = review
    ? {
        reviewed_by_profile_id: review.reviewerProfileId,
        review_note: review.note,
        reviewed_at: new Date().toISOString(),
      }
    : {};

  let updated: SubmissionRow | null;
  try {
    updated = await transitionSubmission(deps.db, submission.id, from, {
      status: "attested",
      attestation: record as unknown as Json,
      // uint256 column, written as a decimal string.
      attestation_nonce: record.attestation.nonce as unknown as number,
      ...reviewFields,
    });
  } catch (error) {
    if (!(error instanceof PipelineDbError) || error.pgError.code !== UNIQUE_VIOLATION) throw error;
    const rejected = await transitionSubmission(deps.db, submission.id, from, {
      status: "rejected",
      reject_reasons: [...submission.reject_reasons, "milestone_already_done"],
      ...reviewFields,
    });
    const current = rejected ?? (await mustLoad(deps.db, submission.id));
    return current.status === "attested"
      ? ensureAttestationJob(deps.db, current)
      : {
          status: current.status as Exclude<SubmissionStatus, "attested">,
          jobId: null,
          submission: current,
        };
  }

  const current = updated ?? (await mustLoad(deps.db, submission.id));
  if (current.status !== "attested") {
    return { status: current.status, jobId: null, submission: current };
  }

  if (current.challenge_id) {
    ensureMaybe(
      await deps.db
        .from("challenges")
        .update({ fulfilled_submission_id: current.id })
        .eq("id", current.challenge_id)
        .is("fulfilled_submission_id", null),
      "fulfil challenge",
    );
  }
  return ensureAttestationJob(deps.db, current);
}

/** Makes sure an attested submission has its relayer job. Idempotent per submission. */
export async function ensureAttestationJob(
  db: Db,
  submission: SubmissionRow,
): Promise<{ status: "attested"; jobId: string; submission: SubmissionRow }> {
  const record = submission.attestation as unknown as SignedAttestationRecord | null;
  if (!record) throw new Error(`Submission ${submission.id} is attested but has no attestation`);
  const jobId = await ensureJob(
    db,
    "attestation",
    {
      submissionId: submission.id,
      nonce: record.attestation.nonce,
      attestation: record.attestation as unknown as Json,
      signature: record.signature,
    },
    attestationJobKey(submission.id),
    submission.profile_id,
  );
  return { status: "attested", jobId, submission };
}

/**
 * Re-signs an attested submission whose attestation expired before it reached the chain, with a fresh nonce
 * and expiry, and points its relayer job at the new signature. An expired attestation can never be accepted
 * (the gateway checks block.timestamp > expiry), so replacing it cannot cause a double submission.
 * Returns null when the submission is no longer attested with `expiredNonce` (another worker re-signed it).
 */
export async function resignAttestation(
  deps: AttestDeps,
  submission: SubmissionRow,
  expiredNonce: string,
): Promise<{ record: SignedAttestationRecord; submission: SubmissionRow } | null> {
  const record = await signFor(deps, submission);
  const updated = ensureMaybe(
    await deps.db
      .from("submissions")
      .update({
        attestation: record as unknown as Json,
        attestation_nonce: record.attestation.nonce as unknown as number,
      })
      .eq("id", submission.id)
      .eq("status", "attested")
      .eq("attestation_nonce", expiredNonce as unknown as number)
      .select("id"),
    "store re-signed attestation",
  );
  if (!updated || updated.length === 0) return null;

  ensureMaybe(
    await deps.db
      .from("relayer_jobs")
      .update({
        payload: {
          submissionId: submission.id,
          nonce: record.attestation.nonce,
          attestation: record.attestation as unknown as Json,
          signature: record.signature,
        },
      })
      .eq("idempotency_key", attestationJobKey(submission.id)),
    "update attestation job",
  );
  const current = await mustLoad(deps.db, submission.id);
  return { record, submission: current };
}

async function signFor(
  deps: AttestDeps,
  submission: SubmissionRow,
): Promise<SignedAttestationRecord> {
  const payload = submission.payload as unknown as EvidencePayload | null;
  if (!payload || !submission.evidence_hash || submission.policy_score === null) {
    throw new Error(
      `Submission ${submission.id} is missing payload, evidence hash or policy score`,
    );
  }
  const profile = ensureOk(
    await deps.db
      .from("profiles")
      .select("wallet_address")
      .eq("id", submission.profile_id)
      .single(),
    "load planter wallet",
  );
  if (!profile.wallet_address) throw new Error(`Planter of ${submission.id} has no wallet`);

  return deps.attester.sign(
    {
      kind: submission.kind,
      campaign: submission.campaign_address as Address,
      slotId: BigInt(submission.slot_id ?? 0),
      treeId: BigInt(submission.tree_id ?? 0),
      planter: profile.wallet_address as Address,
      milestone: submission.milestone,
      evidenceHash: submission.evidence_hash as Hex,
      geohash: geohashToBytes8(encodeGeohash(payload.lat, payload.lon, GEOHASH_PRECISION)),
      score: submission.policy_score,
    },
    await deps.chainNow(),
  );
}

async function mustLoad(db: Db, id: string): Promise<SubmissionRow> {
  const row = await loadSubmission(db, id);
  if (!row) throw new Error(`Submission ${id} disappeared`);
  return row;
}
