import {
  campaignAbi,
  campaignFactoryAbi,
  carbonLedgerAbi,
  DEFAULT_SPLIT,
  geohashToBytes8,
  treecordRolesAbi,
  treeRegistryAbi,
  verificationGatewayAbi,
} from "@treecord/shared";
import {
  encodeAbiParameters,
  encodeEventTopics,
  stringToHex,
  type Abi,
  type AbiEvent,
  type Address,
  type Hex,
} from "viem";
import { describe, expect, it } from "vitest";
import { metadataIdFromUri, speciesCodeFromBytes32, treeStateAfterDismissal } from "./apply.js";
import { decodeLog, decodeLogs, type RawLog, type WatchedAddresses } from "./decode.js";

const watched: WatchedAddresses = {
  factory: "0xdc64a140aa3e981100a9beca4e685f962f0cf6c9",
  treeRegistry: "0x9fe46736679d2d9a65f0992f2272de9f3c7fa6e0",
  gateway: "0x5fc8d32690cc91d4c39d9d3abcbd16989f875707",
  carbonLedger: "0x0165878a594ca255338adfa4d48449f69242eb8f",
  campaigns: new Set(["0x856e4424f806d16e8cbc702b3c0f2ede5468eae5"]),
};
const CAMPAIGN = "0x856e4424f806d16e8cbc702b3c0f2ede5468eae5" as Address;
const PLANTER = "0x90f79bf6eb2c4f870365e785982e1f101e93b906" as Address;
const HASH = `0x${"ab".repeat(32)}` as Hex;
const TX = `0x${"CD".repeat(32)}` as Hex;

/** Encodes an event the way a contract would emit it. */
function logOf(
  abi: Abi,
  eventName: string,
  args: Record<string, unknown>,
  address: Address,
  blockNumber = 10n,
  logIndex = 0,
): RawLog {
  const event = abi.find(
    (item): item is AbiEvent => item.type === "event" && item.name === eventName,
  );
  if (!event) throw new Error(`no event ${eventName}`);
  const indexedArgs = Object.fromEntries(
    event.inputs.filter((i) => i.indexed).map((i) => [i.name, args[i.name ?? ""]]),
  );
  const topics = encodeEventTopics({ abi: [event], eventName, args: indexedArgs } as never) as [
    Hex,
    ...Hex[],
  ];
  const plain = event.inputs.filter((i) => !i.indexed);
  const data = encodeAbiParameters(
    plain,
    plain.map((i) => args[i.name ?? ""]),
  );
  return { address, blockNumber, logIndex, transactionHash: TX, data, topics };
}

