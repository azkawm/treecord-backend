import { applyPolicy, type AiScoreRequest } from "@treecord/shared";
import { describe, expect, it } from "vitest";
import {
  AiServiceError,
  createAiClient,
  HttpAiClient,
  MockAiClient,
  MOCK_AI_HOOKS,
} from "./ai-client.js";

const request: AiScoreRequest = {
  submissionId: "6f1c1a52-3b0e-4c6e-9d65-2f4a8f0d3a11",
  kind: "ALIVE",
  video: { url: "https://storage.example/v.mp4", sha256: "a".repeat(64), durationHintSec: 7.2 },
  species: "Swietenia macrophylla",
  location: { lat: -6.2, lon: 106.816666, acc: 8.5 },
  capturedAt: "2026-10-20T03:15:00.000Z",
  challengeCode: null,
  tree: { treeId: "42", previousKeyframes: [], plantedAt: "2026-10-01T00:00:00.000Z" },
};

const goodResponse = {
  submissionId: request.submissionId,
  modelVersion: "treecord-ai-0.1.0",
  scores: {
    liveness: 0.94,
    recapture: 0.03,
    treePresence: 0.97,
    speciesMatch: 0.71,
    growthConsistency: 0.88,
    duplicate: { maxSimilarity: 0.12, matchedSubmissionId: null },
    challengeVisible: null,
    ndvi: { value: 0.41, source: "sentinel2-sample", date: "2026-10-01" },
  },
  keyframes: [],
  notes: [],
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** An HttpAiClient whose fetch replays the given responses and records calls and sleeps. */
function scripted(responses: (Response | Error)[]) {
  const calls: RequestInit[] = [];
  const sleeps: number[] = [];
  const client = new HttpAiClient({
    baseUrl: "https://ai.example",
    token: "secret",
    backoffMs: 100,
    fetch: async (_url, init) => {
      calls.push(init ?? {});
      const next = responses.shift();
      if (!next) throw new Error("no more scripted responses");
      if (next instanceof Error) throw next;
      return next;
    },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  return { client, calls, sleeps };
}

describe("HttpAiClient", () => {
  it("posts the request with the bearer token and validates the response", async () => {
    const { client, calls } = scripted([jsonResponse(200, goodResponse)]);
    const result = await client.score(request);
    expect(result.scores.liveness).toBe(0.94);
    expect(calls).toHaveLength(1);
    expect(new Headers(calls[0]?.headers).get("authorization")).toBe("Bearer secret");
    expect(JSON.parse(String(calls[0]?.body))).toEqual(request);
  });

  it("retries a 503 three times with exponential backoff", async () => {
    const { client, calls, sleeps } = scripted([
      jsonResponse(503, {}),
      jsonResponse(503, {}),
      jsonResponse(503, {}),
      jsonResponse(200, goodResponse),
    ]);
    await expect(client.score(request)).resolves.toMatchObject({
      modelVersion: "treecord-ai-0.1.0",
    });
    expect(calls).toHaveLength(4);
    expect(sleeps).toEqual([100, 200, 400]);
  });

  it("gives up after the third retry with a retryable error", async () => {
    const { client, calls } = scripted([
      jsonResponse(503, {}),
      jsonResponse(503, {}),
      jsonResponse(503, {}),
      jsonResponse(503, {}),
    ]);
    const error = await client.score(request).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AiServiceError);
    expect(error).toMatchObject({ status: 503, retryable: true });
    expect(calls).toHaveLength(4);
  });

  it("does not retry 400 or 422, and marks them final", async () => {
    for (const status of [400, 422]) {
      const { client, calls } = scripted([jsonResponse(status, { detail: "bad" })]);
      await expect(client.score(request)).rejects.toMatchObject({ status, retryable: false });
      expect(calls).toHaveLength(1);
    }
  });

  it("treats network errors and timeouts as retryable", async () => {
    const network = scripted([new TypeError("fetch failed")]);
    await expect(network.client.score(request)).rejects.toMatchObject({
      status: null,
      retryable: true,
    });
    const timeout = scripted([new DOMException("timed out", "TimeoutError")]);
    await expect(timeout.client.score(request)).rejects.toThrow(/timed out/);
  });

  it("rejects malformed responses and answers for another submission", async () => {
    const malformed = scripted([jsonResponse(200, { ...goodResponse, scores: { liveness: 2 } })]);
    await expect(malformed.client.score(request)).rejects.toMatchObject({ retryable: false });
    const other = scripted([
      jsonResponse(200, { ...goodResponse, submissionId: "11111111-1111-4111-8111-111111111111" }),
    ]);
    await expect(other.client.score(request)).rejects.toThrow(/different submission/);
  });

  it("times out a hanging request", async () => {
    const client = new HttpAiClient({
      baseUrl: "https://ai.example",
      token: "secret",
      timeoutMs: 20,
      fetch: (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
    });
    await expect(client.score(request)).rejects.toMatchObject({ status: null, retryable: true });
  });
});

describe("MockAiClient", () => {
  const mock = new MockAiClient();

  it("passes by default and returns a keyframe", async () => {
    const response = await mock.score(request);
    expect(applyPolicy(response.scores, { kind: "ALIVE", challengeIssued: false })).toMatchObject({
      decision: "pass",
      reasons: [],
    });
    expect(response.keyframes).toHaveLength(1);
    expect(
      (await mock.score({ ...request, kind: "PLANTED", tree: null })).scores.growthConsistency,
    ).toBeNull();
  });

  it("scores a real challenge code as visible", async () => {
    const response = await mock.score({ ...request, challengeCode: "K7Q2" });
    expect(applyPolicy(response.scores, { kind: "ALIVE", challengeIssued: true }).decision).toBe(
      "pass",
    );
  });

  it.each([
    ["FAIL-LIVENESS", "reject", "liveness_low"],
    ["REVIEW-LIVENESS", "needs_review", "liveness_borderline"],
    ["FAIL-RECAPTURE", "reject", "recapture_high"],
    ["FAIL-PRESENCE", "reject", "tree_presence_low"],
    ["FAIL-DUPLICATE", "reject", "duplicate_high"],
    ["FAIL-GROWTH", "reject", "growth_low"],
    ["MISSING-GROWTH", "needs_review", "growth_missing"],
  ])("hook %s gives %s (%s)", async (code, decision, reason) => {
    const response = await mock.score({ ...request, challengeCode: code });
    const result = applyPolicy(response.scores, { kind: "ALIVE", challengeIssued: false });
    expect(result.decision).toBe(decision);
    expect(result.reasons).toContain(reason);
  });

  it("simulates service errors", async () => {
    await expect(mock.score({ ...request, challengeCode: "UNREADABLE" })).rejects.toMatchObject({
      status: 422,
    });
    await expect(mock.score({ ...request, challengeCode: "BUSY" })).rejects.toMatchObject({
      status: 503,
      retryable: true,
    });
    await expect(mock.score({ ...request, challengeCode: "BAD-INPUT" })).rejects.toMatchObject({
      status: 400,
    });
    expect(Object.keys(MOCK_AI_HOOKS)).toContain("FAIL-LIVENESS");
  });
});

describe("createAiClient", () => {
  it("picks the mock or the HTTP client from config", () => {
    expect(createAiClient({ MOCK_AI: true })).toBeInstanceOf(MockAiClient);
    expect(
      createAiClient({
        MOCK_AI: false,
        AI_SERVICE_URL: "https://ai.example",
        AI_SERVICE_TOKEN: "t",
      }),
    ).toBeInstanceOf(HttpAiClient);
    expect(() => createAiClient({ MOCK_AI: false })).toThrow(/required/);
  });
});
