import { describe, expect, it } from "vitest";
import {
  afterConfirmed,
  afterFailure,
  afterReceiptTimeout,
  afterSent,
  classifyRevert,
  retryDelayMs,
} from "./state.js";

const NOW = new Date("2026-10-20T03:15:00.000Z");
const later = (ms: number) => new Date(NOW.getTime() + ms).toISOString();

describe("retryDelayMs", () => {
  it("doubles from 15 seconds and caps at 10 minutes", () => {
    expect([1, 2, 3, 4, 5].map((n) => retryDelayMs(n))).toEqual([
      15_000, 30_000, 60_000, 120_000, 240_000,
    ]);
    expect(retryDelayMs(20)).toBe(600_000);
    expect(retryDelayMs(0)).toBe(15_000);
  });
});

describe("classifyRevert", () => {
  it("treats a used attestation nonce as already done and an expired one as re-signable", () => {
    expect(classifyRevert("attestation", "NonceAlreadyUsed")).toBe("already_done");
    expect(classifyRevert("attestation", "AttestationExpired")).toBe("expired");
    // The same names mean nothing special for other kinds.
    expect(classifyRevert("claim", "NonceAlreadyUsed")).toBe("transient");
  });

  it("fails at once on reverts that retrying cannot fix", () => {
    expect(classifyRevert("claim", "PlanterCapExceeded")).toBe("permanent");
    expect(classifyRevert("attestation", "MilestoneAlreadySettled")).toBe("permanent");
    expect(classifyRevert("estimate", "EstimateLocked")).toBe("permanent");
  });

  it("retries windows, flags, unknown reverts and non-revert errors", () => {
    expect(classifyRevert("attestation", "MilestoneNotOpen")).toBe("transient");
    expect(classifyRevert("attestation", "WrongTreeStatus")).toBe("transient");
    expect(classifyRevert("claim", null)).toBe("transient");
  });
});

describe("job transitions", () => {
  it("pending with backoff while attempts remain", () => {
    expect(afterFailure({ attempts: 1, max_attempts: 5 }, "transient", "rpc down", NOW)).toEqual({
      status: "pending",
      last_error: "rpc down",
      next_attempt_at: later(15_000),
      locked_at: null,
      locked_by: null,
    });
    expect(
      afterFailure({ attempts: 3, max_attempts: 5 }, "transient", "x", NOW).next_attempt_at,
    ).toBe(later(60_000));
  });

  it("failed on the last attempt or a permanent error", () => {
    expect(
      afterFailure({ attempts: 5, max_attempts: 5 }, "transient", "rpc down", NOW),
    ).toMatchObject({
      status: "failed",
      last_error: "rpc down",
    });
    const permanent = afterFailure({ attempts: 1, max_attempts: 5 }, "permanent", "reverted", NOW);
    expect(permanent.status).toBe("failed");
    expect(permanent.next_attempt_at).toBeUndefined();
  });

  it("truncates long errors", () => {
    const update = afterFailure(
      { attempts: 1, max_attempts: 5 },
      "transient",
      "e".repeat(5000),
      NOW,
    );
    expect(update.last_error).toHaveLength(1000);
  });

  it("sent keeps the lock and records the hash, a timeout keeps the hash for the next check", () => {
    expect(afterSent("0xabc", NOW)).toEqual({
      status: "sent",
      tx_hash: "0xabc",
      locked_at: NOW.toISOString(),
    });
    const timeout = afterReceiptTimeout(NOW);
    expect(timeout).toMatchObject({ status: "pending", next_attempt_at: later(15_000) });
    expect(timeout).not.toHaveProperty("tx_hash");
  });

  it("confirmed clears the error and keeps an earlier hash when none is given", () => {
    expect(afterConfirmed("0xabc")).toEqual({
      status: "confirmed",
      last_error: null,
      tx_hash: "0xabc",
      locked_at: null,
      locked_by: null,
    });
    expect(afterConfirmed(null)).not.toHaveProperty("tx_hash");
  });
});
