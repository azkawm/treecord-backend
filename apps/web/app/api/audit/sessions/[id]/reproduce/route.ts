import { AUDIT_SAMPLE_ALGORITHM, auditSeed, sampleTreeIds } from "@treecord/shared";
import { loadSamples } from "@/lib/server/audit";
import { json, notFound, route } from "@/lib/server/errors";
import { parseUuid } from "@/lib/server/http";
import { getSupabase, unwrapMaybe } from "@/lib/server/supabase";

/**
 * GET /api/audit/sessions/:id/reproduce: public. Everything needed to recompute the sample independently:
 * the session id, the block number and hash, the frozen tree population and the algorithm. The server also
 * recomputes it and says whether it matches the stored sample. The block hash can be checked against any
 * Base Sepolia node, and the population against the TreePlanted events up to that block.
 */
export const GET = route(async (_request, { params }: { params: Promise<{ id: string }> }) => {
  const id = parseUuid((await params).id);
  const session = unwrapMaybe(
    await getSupabase()
      .from("audit_sessions")
      .select(
        "id, campaign_address, seed, seed_block_number, seed_block_hash, sample_size, population_tree_ids, status, report_hash",
      )
      .eq("id", id)
      .maybeSingle(),
    "load audit session",
  );
  if (!session) throw notFound("Audit session");

  const stored = (await loadSamples(id)).map((s) => String(s.tree_id));
  const seed = auditSeed(session.id, session.seed_block_hash as `0x${string}`);
  const recomputed = sampleTreeIds(
    session.population_tree_ids.map(BigInt),
    seed,
    session.sample_size,
  ).map(String);

  return json({
    sessionId: session.id,
    campaign: session.campaign_address,
    blockNumber: String(session.seed_block_number),
    blockHash: session.seed_block_hash,
    seed: session.seed,
    algorithm: AUDIT_SAMPLE_ALGORITHM,
    population: session.population_tree_ids.map(String),
    sampleSize: session.sample_size,
    sample: stored,
    check: {
      seedMatches: seed === session.seed,
      recomputedSample: recomputed,
      sampleMatches:
        recomputed.length === stored.length && recomputed.every((t, i) => t === stored[i]),
    },
    status: session.status,
    reportHash: session.report_hash,
  });
});
