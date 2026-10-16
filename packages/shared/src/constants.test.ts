import { describe, expect, it } from "vitest";
import {
  BPS,
  DEFAULT_SPLIT,
  MILESTONE_COUNT,
  MILESTONE_DUE_UNITS,
  MILESTONE_SHARES_BPS,
  PRODUCTION_TIME_UNIT_SECONDS,
} from "./constants.js";

describe("constants", () => {
  it("default split sums to 10000 bps", () => {
    expect(Object.values(DEFAULT_SPLIT).reduce((a, b) => a + b, 0)).toBe(BPS);
  });

  it("milestone schedule matches TreecordConstants.sol", () => {
    expect(MILESTONE_DUE_UNITS).toEqual([0, 3, 6, 12, 24, 36]);
    expect(MILESTONE_SHARES_BPS).toEqual([1000, 1000, 1000, 1500, 1500, 4000]);
    expect(MILESTONE_DUE_UNITS).toHaveLength(MILESTONE_COUNT);
    expect(MILESTONE_SHARES_BPS.reduce((a, b) => a + b, 0)).toBe(BPS);
  });

  it("production time unit is 30 days", () => {
    expect(PRODUCTION_TIME_UNIT_SECONDS).toBe(2_592_000);
  });
});
