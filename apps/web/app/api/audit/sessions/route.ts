import { randomUUID } from "node:crypto";
import { auditSeed, auditSessionCreateRequestSchema, sampleTreeIds } from "@treecord/shared";
import { requireRole } from "@/lib/server/auth";
import { sessionView } from "@/lib/server/audit";
import { loadCampaign } from "@/lib/server/campaigns";
import { getLatestBlock } from "@/lib/server/chain";
import { conflict, json, route } from "@/lib/server/errors";
import { readJson } from "@/lib/server/http";
import { getSupabase, unwrap } from "@/lib/server/supabase";

/**
 * POST /api/audit/sessions: an auditor opens a session for a campaign. The sample is drawn from the
 * campaign's trees (removed trees excluded) with seed = keccak256(sessionId ‖ latest block hash), so neither
 * the auditor nor the platform can pick it, and anyone can recompute it from GET .../reproduce.
 */
export const POST = route(async (request) => {
  const auth = await requireRole(request, "auditor");
  const { campaign: address, sampleSize } = await readJson(
    request,
    auditSessionCreateRequestSchema,
  );
  await loadCampaign(address);
  const db = getSupabase();

  const trees = unwrap(
    await db
      .from("trees")
      .select("tree_id")
      .eq("campaign_address", address)
      .neq("status", "removed")
      .order("tree_id"),
    "load campaign trees",
  );
  if (trees.length === 0) throw conflict("no_trees", "This campaign has no trees to audit yet");
  const population = trees.map((t) => BigInt(t.tree_id));

  const id = randomUUID();
  const block = await getLatestBlock();
  const seed = auditSeed(id, block.hash);
  const sample = sampleTreeIds(population, seed, sampleSize);

  const session = unwrap(
    await db
      .from("audit_sessions")
      .insert({
        id,
        auditor_profile_id: auth.profile.id,
        campaign_address: address,
        seed,
        seed_block_number: Number(block.number),
        seed_block_hash: block.hash,
        sample_size: sample.length,
        population_tree_ids: population.map(Number),
      })
      .select("*")
      .single(),
    "create audit session",
  );
  unwrap(
    await db
      .from("audit_samples")
      .insert(
        sample.map((treeId, position) => ({ session_id: id, tree_id: Number(treeId), position })),
      )
      .select("tree_id"),
    "store audit sample",
  );
  return json({ session: await sessionView(session) }, { status: 201 });
});
