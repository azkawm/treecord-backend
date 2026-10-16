import { describe, expect, it } from "vitest";
import type { AiScores } from "./ai.js";
import type { EvidenceKind } from "./constants.js";
import { applyPolicy } from "./policy.js";

/** Comfortably passing scores for an ALIVE check-in. */
function scores(
  overrides: Partial<Omit<AiScores, "duplicate">> & { duplicate?: number } = {},
): AiScores {
  const { duplicate, ...rest } = overrides;
  return {
    liveness: 0.95,
    recapture: 0.05,
    treePresence: 0.95,
    speciesMatch: 0.7,
    growthConsistency: 0.9,
    duplicate: { maxSimilarity: duplicate ?? 0.1, matchedSubmissionId: null },
    challengeVisible: null,
    ndvi: { value: 0.41, source: "sentinel2-sample", date: "2026-10-01" },
    ...rest,
  };
}

const alive = { kind: "ALIVE" as EvidenceKind, challengeIssued: false };

describe("applyPolicy decisions", () => {
  it("passes clean scores with no reasons", () => {
    expect(applyPolicy(scores(), alive)).toMatchObject({ decision: "pass", reasons: [] });
  });

  // [description, overrides, expected decision, expected reasons]
  const cases: [string, Parameters<typeof scores>[0], string, string[]][] = [
    // liveness: reject < 0.70, review [0.70, 0.80)
    ["liveness 0.69 rejects", { liveness: 0.69 }, "reject", ["liveness_low"]],
    ["liveness 0.70 is borderline", { liveness: 0.7 }, "needs_review", ["liveness_borderline"]],
    ["liveness 0.79 is borderline", { liveness: 0.79 }, "needs_review", ["liveness_borderline"]],
    ["liveness 0.80 passes", { liveness: 0.8 }, "pass", []],
    // treePresence: reject < 0.70, review [0.70, 0.80)
    ["treePresence 0.69 rejects", { treePresence: 0.69 }, "reject", ["tree_presence_low"]],
    [
      "treePresence 0.70 is borderline",
      { treePresence: 0.7 },
      "needs_review",
      ["tree_presence_borderline"],
    ],
    ["treePresence 0.80 passes", { treePresence: 0.8 }, "pass", []],
    // recapture: reject > 0.30, review (0.20, 0.30]
    ["recapture 0.31 rejects", { recapture: 0.31 }, "reject", ["recapture_high"]],
    ["recapture 0.30 is borderline", { recapture: 0.3 }, "needs_review", ["recapture_borderline"]],
    ["recapture 0.21 is borderline", { recapture: 0.21 }, "needs_review", ["recapture_borderline"]],
    ["recapture 0.20 passes", { recapture: 0.2 }, "pass", []],
    // duplicate: reject > 0.90, review (0.80, 0.90]
    [
      "duplicate 0.95 rejects (never just review)",
      { duplicate: 0.95 },
      "reject",
      ["duplicate_high"],
    ],
    ["duplicate 0.91 rejects", { duplicate: 0.91 }, "reject", ["duplicate_high"]],
    ["duplicate 0.90 is borderline", { duplicate: 0.9 }, "needs_review", ["duplicate_borderline"]],
    ["duplicate 0.81 is borderline", { duplicate: 0.81 }, "needs_review", ["duplicate_borderline"]],
    ["duplicate 0.80 passes", { duplicate: 0.8 }, "pass", []],
    // growth (ALIVE): reject < 0.50, review [0.50, 0.60)
    ["growth 0.49 rejects", { growthConsistency: 0.49 }, "reject", ["growth_low"]],
    [
      "growth 0.50 is borderline",
      { growthConsistency: 0.5 },
      "needs_review",
      ["growth_borderline"],
    ],
    [
      "growth 0.59 is borderline",
      { growthConsistency: 0.59 },
      "needs_review",
      ["growth_borderline"],
    ],
    ["growth 0.60 passes", { growthConsistency: 0.6 }, "pass", []],
    [
      "growth missing on ALIVE needs review",
      { growthConsistency: null },
      "needs_review",
      ["growth_missing"],
    ],
  ];

  it.each(cases)("%s", (_name, overrides, decision, reasons) => {
    const result = applyPolicy(scores(overrides), alive);
    expect(result.decision).toBe(decision);
    expect(result.reasons).toEqual(reasons);
  });

  it("lets any reject win over reviews and reports every finding", () => {
    const result = applyPolicy(scores({ liveness: 0.75, recapture: 0.5, duplicate: 0.85 }), alive);
    expect(result.decision).toBe("reject");
    expect(result.reasons).toEqual([
      "recapture_high",
      "liveness_borderline",
      "duplicate_borderline",
    ]);
  });

  it("ignores advisory speciesMatch and ndvi", () => {
    const result = applyPolicy(
      scores({
        speciesMatch: 0,
        ndvi: { value: -1, source: "sentinel2-sample", date: "2026-10-01" },
      }),
      alive,
    );
    expect(result.decision).toBe("pass");
    expect(applyPolicy(scores({ speciesMatch: null, ndvi: null }), alive).decision).toBe("pass");
  });
});

