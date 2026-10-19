// What the seed leaves for the lifecycle and reset scripts: generated mnemonic, device keys, the campaign and
// its trees. Kept in scripts/demo/.state/<chainId>.json, which git ignores because it holds test keys.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { EcPublicJwk } from "@treecord/shared";

export type PlanterKey = "planterA" | "planterB" | "planterC";

/** The part each tree plays in the lifecycle. */
export type TreeRole = "steady" | "anchor" | "replanted" | "flagged";

export interface DeviceState {
  /** Private P-256 key as JWK. Test key for the demo device only. */
  privateJwk: Record<string, unknown>;
  publicJwk: EcPublicJwk;
  thumbprint: string;
}

export interface TreeState {
  role: TreeRole;
  planter: PlanterKey;
  slotId: number;
  treeId: number | null;
  location: { lat: number; lon: number };
}

export interface CampaignState {
  address: `0x${string}`;
  metadataId: string;
  regionCenter: { lat: number; lon: number };
  timeUnitSeconds: number;
  createdTx: string;
}

export interface DemoState {
  chainId: number;
  /** Only set when the seed generated the phrase itself. */
  mnemonic?: string;
  devices: Partial<Record<PlanterKey, DeviceState>>;
  campaign?: CampaignState;
  trees: TreeState[];
  /** Every campaign the seed created on this chain, for reset. */
  campaigns: string[];
  /** Lifecycle progress, so a stopped run can continue where it left off. */
  done: string[];
}

const stateDir = fileURLToPath(new URL("../.state/", import.meta.url));
const statePath = (chainId: number) => `${stateDir}${chainId}.json`;

export function loadState(chainId: number): DemoState {
  const path = statePath(chainId);
  if (!existsSync(path)) return { chainId, devices: {}, trees: [], campaigns: [], done: [] };
  const state = JSON.parse(readFileSync(path, "utf8")) as DemoState;
  return { ...state, done: state.done ?? [], campaigns: state.campaigns ?? [] };
}

export function saveState(state: DemoState): void {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(statePath(state.chainId), `${JSON.stringify(state, null, 2)}\n`);
}

export function stateFile(chainId: number): string {
  return statePath(chainId);
}
