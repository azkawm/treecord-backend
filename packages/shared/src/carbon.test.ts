import { describe, expect, it } from "vitest";
import { estimateCarbon, milestoneAmount, tonnesToUnits, unitsToTonnes } from "./carbon.js";

describe("estimateCarbon", () => {
  it("ramps linearly while every month is before maturity", () => {
    // Mahogany: 30 kg/yr mature at 20 years. Over 36 months the mid-month ages sum to 36² = 1296 half-months,
    // so one tree adds 30 × 1296 / (12 × 480) = 6.75 kg.
    const estimate = estimateCarbon({
      kgCo2PerYearMature: "30.00",
      yearsToMaturity: 20,
      treeCount: 10,
      commitmentMonths: 36,
    });
    expect(estimate.method.kgPerTree).toBe("6.75");
    expect(estimate.units).toBe(67n); // 67.5 kg rounded down
    expect(estimate.method.averageMaturityBps).toBe(750); // 1296 / (36 × 480)
    expect(estimate.method.label).toBe("pre-certification");
  });

  it("caps at the mature rate once a tree is mature", () => {
    // Sengon: 40 kg/yr at 1 year. Months 1 to 12 ramp (sum 144 of 24 half-months each), months 13 to 36 are full.
    const estimate = estimateCarbon({
      kgCo2PerYearMature: "40",
      yearsToMaturity: 1,
      treeCount: 1,
      commitmentMonths: 36,
    });
    // (144 + 24 × 24) / (12 × 24) × 40 = 720 / 288 × 40 = 100 kg
    expect(estimate.units).toBe(100n);
    expect(estimate.method.kgPerTree).toBe("100.00");
  });

  it("scales with tree count and handles empty inputs", () => {
    const one = estimateCarbon({
      kgCo2PerYearMature: "25.50",
      yearsToMaturity: 15,
      treeCount: 1,
      commitmentMonths: 120,
    });
    const thousand = estimateCarbon({
      kgCo2PerYearMature: "25.50",
      yearsToMaturity: 15,
      treeCount: 1000,
      commitmentMonths: 120,
    });
    // 120 months, 360 half-month cap: Σ(2m − 1) = 120² = 14400. 25.50 × 14400 / 4320 = 85 kg per tree.
    expect(one.units).toBe(85n);
    expect(thousand.units).toBe(85_000n);
    expect(
      estimateCarbon({
        kgCo2PerYearMature: "30",
        yearsToMaturity: 20,
        treeCount: 0,
        commitmentMonths: 36,
      }).units,
    ).toBe(0n);
    expect(
      estimateCarbon({
        kgCo2PerYearMature: "30",
        yearsToMaturity: 20,
        treeCount: 5,
        commitmentMonths: 0,
      }).units,
    ).toBe(0n);
  });

  it("rejects malformed figures", () => {
    expect(() =>
      estimateCarbon({
        kgCo2PerYearMature: "3e1",
        yearsToMaturity: 20,
        treeCount: 1,
        commitmentMonths: 36,
      }),
    ).toThrow();
    expect(() =>
      estimateCarbon({
        kgCo2PerYearMature: "30",
        yearsToMaturity: 0,
        treeCount: 1,
        commitmentMonths: 36,
      }),
    ).toThrow();
  });
});

describe("tonnes and units", () => {
  it("converts both ways without floats", () => {
    expect(tonnesToUnits("12.5")).toBe(12_500n);
    expect(tonnesToUnits("0.001")).toBe(1n);
    expect(tonnesToUnits("1000000")).toBe(1_000_000_000n);
    expect(unitsToTonnes(12_345n)).toBe("12.345");
    expect(unitsToTonnes(7n)).toBe("0.007");
    expect(() => tonnesToUnits("1.2345")).toThrow();
  });
});

describe("milestoneAmount", () => {
  it("matches Campaign: shares for 0 to 4 and the remainder for 5", () => {
    const perTree = 1_234_567n;
    const amounts = [0, 1, 2, 3, 4, 5].map((m) => milestoneAmount(perTree, m));
    expect(amounts.slice(0, 5)).toEqual([123_456n, 123_456n, 123_456n, 185_185n, 185_185n]);
    expect(amounts.reduce((a, b) => a + b, 0n)).toBe(perTree);
    expect(() => milestoneAmount(perTree, 6)).toThrow();
  });
});
