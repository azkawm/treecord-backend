// Pre-certification carbon estimate and milestone amounts. Pure integer math, no floats.
import { BPS, CARBON_UNITS_PER_TONNE, MILESTONE_COUNT, MILESTONE_SHARES_BPS } from "./constants.js";

export const ESTIMATE_MODEL = "linear-maturity-v1";

export interface EstimateInput {
  /** Species figure for one mature tree, kg CO2 per year, as stored (numeric(10,2)), for example "30.00". */
  kgCo2PerYearMature: string;
  yearsToMaturity: number;
  treeCount: number;
  /** Commitment length in months. One campaign time unit stands for one month (30 days in production). */
  commitmentMonths: number;
}

export interface CarbonEstimate {
  /** Carbon units (1 unit = 1 kg CO2e, 1000 = 1 tCO2e), rounded down. */
  units: bigint;
  method: {
    model: typeof ESTIMATE_MODEL;
    label: "pre-certification";
    formula: string;
    kgCo2PerYearMature: string;
    yearsToMaturity: number;
    treeCount: number;
    commitmentMonths: number;
    /** Average share of the mature rate over the commitment period, in basis points. */
    averageMaturityBps: number;
    /** Estimated kg CO2 per tree over the commitment period, 2 decimals, rounded down. */
    kgPerTree: string;
  };
}

/** "30.00" or "30.5" or "30" to hundredths: 3000n, 3050n, 3000n. */
function toCenti(value: string): bigint {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!match) throw new Error(`invalid kg figure ${value}`);
  return BigInt(match[1] ?? "0") * 100n + BigInt((match[2] ?? "").padEnd(2, "0"));
}

/**
 * Estimated sequestration over the commitment period: each tree grows linearly to the species' mature rate
 * over `yearsToMaturity`, using its age at the middle of each month.
 *
 *   month m (1..M) adds  kgMature / 12 × min(1, (m − ½) / (12 × yearsToMaturity))
 *   total = treeCount × Σ over m
 *
 * Computed in hundredths of a kg with integers: Σ min(24Y, 2m − 1) / (12 × 24Y) is the sum of monthly factors.
 */
export function estimateCarbon(input: EstimateInput): CarbonEstimate {
  const { yearsToMaturity: years, treeCount, commitmentMonths: months } = input;
  if (!Number.isInteger(years) || years <= 0) throw new Error("yearsToMaturity must be positive");
  if (!Number.isInteger(treeCount) || treeCount < 0) throw new Error("treeCount must be >= 0");
  if (!Number.isInteger(months) || months < 0) throw new Error("commitmentMonths must be >= 0");

  const kgCenti = toCenti(input.kgCo2PerYearMature);
  const full = BigInt(24 * years);
  let factorSum = 0n; // Σ min(24Y, 2m − 1)
  for (let m = 1; m <= months; m++) {
    const halfMonths = BigInt(2 * m - 1);
    factorSum += halfMonths < full ? halfMonths : full;
  }
  const denominator = 12n * full; // per-month factor denominator
  const centiPerTree = (kgCenti * factorSum) / denominator;
  const units = (BigInt(treeCount) * kgCenti * factorSum) / (100n * denominator);
  const averageMaturityBps =
    months === 0 ? 0 : Number((factorSum * BigInt(BPS)) / (BigInt(months) * full));

  return {
    units,
    method: {
      model: ESTIMATE_MODEL,
      label: "pre-certification",
      formula:
        "treeCount × Σ(month m = 1..M) kgCo2PerYearMature / 12 × min(1, (m − 0.5) / (12 × yearsToMaturity))",
      kgCo2PerYearMature: input.kgCo2PerYearMature,
      yearsToMaturity: years,
      treeCount,
      commitmentMonths: months,
      averageMaturityBps,
      kgPerTree: `${centiPerTree / 100n}.${(centiPerTree % 100n).toString().padStart(2, "0")}`,
    },
  };
}

/** Whole tonnes with up to 3 decimals ("12.5") to carbon units (12500n). */
export function tonnesToUnits(tonnes: string): bigint {
  const match = /^(\d+)(?:\.(\d{1,3}))?$/.exec(tonnes);
  if (!match) throw new Error(`invalid tonnes ${tonnes}`);
  return (
    BigInt(match[1] ?? "0") * BigInt(CARBON_UNITS_PER_TONNE) +
    BigInt((match[2] ?? "").padEnd(3, "0"))
  );
}

/** Carbon units to a tonnes string with 3 decimals: 12345n to "12.345". */
export function unitsToTonnes(units: bigint): string {
  const perTonne = BigInt(CARBON_UNITS_PER_TONNE);
  return `${units / perTonne}.${(units % perTonne).toString().padStart(3, "0")}`;
}

/**
 * USDC paid for milestone `m`, exactly as Campaign._milestoneAmount: milestones 0 to 4 pay
 * perTreeIncentive × share / BPS, milestone 5 pays the remainder so the six add up to perTreeIncentive.
 */
export function milestoneAmount(perTreeIncentive: bigint, milestone: number): bigint {
  if (!Number.isInteger(milestone) || milestone < 0 || milestone >= MILESTONE_COUNT) {
    throw new Error(`invalid milestone ${milestone}`);
  }
  const share = (m: number) =>
    (perTreeIncentive * BigInt(MILESTONE_SHARES_BPS[m] ?? 0)) / BigInt(BPS);
  if (milestone < MILESTONE_COUNT - 1) return share(milestone);
  let earlier = 0n;
  for (let m = 0; m < MILESTONE_COUNT - 1; m++) earlier += share(m);
  return perTreeIncentive - earlier;
}
