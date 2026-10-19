// Thin client for the Treecord API. Each demo user signs in with a wallet-signature token, which the API
// accepts when it runs with DEMO_WALLET_AUTH=true.
import { createWalletToken } from "@treecord/shared";
import { sleep } from "./chain.js";
import { demoEnv } from "./env.js";
import { info } from "./log.js";
import type { DemoUser } from "./users.js";

export class ApiRequestError extends Error {
  constructor(
    readonly method: string,
    readonly path: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    const error = (body as { error?: { code?: string; message?: string } } | null)?.error;
    super(`${method} ${path} returned ${status}${error ? ` ${error.code}: ${error.message}` : ""}`);
    this.name = "ApiRequestError";
  }

  get code(): string | undefined {
    return (this.body as { error?: { code?: string } } | null)?.error?.code;
  }
}

export interface Job {
  id: string;
  kind: string;
  status: "pending" | "processing" | "sent" | "confirmed" | "failed";
  txHash: string | null;
  lastError?: string | null;
}

export interface Submission {
  id: string;
  kind: string;
  status: string;
  reasons: string[];
  policyScore: number | null;
  treeId: number | null;
  txHash: string | null;
}

interface RequestOptions {
  body?: unknown;
  headers?: Record<string, string>;
  /** Statuses returned instead of thrown. */
  allow?: number[];
}

const TOKEN_LIFETIME_SECONDS = 6 * 60 * 60;

export class DemoApi {
  private readonly tokens = new Map<string, { token: string; expiresAt: number }>();

  constructor(
    readonly baseUrl: string,
    private readonly chainId: number,
  ) {}

  private async token(user: DemoUser): Promise<string> {
    const nowSec = Math.floor(Date.now() / 1000);
    const cached = this.tokens.get(user.key);
    if (cached && cached.expiresAt - 300 > nowSec) return cached.token;
    const token = await createWalletToken({
      address: user.address,
      chainId: this.chainId,
      nowSec,
      lifetimeSec: TOKEN_LIFETIME_SECONDS,
      signMessage: (message) => user.account.signMessage({ message }),
    });
    this.tokens.set(user.key, { token, expiresAt: nowSec + TOKEN_LIFETIME_SECONDS });
    return token;
  }

  async request<T>(
    user: DemoUser | null,
    method: "GET" | "POST",
    path: string,
    options: RequestOptions = {},
  ): Promise<{ status: number; body: T }> {
    const headers: Record<string, string> = { ...options.headers };
    if (user) headers.authorization = `Bearer ${await this.token(user)}`;
    if (options.body !== undefined) headers["content-type"] = "application/json";
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    const text = await response.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = { error: { code: "not_json", message: text.slice(0, 200) } };
    }
    if (!response.ok && !options.allow?.includes(response.status)) {
      throw new ApiRequestError(method, path, response.status, body);
    }
    return { status: response.status, body: body as T };
  }

  async get<T>(user: DemoUser | null, path: string): Promise<T> {
    return (await this.request<T>(user, "GET", path)).body;
  }

  async post<T>(
    user: DemoUser,
    path: string,
    body: unknown,
    headers?: Record<string, string>,
  ): Promise<T> {
    return (await this.request<T>(user, "POST", path, { body, headers })).body;
  }

  /** Polls a relayer job until the worker confirmed it. Throws if it failed. */
  async waitForJob(user: DemoUser, jobId: string, label: string): Promise<Job> {
    const job = await waitFor(label, async () => {
      const { job } = await this.get<{ job: Job }>(user, `/api/jobs/${jobId}`);
      return job.status === "confirmed" || job.status === "failed" ? job : null;
    });
    if (job.status === "failed") {
      throw new Error(`${label} failed${job.lastError ? `: ${job.lastError}` : ""}`);
    }
    return job;
  }

  /** Polls a submission until it lands on-chain. Throws if it was rejected, failed or needs review. */
  async waitForSubmission(
    user: DemoUser,
    submissionId: string,
    label: string,
  ): Promise<Submission> {
    const final = ["onchain", "rejected", "failed", "needs_review"];
    const submission = await waitFor(label, async () => {
      const { submission } = await this.get<{ submission: Submission }>(
        user,
        `/api/evidence/${submissionId}`,
      );
      return final.includes(submission.status) ? submission : null;
    });
    if (submission.status !== "onchain") {
      throw new Error(
        `${label} ended ${submission.status}${submission.reasons.length ? ` (${submission.reasons.join(", ")})` : ""}`,
      );
    }
    return submission;
  }
}

/** Polls `check` every few seconds until it returns a value. Gives up after DEMO_WAIT_SECONDS. */
export async function waitFor<T>(
  label: string,
  check: () => Promise<T | null | undefined | false>,
  intervalMs = 2_000,
): Promise<T> {
  const deadline = Date.now() + demoEnv().DEMO_WAIT_SECONDS * 1000;
  let announced = false;
  for (;;) {
    const result = await check();
    if (result) return result;
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${label}. Are the web app and the worker running?`);
    }
    if (!announced && Date.now() + demoEnv().DEMO_WAIT_SECONDS * 1000 - deadline > 20_000) {
      info(`still waiting for ${label}...`);
      announced = true;
    }
    await sleep(intervalMs);
  }
}