describe("applyPolicy per kind", () => {
  it.each(["PLANTED", "DEAD", "REPLANTED"] as const)(
    "does not apply the growth rule to %s",
    (kind) => {
      const context = { kind, challengeIssued: false };
      expect(applyPolicy(scores({ growthConsistency: null }), context).decision).toBe("pass");
      expect(applyPolicy(scores({ growthConsistency: 0.1 }), context).decision).toBe("pass");
    },
  );
});

describe("applyPolicy challenges", () => {
  const challenged = { kind: "ALIVE" as EvidenceKind, challengeIssued: true };

  it.each([
    [0.79, "reject", ["challenge_low"]],
    [0.8, "needs_review", ["challenge_borderline"]],
    [0.89, "needs_review", ["challenge_borderline"]],
    [0.9, "pass", []],
  ] as const)("challengeVisible %s gives %s", (value, decision, reasons) => {
    const result = applyPolicy(scores({ challengeVisible: value }), challenged);
    expect(result.decision).toBe(decision);
    expect(result.reasons).toEqual(reasons);
  });

  it("rejects when a challenge was issued but not scored", () => {
    expect(applyPolicy(scores({ challengeVisible: null }), challenged)).toMatchObject({
      decision: "reject",
      reasons: ["challenge_not_scored"],
    });
  });

  it("ignores challengeVisible when no challenge was issued", () => {
    expect(applyPolicy(scores({ challengeVisible: 0 }), alive).decision).toBe("pass");
  });
});

describe("applyPolicy score", () => {
  // Interface example: liveness 0.94, recapture 0.03, treePresence 0.97, growthConsistency 0.88.
  const example = scores({
    liveness: 0.94,
    recapture: 0.03,
    treePresence: 0.97,
    growthConsistency: 0.88,
  });

  it("weights liveness 30%, presence 30%, 1 - recapture 20%, growth 20%", () => {
    // 0.3*0.94 + 0.3*0.97 + 0.2*0.97 + 0.2*0.88 = 0.943
    expect(applyPolicy(example, alive).score).toBe(9430);
  });

  it("uses tree presence in place of growth when growth does not apply", () => {
    // 0.3*0.94 + 0.3*0.97 + 0.2*0.97 + 0.2*0.97 = 0.961
    expect(
      applyPolicy(
        { ...example, growthConsistency: null },
        { kind: "PLANTED", challengeIssued: false },
      ).score,
    ).toBe(9610);
    expect(applyPolicy(example, { kind: "DEAD", challengeIssued: false }).score).toBe(9610);
  });

  it("uses tree presence when growth is missing on ALIVE", () => {
    expect(applyPolicy({ ...example, growthConsistency: null }, alive).score).toBe(9610);
  });

  it("spans the full 0 to 10000 range", () => {
    const perfect = scores({ liveness: 1, recapture: 0, treePresence: 1, growthConsistency: 1 });
    const worst = scores({ liveness: 0, recapture: 1, treePresence: 0, growthConsistency: 0 });
    expect(applyPolicy(perfect, alive).score).toBe(10_000);
    expect(applyPolicy(worst, alive).score).toBe(0);
  });

  it("always returns an integer score", () => {
    const odd = scores({
      liveness: 0.8123,
      recapture: 0.1777,
      treePresence: 0.9001,
      growthConsistency: 0.6543,
    });
    expect(Number.isInteger(applyPolicy(odd, alive).score)).toBe(true);
  });
});
