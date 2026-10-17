import { describe, expect, it } from "vitest";
import { dueTasks, taskKey, type CampaignFact, type TreeFact } from "./scheduler.js";
import { nextRange } from "./indexer/indexer.js";

const UNIT = 60;
const PLANTED = 1_000_000;
const campaign: CampaignFact = {
  address: "0xc0",
  status: "active",
  timeUnitSeconds: UNIT,
  commitmentUnits: 36,
  claimDeadlineSec: PLANTED - 100,
};
const tree = (overrides: Partial<TreeFact> = {}): TreeFact => ({
  treeId: 1,
  campaign: "0xc0",
  status: "alive",
  plantedAtSec: PLANTED,
  pausedSeconds: 0,
  replantDeadlineSec: null,
  settled: new Set([0]),
  ...overrides,
});
const keys = (tasks: ReturnType<typeof dueTasks>) => tasks.map(taskKey);

describe("dueTasks: forfeits", () => {
  // Milestone 1 opens at 3 units and closes one unit later.
  const closes1 = PLANTED + 4 * UNIT;

  it("forfeits a milestone only after its window closed", () => {
    expect(keys(dueTasks([campaign], [tree()], closes1))).toEqual([]);
    expect(keys(dueTasks([campaign], [tree()], closes1 + 1))).toEqual(["forfeit:1:1"]);
  });

  it("skips settled milestones and shifts windows by paused time", () => {
    expect(keys(dueTasks([campaign], [tree({ settled: new Set([0, 1]) })], closes1 + 1))).toEqual(
      [],
    );
    expect(keys(dueTasks([campaign], [tree({ pausedSeconds: 30 })], closes1 + 1))).toEqual([]);
    expect(keys(dueTasks([campaign], [tree({ pausedSeconds: 30 })], closes1 + 31))).toEqual([
      "forfeit:1:1",
    ]);
  });

  it("forfeits dead trees too, but never flagged, removed or completed ones", () => {
    const late = PLANTED + 13 * UNIT + 1; // milestones 1, 2 and 3 closed
    expect(keys(dueTasks([campaign], [tree({ status: "dead" })], late))).toEqual([
      "forfeit:1:1",
      "forfeit:1:2",
      "forfeit:1:3",
    ]);
    for (const status of ["flagged", "removed", "completed"] as const) {
      expect(
        dueTasks([campaign], [tree({ status })], late).filter((t) => t.kind === "forfeit"),
      ).toEqual([]);
    }
  });
});

describe("dueTasks: expiry and completion", () => {
  it("expires a dead tree strictly after its replant deadline", () => {
    const dead = tree({
      status: "dead",
      replantDeadlineSec: PLANTED + 50,
      settled: new Set([0, 1, 2, 3, 4, 5]),
    });
    expect(keys(dueTasks([campaign], [dead], PLANTED + 50))).toEqual([]);
    expect(keys(dueTasks([campaign], [dead], PLANTED + 51))).toEqual(["expireDead:1"]);
  });

  it("completes an alive tree once all six milestones are settled", () => {
    expect(
      keys(dueTasks([campaign], [tree({ settled: new Set([0, 1, 2, 3, 4]) })], PLANTED)),
    ).toEqual([]);
    expect(
      keys(dueTasks([campaign], [tree({ settled: new Set([0, 1, 2, 3, 4, 5]) })], PLANTED)),
    ).toEqual(["markCompleted:1"]);
  });

  it("completes a campaign when every tree is settled and the commitment period has passed", () => {
    const endsAt = PLANTED + 37 * UNIT;
    const done = [tree({ status: "completed" }), tree({ treeId: 2, status: "removed" })];
    expect(keys(dueTasks([campaign], done, endsAt - 1))).toEqual([]);
    expect(keys(dueTasks([campaign], done, endsAt))).toEqual(["complete:0xc0"]);
    // One unsettled tree blocks it.
    expect(
      keys(
        dueTasks(
          [campaign],
          [...done, tree({ treeId: 3, settled: new Set([0, 1, 2, 3, 4]) })],
          endsAt,
        ),
      ),
    ).not.toContain("complete:0xc0");
    // Without plantings the claim deadline is the start.
    expect(keys(dueTasks([campaign], [], campaign.claimDeadlineSec + 37 * UNIT))).toEqual([
      "complete:0xc0",
    ]);
    expect(keys(dueTasks([{ ...campaign, status: "completed" }], done, endsAt))).toEqual([]);
  });
});

describe("nextRange", () => {
  const base = { startBlock: 100n, confirmations: 2, chunkBlocks: 2000, rescanBlocks: 5 };

  it("starts at the deploy block and waits for confirmations", () => {
    expect(nextRange({ ...base, cursor: null, head: 101n })).toBeNull();
    expect(nextRange({ ...base, cursor: null, head: 150n })).toEqual({
      fromBlock: 100n,
      toBlock: 148n,
    });
  });

  it("re-scans the last blocks and caps one chunk of new blocks", () => {
    expect(nextRange({ ...base, cursor: 148n, head: 160n })).toEqual({
      fromBlock: 144n,
      toBlock: 158n,
    });
    expect(nextRange({ ...base, cursor: 148n, head: 9_000n })).toEqual({
      fromBlock: 144n,
      toBlock: 2148n,
    });
    // Nothing new: the re-scan window alone is scanned again.
    expect(nextRange({ ...base, cursor: 158n, head: 160n })).toEqual({
      fromBlock: 154n,
      toBlock: 158n,
    });
  });
});
