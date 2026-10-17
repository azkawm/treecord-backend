// Client for the AI scoring service (AI_SERVICE_INTERFACE.md). The service only scores; policy and signing
// happen in the backend.
import {
  aiScoreResponseSchema,
  type AiScoreRequest,
  type AiScoreResponse,
  type AiScores,
} from "@treecord/shared";

export interface AiClient {
  score(request: AiScoreRequest): Promise<AiScoreResponse>;
}

/**
 * A failed scoring call. `status` is the HTTP status, or null when the service was unreachable or timed out.
 * `retryable` failures (503 after retries, other 5xx, network errors, timeouts) should be retried by the job
 * queue. The rest are final: 422 means the video is unreadable, anything else fails the submission.
 */
export class AiServiceError extends Error {
  constructor(
    readonly status: number | null,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "AiServiceError";
  }
}

// ---------------------------------------------------------------------------
// HTTP client
// ---------------------------------------------------------------------------

export interface HttpAiClientOptions {
  baseUrl: string;
  token: string;
  /** Per-request timeout. The interface allows the service up to 60 seconds. */
  timeoutMs?: number;
  /** Retries after a 503 response. */
  maxRetries?: number;
  /** First backoff delay. Doubles on every retry. */
  backoffMs?: number;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class HttpAiClient implements AiClient {
  private readonly url: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly backoffMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: HttpAiClientOptions) {
    this.url = new URL("/v1/score", options.baseUrl).toString();
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.maxRetries = options.maxRetries ?? 3;
    this.backoffMs = options.backoffMs ?? 1_000;
    this.fetchImpl = options.fetch ?? fetch;
    this.sleep = options.sleep ?? defaultSleep;
  }

  async score(request: AiScoreRequest): Promise<AiScoreResponse> {
    for (let attempt = 0; ; attempt++) {
      let response: Response;
      try {
        response = await this.fetchImpl(this.url, {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.options.token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(request),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (error) {
        const timedOut = error instanceof DOMException && error.name === "TimeoutError";
        throw new AiServiceError(
          null,
          timedOut
            ? `AI service timed out after ${this.timeoutMs} ms`
            : `AI service unreachable: ${String(error)}`,
          true,
        );
      }

      if (response.status === 503 && attempt < this.maxRetries) {
        await response.body?.cancel();
        await this.sleep(this.backoffMs * 2 ** attempt);
        continue;
      }

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new AiServiceError(
          response.status,
          `AI service returned ${response.status}: ${text.slice(0, 500)}`,
          response.status >= 500,
        );
      }

      const body: unknown = await response.json().catch(() => undefined);
      const parsed = aiScoreResponseSchema.safeParse(body);
      if (!parsed.success) {
        throw new AiServiceError(
          response.status,
          `AI service returned an invalid response: ${parsed.error.message}`,
          false,
        );
      }
      if (parsed.data.submissionId !== request.submissionId) {
        throw new AiServiceError(
          response.status,
          "AI service answered for a different submission",
          false,
        );
      }
      return parsed.data;
    }
  }
}

// ---------------------------------------------------------------------------
// Mock client (MOCK_AI=true)
// ---------------------------------------------------------------------------

export const MOCK_MODEL_VERSION = "treecord-ai-mock-0.1.0";

/** A 1x1 grey JPEG, returned as the mock keyframe so keyframe storage is exercised end to end. */
export const MOCK_KEYFRAME_DATA_URL =
  "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=";

type ScoreOverride = Partial<Omit<AiScores, "duplicate">> & { duplicateSimilarity?: number };

/**
 * Deterministic failures for tests and demos, selected by the challenge field of the signed payload.
 * Anything else gets passing scores.
 */
export const MOCK_AI_HOOKS: Record<string, ScoreOverride | "unreadable" | "busy" | "bad_input"> = {
  "FAIL-LIVENESS": { liveness: 0.4 },
  "REVIEW-LIVENESS": { liveness: 0.75 },
  "FAIL-RECAPTURE": { recapture: 0.6 },
  "FAIL-PRESENCE": { treePresence: 0.3 },
  "FAIL-DUPLICATE": { duplicateSimilarity: 0.95 },
  "FAIL-GROWTH": { growthConsistency: 0.2 },
  "MISSING-GROWTH": { growthConsistency: null },
  UNREADABLE: "unreadable",
  BUSY: "busy",
  "BAD-INPUT": "bad_input",
};

/** Returns passing scores unless the challenge code names a hook in MOCK_AI_HOOKS. */
export class MockAiClient implements AiClient {
  readonly requests: AiScoreRequest[] = [];

  async score(request: AiScoreRequest): Promise<AiScoreResponse> {
    this.requests.push(request);
    const hook = request.challengeCode ? MOCK_AI_HOOKS[request.challengeCode] : undefined;
    if (hook === "unreadable") throw new AiServiceError(422, "Mock: video unreadable", false);
    if (hook === "busy") throw new AiServiceError(503, "Mock: service busy", true);
    if (hook === "bad_input") throw new AiServiceError(400, "Mock: bad input", false);

    const override: ScoreOverride = typeof hook === "object" ? hook : {};
    const { duplicateSimilarity, ...scoreOverride } = override;
    const isRealChallenge = request.challengeCode !== null && hook === undefined;
    return {
      submissionId: request.submissionId,
      modelVersion: MOCK_MODEL_VERSION,
      scores: {
        liveness: 0.93,
        recapture: 0.04,
        treePresence: 0.95,
        speciesMatch: 0.8,
        growthConsistency: request.kind === "PLANTED" ? null : 0.86,
        challengeVisible: isRealChallenge ? 0.95 : null,
        ndvi: { value: 0.42, source: "mock", date: request.capturedAt.slice(0, 10) },
        ...scoreOverride,
        duplicate: { maxSimilarity: duplicateSimilarity ?? 0.1, matchedSubmissionId: null },
      },
      keyframes: [MOCK_KEYFRAME_DATA_URL],
      notes: ["Mock scores. Set MOCK_AI=false to call the real service."],
    };
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface AiClientConfig {
  MOCK_AI: boolean;
  AI_SERVICE_URL?: string | undefined;
  AI_SERVICE_TOKEN?: string | undefined;
}

/** The mock when MOCK_AI is true, otherwise the HTTP client. */
export function createAiClient(config: AiClientConfig): AiClient {
  if (config.MOCK_AI) return new MockAiClient();
  if (!config.AI_SERVICE_URL || !config.AI_SERVICE_TOKEN) {
    throw new Error("AI_SERVICE_URL and AI_SERVICE_TOKEN are required when MOCK_AI is false");
  }
  return new HttpAiClient({ baseUrl: config.AI_SERVICE_URL, token: config.AI_SERVICE_TOKEN });
}
