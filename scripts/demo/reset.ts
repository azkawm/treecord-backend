// Clears the demo rows from Supabase: the campaigns the seed created (marked is_demo) with their trees,
// evidence, carbon mirror and audits, the demo profiles, and their stored videos and keyframes. The chain is
// not touched, and the indexer does not bring the rows back because its cursor is already past them.
// The demo wallets (and the generated phrase) are kept, so the next seed reuses their test ETH and USDC.
//
//   pnpm demo:reset
import { createClient } from "@supabase/supabase-js";
import { walletUserId, type Database } from "@treecord/shared";
import { demoEnv } from "./lib/env.js";
import { fail, info, ok, setLogChain, step, warn } from "./lib/log.js";
import { loadState, saveState } from "./lib/state.js";
import { DEMO_USERS, demoUsers, resolveMnemonic } from "./lib/users.js";

const EVIDENCE_BUCKET = "evidence";
const KEYFRAMES_BUCKET = "keyframes";

interface ResetResult {
  campaigns: number;
  profiles: number;
  keptProfiles: string[];
  submissions: number;
  evidencePaths: string[];
  keyframePaths: string[];
}

async function main() {
  const env = demoEnv();
  setLogChain(env.CHAIN_ID);
  const state = loadState(env.CHAIN_ID);
  const users = demoUsers(resolveMnemonic(state));
  const db = createClient<Database>(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  step(`Reset demo data in ${env.SUPABASE_URL} (chain ${env.CHAIN_ID} is not touched)`);
  const profiles = await db
    .from("profiles")
    .select("id, display_name")
    .in(
      "privy_user_id",
      DEMO_USERS.map((spec) => walletUserId(users[spec.key].address)),
    );
  if (profiles.error) throw new Error(profiles.error.message);
  info(`${state.campaigns.length} demo campaigns, ${profiles.data.length} demo profiles`);

  const { data, error } = await db.rpc("reset_demo_data", {
    p_campaigns: state.campaigns,
    p_profile_ids: profiles.data.map((p) => p.id),
  });
  if (error) throw new Error(error.message);
  const result = data as unknown as ResetResult;

  for (const [bucket, paths] of [
    [EVIDENCE_BUCKET, result.evidencePaths],
    [KEYFRAMES_BUCKET, result.keyframePaths],
  ] as const) {
    for (let i = 0; i < paths.length; i += 100) {
      const removed = await db.storage.from(bucket).remove(paths.slice(i, i + 100));
      if (removed.error) warn(`Could not remove files from ${bucket}: ${removed.error.message}`);
    }
  }

  ok(
    `Removed ${result.campaigns} campaigns, ${result.submissions} submissions with ${result.evidencePaths.length} videos and ${result.keyframePaths.length} keyframes, ${result.profiles} profiles`,
  );
  if (result.keptProfiles.length > 0) {
    warn(`Kept ${result.keptProfiles.length} profiles that non-demo rows still reference`);
  }

  state.campaign = undefined;
  state.campaigns = [];
  state.trees = [];
  state.done = [];
  saveState(state);
  ok("State file cleared. Wallets and device keys are kept. Run pnpm demo:seed to start again.");
}

main().catch(fail);
