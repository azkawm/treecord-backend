// Processes relayer_jobs (prompt 9) in three lanes that run side by side:
// - score:       the evidence scoring pipeline (AI call, policy, attestation signing). No transaction.
// - attestation: VerificationGateway.submit, batched up to 10 per transaction, sent by the relayer wallet.
// - operator:    claim, anchor_assign, estimate, issue and resolve_flag, sent by the operator wallet.
import {
  loadSubmission,
  processScoreJob,
  resignAttestation,
  transitionSubmission,
  ensureMaybe,
  type Db,
  type Logger,
  type ScoreDeps,
} from "@treecord/pipeline";
import {
  attestationJobPayloadSchema,
  scoreJobPayloadSchema,
  type AttestationJobPayload,
  type Tables,
  type TreecordDeployment,
} from "@treecord/shared";
import {
  TransactionNotFoundError,
  TransactionReceiptNotFoundError,
  WaitForTransactionReceiptTimeoutError,
  type Hex,
} from "viem";
import { describeError, revertErrorName, type ChainClients, type Wallet } from "../chain.js";
import type { Metrics } from "../metrics.js";
import { attestationCall, InvalidPayloadError, operatorCall, type PreparedCall } from "./calls.js";
import type { NonceManager } from "./nonces.js";
import {
  afterConfirmed,
  afterFailure,
  afterReceiptTimeout,
  afterSent,
  classifyRevert,
  type JobKind,
  type JobUpdate,
} from "./state.js";

type Job = Tables<"relayer_jobs">;

export const OPERATOR_KINDS: JobKind[] = [
  "claim",
  "anchor_assign",
  "estimate",
  "issue",
  "resolve_flag",
];

/** Re-sign an attestation this close to its expiry instead of sending one that may land too late. */
const EXPIRY_MARGIN_SEC = 30;

export interface RelayerOptions {
  db: Db;
  clients: ChainClients;
  deployment: TreecordDeployment;
  nonces: NonceManager;
  log: Logger;
  metrics: Metrics;
  /** Recorded in relayer_jobs.locked_by. */
  workerId: string;
  /** AI client, attester and chain clock for score jobs and re-signing. */
  scoreDeps: ScoreDeps;
  receiptTimeoutMs?: number;
  attestationBatchSize?: number;
  operatorBatchSize?: number;
  scoreBatchSize?: number;
}

export class Relayer {
  private readonly receiptTimeoutMs: number;

  constructor(private readonly options: RelayerOptions) {
    this.receiptTimeoutMs = options.receiptTimeoutMs ?? 90_000;
  }

  // -------------------------------------------------------------------------
  // Score lane
  // -------------------------------------------------------------------------

  /** Claims and runs due score jobs. Returns how many were claimed. */
  async tickScore(): Promise<number> {
    const jobs = await this.claim(["score"], this.options.scoreBatchSize ?? 3);
    await Promise.all(jobs.map((job) => this.runScoreJob(job)));
    return jobs.length;
  }

  private async runScoreJob(job: Job): Promise<void> {
    try {
      const parsed = scoreJobPayloadSchema.safeParse(job.payload);
      if (!parsed.success) throw new InvalidPayloadError("score", parsed.error.message);
      const outcome = await processScoreJob(this.options.scoreDeps, parsed.data.submissionId, {
        finalAttempt: job.attempts >= job.max_attempts,
      });
      await this.update(job, afterConfirmed(null));
      this.options.metrics.inc(`relayer.score.${outcome.skipped ? "skipped" : outcome.status}`);
      this.options.log.info(
        { job: job.id, submission: parsed.data.submissionId, status: outcome.status },
        "scored submission",
      );
    } catch (error) {
      await this.fail(job, error);
    }
  }

  // -------------------------------------------------------------------------
  // Attestation lane
  // -------------------------------------------------------------------------

