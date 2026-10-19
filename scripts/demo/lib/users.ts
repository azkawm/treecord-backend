// The seven demo users and their wallets, derived from one mnemonic.
import { english, generateMnemonic, mnemonicToAccount, type HDAccount } from "viem/accounts";
import { demoEnv } from "./env.js";
import type { DemoState, PlanterKey } from "./state.js";

/** anvil's default phrase. Its first 10 accounts are the dev keys in packages/contracts/.env.anvil. */
const ANVIL_MNEMONIC = "test test test test test test test test test test test junk";
/** Demo wallets start after the accounts the deployment uses. */
const FIRST_INDEX = 10;

export type UserKey = "corporate" | "individual" | PlanterKey | "auditor" | "operator";
export type DemoRole = "donor" | "planter" | "auditor" | "operator";

export interface DemoUserSpec {
  key: UserKey;
  role: DemoRole;
  displayName: string;
  description: string;
  buyer?: boolean;
}

// Fictional names. None of them is a real company or verifier.
export const DEMO_USERS: readonly DemoUserSpec[] = [
  {
    key: "corporate",
    role: "donor",
    displayName: "PT Hijau Nusantara (demo)",
    description: "corporate donor, creates and funds the campaign",
  },
  {
    key: "individual",
    role: "donor",
    displayName: "Rina Wijaya (demo)",
    description: "individual donor and credit buyer, flags a tree",
    buyer: true,
  },
  { key: "planterA", role: "planter", displayName: "Budi Santoso (demo)", description: "planter" },
  { key: "planterB", role: "planter", displayName: "Siti Rahayu (demo)", description: "planter" },
  { key: "planterC", role: "planter", displayName: "Agus Pratama (demo)", description: "planter" },
  {
    key: "auditor",
    role: "auditor",
    displayName: "Lestari Verifikasi (demo LVV)",
    description: "auditor",
  },
  {
    key: "operator",
    role: "operator",
    displayName: "Treecord Ops (demo)",
    description: "operator",
  },
];

export interface DemoUser extends DemoUserSpec {
  account: HDAccount;
  address: `0x${string}`;
}

/** The mnemonic to use, generating and storing one in the state when none is configured. */
export function resolveMnemonic(state: DemoState): string {
  const env = demoEnv();
  if (env.DEMO_MNEMONIC) return env.DEMO_MNEMONIC;
  if (env.isAnvil) return ANVIL_MNEMONIC;
  state.mnemonic ??= generateMnemonic(english);
  return state.mnemonic;
}

export function demoUsers(mnemonic: string): Record<UserKey, DemoUser> {
  return Object.fromEntries(
    DEMO_USERS.map((spec, i) => {
      const account = mnemonicToAccount(mnemonic, { addressIndex: FIRST_INDEX + i });
      return [
        spec.key,
        { ...spec, account, address: account.address.toLowerCase() as `0x${string}` },
      ];
    }),
  ) as Record<UserKey, DemoUser>;
}
