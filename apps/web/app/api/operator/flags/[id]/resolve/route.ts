import { flagResolveRequestSchema } from "@treecord/shared";
import { keccak256, stringToBytes } from "viem";
import { requireRole } from "@/lib/server/auth";
import { conflict, json, notFound, route } from "@/lib/server/errors";
import { parseUuid, readJson } from "@/lib/server/http";
import { enqueueRelayerJob, jobView } from "@/lib/server/jobs";
import { getSupabase, unwrap, unwrapMaybe } from "@/lib/server/supabase";

/**
 * POST /api/operator/flags/:id/resolve: an operator upholds (tree removed) or dismisses (clock resumes,
 * paused time added) an open flag with a note. The note is stored and its keccak256 goes on-chain through
 * a `resolve_flag` job. The flag's status changes when the indexer sees FlagResolved.
 * One resolution per flag: repeating the same decision returns the same job, a different one is a 409.
 */
export const POST = route(async (request, { params }: { params: Promise<{ id: string }> }) => {
  const auth = await requireRole(request, "operator");
  const id = parseUuid((await params).id);
  const { uphold, note } = await readJson(request, flagResolveRequestSchema);
  const db = getSupabase();

  const flag = unwrapMaybe(
    await db.from("flags").select("*").eq("id", id).maybeSingle(),
    "load flag",
  );
  if (!flag) throw notFound("Flag");

  const key = `resolve_flag:${flag.id}`;
  const previous = unwrapMaybe(
    await db.from("relayer_jobs").select("*").eq("idempotency_key", key).maybeSingle(),
    "load resolution job",
  );
  if (previous && previous.status !== "failed") {
    if ((previous.payload as { uphold?: boolean }).uphold !== uphold) {
      throw conflict(
        "flag_resolution_pending",
        "This flag already has a different resolution queued",
      );
    }
    return json({
      flag: { id: flag.id, status: flag.status },
      job: jobView(previous, true),
      idempotent: true,
    });
  }

  if (flag.status !== "open") {
    throw conflict(
      "flag_not_open",
      flag.status === "pending"
        ? "The flag is not on-chain yet. The contributor must call TreeRegistry.flag first"
        : `The flag is already ${flag.status}`,
      { status: flag.status },
    );
  }

  const noteHash = keccak256(stringToBytes(note));
  unwrap(
    await db
      .from("flags")
      .update({
        resolution_note: note,
        note_hash: noteHash,
        resolved_by_profile_id: auth.profile.id,
      })
      .eq("id", flag.id)
      .select("id")
      .single(),
    "store resolution note",
  );
  const payload = { treeId: String(flag.tree_id), uphold, noteHash };
  if (previous) {
    // The earlier attempt failed for good: queue the same job row again with the new decision.
    const job = unwrap(
      await db
        .from("relayer_jobs")
        .update({
          payload,
          status: "pending",
          attempts: 0,
          last_error: null,
          tx_hash: null,
          next_attempt_at: new Date().toISOString(),
          locked_at: null,
          locked_by: null,
        })
        .eq("id", previous.id)
        .select("*")
        .single(),
      "requeue resolution job",
    );
    return json(
      { flag: { id: flag.id, status: flag.status }, job: jobView(job, true), idempotent: false },
      { status: 202 },
    );
  }

  const { job, created } = await enqueueRelayerJob("resolve_flag", payload, {
    idempotencyKey: key,
    profileId: auth.profile.id,
  });
  return json(
    { flag: { id: flag.id, status: flag.status }, job: jobView(job, true), idempotent: !created },
    { status: created ? 202 : 200 },
  );
});