  /** Claims up to 10 attestation jobs, drops the ones that would revert, and sends the rest in one tx. */
  async tickAttestations(): Promise<number> {
    const { clients, deployment } = this.options;
    const jobs = await this.claim(["attestation"], this.options.attestationBatchSize ?? 10);
    const ready: { job: Job; payload: AttestationJobPayload }[] = [];

    for (const job of jobs) {
      try {
        const parsed = attestationJobPayloadSchema.safeParse(job.payload);
        if (!parsed.success) throw new InvalidPayloadError("attestation", parsed.error.message);
        if (await this.settledBySentTx(job)) continue;

        let payload = parsed.data;
        const chainNow = await this.options.scoreDeps.chainNow();
        if (chainNow + EXPIRY_MARGIN_SEC >= Number(payload.attestation.expiry)) {
          const renewed = await this.resign(payload);
          if (!renewed) {
            await this.update(
              job,
              afterReceiptTimeout(new Date(), 1_000, "could not re-sign now, will reload the job"),
            );
            continue;
          }
          payload = renewed;
        }

        try {
          await attestationCall([payload], deployment).simulate(
            clients.public,
            clients.relayer.account,
          );
        } catch (error) {
          const verdict = classifyRevert("attestation", revertErrorName(error));
          if (verdict === "already_done") {
            await this.update(job, afterConfirmed(null));
            this.options.metrics.inc("relayer.attestation.alreadyOnChain");
            continue;
          }
          if (verdict === "expired") {
            await this.resign(payload);
            await this.update(
              job,
              afterReceiptTimeout(new Date(), 1_000, "attestation expired, re-signed"),
            );
            continue;
          }
          throw error;
        }
        ready.push({ job, payload });
      } catch (error) {
        await this.fail(job, error);
      }
    }

    if (ready.length > 0) {
      const call = attestationCall(
        ready.map((r) => r.payload),
        deployment,
      );
      await this.broadcast(
        ready.map((r) => r.job),
        call,
      );
    }
    return jobs.length;
  }

  /** Signs again with a fresh nonce. Returns the new payload, or null if another worker already did. */
  private async resign(payload: AttestationJobPayload): Promise<AttestationJobPayload | null> {
    const submission = await loadSubmission(this.options.db, payload.submissionId);
    if (!submission || submission.status !== "attested") return null;
    const renewed = await resignAttestation(this.options.scoreDeps, submission, payload.nonce);
    if (!renewed) return null;
    this.options.metrics.inc("relayer.attestation.resigned");
    this.options.log.info(
      {
        submission: submission.id,
        oldNonce: payload.nonce,
        nonce: renewed.record.attestation.nonce,
      },
      "re-signed expired attestation",
    );
    return {
      submissionId: submission.id,
      nonce: renewed.record.attestation.nonce,
      attestation: renewed.record.attestation,
      signature: renewed.record.signature,
    };
  }

  // -------------------------------------------------------------------------
  // Operator lane
  // -------------------------------------------------------------------------

  /** Claims due operator jobs and sends them one after another. */
  async tickOperator(): Promise<number> {
    const jobs = await this.claim(OPERATOR_KINDS, this.options.operatorBatchSize ?? 5);
    for (const job of jobs) {
      try {
        if (await this.settledBySentTx(job)) continue;
        const call = operatorCall(job.kind, job.payload, this.options.deployment);
        await call.simulate(this.options.clients.public, this.options.clients.operator.account);
        await this.broadcast([job], call);
      } catch (error) {
        await this.fail(job, error);
      }
    }
    return jobs.length;
  }

  // -------------------------------------------------------------------------
  // Shared steps
  // -------------------------------------------------------------------------

  private async claim(kinds: JobKind[], limit: number): Promise<Job[]> {
    const { data, error } = await this.options.db.rpc("claim_relayer_jobs", {
      p_kinds: kinds,
      p_limit: limit,
      p_worker: this.options.workerId,
    });
    if (error) throw new Error(`claim_relayer_jobs failed: ${error.message}`);
    return data ?? [];
  }

  private wallet(name: PreparedCall["wallet"]): Wallet {
    return name === "operator" ? this.options.clients.operator : this.options.clients.relayer;
  }

  /**
   * For a job that already broadcast a transaction on an earlier attempt: confirms it if mined, or waits
   * if still pending. Returns false when the earlier transaction failed or vanished, so the job is sent again.
   */
  private async settledBySentTx(job: Job): Promise<boolean> {
    if (!job.tx_hash) return false;
    const state = await this.receiptState(job.tx_hash as Hex);
    if (state === "success") {
      await this.confirm([job], job.tx_hash as Hex);
      return true;
    }
    if (state === "pending") {
      await this.update(job, afterReceiptTimeout(new Date()));
      return true;
    }
    return false;
  }