describe("decodeLog", () => {
  it("decodes CampaignCreated with its config struct", () => {
    const config = {
      creator: PLANTER,
      metadataURI:
        "http://localhost:3000/api/campaigns/metadata/5b0f8e1c-6a43-4a8e-9d3b-0f3f3f6f9e21",
      speciesCode: stringToHex("SWIETENIA_MACROPHYLLA", { size: 32 }),
      regionGeohash: geohashToBytes8("qqguwvt"),
      regionRadiusM: 5000,
      treeTarget: 10,
      anchorBps: 2000,
      perPlanterCap: 3,
      fundingTarget: 20_000_000n,
      fundingDeadline: 1_800_000_000n,
      claimDeadline: 1_800_003_600n,
      commitmentUnits: 36,
      timeUnit: 180n,
      split: DEFAULT_SPLIT,
    };
    const log = logOf(
      campaignFactoryAbi,
      "CampaignCreated",
      { campaign: CAMPAIGN, creator: PLANTER, config },
      "0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9",
    );
    const ev = decodeLog(log, watched);
    expect(ev?.source).toBe("factory");
    if (ev?.source !== "factory" || ev.event.eventName !== "CampaignCreated")
      throw new Error("wrong event");
    expect(ev.event.args.campaign.toLowerCase()).toBe(CAMPAIGN);
    expect(ev.event.args.config.fundingTarget).toBe(20_000_000n);
    expect(ev.event.args.config.split.incentivesBps).toBe(DEFAULT_SPLIT.incentivesBps);
    expect(speciesCodeFromBytes32(ev.event.args.config.speciesCode)).toBe("SWIETENIA_MACROPHYLLA");
    expect(metadataIdFromUri(ev.event.args.config.metadataURI)).toBe(
      "5b0f8e1c-6a43-4a8e-9d3b-0f3f3f6f9e21",
    );
    // Addresses and hashes are normalized to lowercase.
    expect(ev.meta.address).toBe(watched.factory);
    expect(ev.meta.txHash).toBe(TX.toLowerCase());
  });

  it("decodes campaign, registry, gateway and ledger events by emitting address", () => {
    const contributed = decodeLog(
      logOf(
        campaignAbi,
        "Contributed",
        { contributor: PLANTER, amount: 5n, totalRaised: 12n },
        CAMPAIGN,
      ),
      watched,
    );
    expect(contributed).toMatchObject({
      source: "campaign",
      event: { eventName: "Contributed", args: { amount: 5n, totalRaised: 12n } },
    });

    const planted = decodeLog(
      logOf(
        treeRegistryAbi,
        "TreePlanted",
        {
          treeId: 7n,
          campaign: CAMPAIGN,
          slotId: 3n,
          planter: PLANTER,
          geohash: geohashToBytes8("qqguwvt"),
          evidenceHash: HASH,
          plantedAt: 1_800_000_000n,
        },
        watched.treeRegistry,
      ),
      watched,
    );
    expect(planted).toMatchObject({
      source: "treeRegistry",
      event: { eventName: "TreePlanted", args: { treeId: 7n, slotId: 3n, evidenceHash: HASH } },
    });

    const accepted = decodeLog(
      logOf(
        verificationGatewayAbi,
        "AttestationAccepted",
        { nonce: 2n ** 255n + 1n, kind: 1, treeId: 7n, evidenceHash: HASH, score: 9000 },
        watched.gateway,
      ),
      watched,
    );
    expect(accepted).toMatchObject({
      source: "gateway",
      event: { eventName: "AttestationAccepted", args: { nonce: 2n ** 255n + 1n, score: 9000 } },
    });

    const retired = decodeLog(
      logOf(
        carbonLedgerAbi,
        "Retired",
        {
          retirementId: 1n,
          batchId: 2n,
          holder: PLANTER,
          amount: 1500n,
          beneficiary: "PT Hijau",
          purpose: "2026 scope 3",
        },
        watched.carbonLedger,
      ),
      watched,
    );
    expect(retired).toMatchObject({
      source: "carbonLedger",
      event: { eventName: "Retired", args: { amount: 1500n, beneficiary: "PT Hijau" } },
    });
  });

  it("ignores logs from unknown addresses and events the mirror does not use", () => {
    const stranger = logOf(
      campaignAbi,
      "Contributed",
      { contributor: PLANTER, amount: 1n, totalRaised: 1n },
      "0x000000000000000000000000000000000000dead",
    );
    expect(decodeLog(stranger, watched)).toBeNull();

    // A TreecordRoles event emitted by the registry address is not in the registry ABI.
    const foreign = logOf(
      treecordRolesAbi,
      "TreasuryUpdated",
      { previousTreasury: PLANTER, newTreasury: PLANTER },
      watched.treeRegistry,
    );
    expect(decodeLog(foreign, watched)).toBeNull();
    expect(decodeLog({ ...foreign, topics: [] }, watched)).toBeNull();
  });

  it("returns events in chain order", () => {
    const at = (block: bigint, index: number, milestone: number) =>
      logOf(
        campaignAbi,
        "MilestonePaid",
        { treeId: 1n, milestone, planter: PLANTER, amount: 1n },
        CAMPAIGN,
        block,
        index,
      );
    const events = decodeLogs([at(12n, 0, 3), at(11n, 4, 2), at(11n, 1, 1)], watched);
    expect(
      events.map((e) => (e.event.eventName === "MilestonePaid" ? e.event.args.milestone : -1)),
    ).toEqual([1, 2, 3]);
  });
});

describe("mirror helpers", () => {
  it("reads the metadata id only from a trailing UUID", () => {
    expect(metadataIdFromUri("treecord://demo/mahogany-jakarta")).toBeNull();
    expect(
      metadataIdFromUri(
        "https://treecord.app/api/campaigns/metadata/5B0F8E1C-6A43-4A8E-9D3B-0F3F3F6F9E21/",
      ),
    ).toBe("5b0f8e1c-6a43-4a8e-9d3b-0f3f3f6f9e21");
  });

  it("rebuilds tree state after a dismissed flag like TreeRegistry.resolveFlag", () => {
    const ev = (block: number, kind: string, data: Record<string, string | boolean>) => ({
      kind,
      data,
      block_number: block,
      log_index: 0,
    });
    // Alive tree, flagged, dismissed after 100 s.
    const alive = [
      ev(1, "planted", {}),
      ev(2, "flagged", { previousStatus: "alive" }),
      ev(3, "flag_resolved", { upheld: false, pausedSeconds: "100" }),
    ];
    expect(treeStateAfterDismissal(alive, { blockNumber: 3n, logIndex: 0 })).toEqual({
      status: "alive",
      pausedSeconds: 100,
      replantDeadlineSec: null,
    });

    // Dead tree flagged twice: both pauses add up, and only those after death move the deadline.
    const dead = [
      ev(1, "planted", {}),
      ev(2, "flagged", { previousStatus: "alive" }),
      ev(3, "flag_resolved", { upheld: false, pausedSeconds: "40" }),
      ev(4, "died", { replantDeadline: "5000" }),
      ev(5, "flagged", { previousStatus: "dead" }),
      ev(6, "flag_resolved", { upheld: false, pausedSeconds: "60" }),
      ev(7, "replanted", {}),
    ];
    expect(treeStateAfterDismissal(dead, { blockNumber: 6n, logIndex: 0 })).toEqual({
      status: "dead",
      pausedSeconds: 100,
      replantDeadlineSec: 5060,
    });
  });
});