  private async receiptState(hash: Hex): Promise<"success" | "reverted" | "pending" | "missing"> {
    const client = this.options.clients.public;
    try {
      return (await client.getTransactionReceipt({ hash })).status;
    } catch (error) {
      if (!(error instanceof TransactionReceiptNotFoundError)) throw error;
    }
    try {
      await client.getTransaction({ hash });
      return "pending";
    } catch (error) {
      if (error instanceof TransactionNotFoundError) return "missing";
      throw error;
    }
  }

  /** Sends one transaction for `jobs`, records it, and waits for the receipt. */
  private async broadcast(jobs: Job[], call: PreparedCall): Promise<void> {
    const { clients, nonces, log, metrics } = this.options;
    const wallet = this.wallet(call.wallet);
    let hash: Hex;
    try {
      hash = await nonces.withNonce(wallet.account.address, (nonce) => call.send(wallet, nonce));
    } catch (error) {
      for (const job of jobs) await this.fail(job, error);
      return;
    }

    const now = new Date();
    for (const job of jobs) await this.update(job, afterSent(hash, now));
    await this.onSent(jobs, hash);
    log.info({ tx: hash, jobs: jobs.map((j) => j.id), call: call.description }, "transaction sent");
    metrics.inc(`relayer.${jobs[0]?.kind ?? "unknown"}.sent`);

    let status: "success" | "reverted";
    try {
      const receipt = await clients.public.waitForTransactionReceipt({
        hash,
        timeout: this.receiptTimeoutMs,
      });
      status = receipt.status;
    } catch (error) {
      if (!(error instanceof WaitForTransactionReceiptTimeoutError)) throw error;
      for (const job of jobs) await this.update(job, afterReceiptTimeout(new Date()));
      log.warn({ tx: hash }, "receipt not seen in time, will check again");
      return;
    }

    if (status === "success") {
      await this.confirm(jobs, hash);
      return;
    }
    for (const job of jobs) await this.fail(job, new Error(`transaction ${hash} reverted`));
  }

  private async confirm(jobs: Job[], hash: Hex): Promise<void> {
    for (const job of jobs) {
      await this.update(job, afterConfirmed(hash));
      this.options.metrics.inc(`relayer.${job.kind}.confirmed`);
    }
  }

  private async fail(job: Job, error: unknown): Promise<void> {
    const { log, metrics } = this.options;
    const message = describeError(error);
    const failure =
      error instanceof InvalidPayloadError
        ? "permanent"
        : classifyRevert(job.kind, revertErrorName(error)) === "permanent"
          ? "permanent"
          : "transient";
    const update = afterFailure(job, failure, message, new Date());
    try {
      await this.update(job, update);
      if (update.status === "failed") await this.onFailed(job, message);
    } catch (writeError) {
      // The job stays locked and is reclaimed after the stale timeout.
      log.error({ job: job.id, error: describeError(writeError) }, "could not record job failure");
    }
    metrics.inc(`relayer.${job.kind}.${update.status === "failed" ? "failed" : "retried"}`);
    log.warn(
      {
        job: job.id,
        kind: job.kind,
        attempts: job.attempts,
        status: update.status,
        error: message,
      },
      "job attempt failed",
    );
  }

  /** The attestation's tx hash is shown on the submission while it is in flight. */
  private async onSent(jobs: Job[], hash: Hex): Promise<void> {
    const ids = jobs
      .filter((job) => job.kind === "attestation")
      .map((job) => (job.payload as { submissionId?: string }).submissionId)
      .filter((id): id is string => typeof id === "string");
    if (ids.length === 0) return;
    ensureMaybe(
      await this.options.db
        .from("submissions")
        .update({ tx_hash: hash })
        .in("id", ids)
        .eq("status", "attested"),
      "record attestation tx",
    );
  }

  /** A permanently failed attestation fails its submission, with the reason shown to the planter. */
  private async onFailed(job: Job, message: string): Promise<void> {
    if (job.kind !== "attestation") return;
    const submissionId = (job.payload as { submissionId?: string }).submissionId;
    if (!submissionId) return;
    await transitionSubmission(this.options.db, submissionId, ["attested"], {
      status: "failed",
      error: message,
    });
  }

  private async update(job: Job, update: JobUpdate): Promise<void> {
    ensureMaybe(
      await this.options.db.from("relayer_jobs").update(update).eq("id", job.id),
      "update relayer job",
    );
  }
}
