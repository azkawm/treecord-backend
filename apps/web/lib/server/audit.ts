import "server-only";
import { randomInt } from "node:crypto";
import type { Tables } from "@treecord/shared";
import type { AuthContext } from "./auth";
import { conflict, notFound } from "./errors";
import { getSupabase, unwrap, unwrapMaybe } from "./supabase";

export type AuditSession = Tables<"audit_sessions">;
export type AuditSample = Tables<"audit_samples">;

const CODE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

/** A random 4-character challenge code (A to Z, 0 to 9) from a cryptographic source. */
export function challengeCode(): string {
  return Array.from({ length: 4 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join("");
}

/** The caller's own session. Another auditor's session is a 404, so session ids do not leak. */
export async function loadOwnSession(auth: AuthContext, id: string): Promise<AuditSession> {
  const session = unwrapMaybe(
    await getSupabase().from("audit_sessions").select("*").eq("id", id).maybeSingle(),
    "load audit session",
  );
  if (!session || session.auditor_profile_id !== auth.profile.id) throw notFound("Audit session");
  return session;
}

export function requireOpen(session: AuditSession): void {
  if (session.status !== "open") throw conflict("session_closed", "This audit session is closed");
}

/** The sample row for a tree, or 404 when the tree is not in this session's sample. */
export async function loadSample(sessionId: string, treeId: number): Promise<AuditSample> {
  const sample = unwrapMaybe(
    await getSupabase()
      .from("audit_samples")
      .select("*")
      .eq("session_id", sessionId)
      .eq("tree_id", treeId)
      .maybeSingle(),
    "load audit sample",
  );
  if (!sample) throw notFound("Tree in this audit sample");
  return sample;
}

export async function loadSamples(sessionId: string): Promise<AuditSample[]> {
  return unwrap(
    await getSupabase()
      .from("audit_samples")
      .select("*")
      .eq("session_id", sessionId)
      .order("position"),
    "load audit samples",
  );
}

export function sampleView(sample: AuditSample) {
  return {
    position: sample.position,
    treeId: sample.tree_id,
    finding: sample.finding,
    notes: sample.notes,
    recordedAt: sample.recorded_at,
  };
}

/** Session with its sample, tree status, and the challenges issued in it. */
export async function sessionView(session: AuditSession) {
  const db = getSupabase();
  const samples = await loadSamples(session.id);
  const treeIds = samples.map((s) => s.tree_id);
  const [trees, challenges] = await Promise.all([
    treeIds.length === 0
      ? Promise.resolve([])
      : db
          .from("trees")
          .select("tree_id, status, geohash, check_in_count")
          .in("tree_id", treeIds)
          .then((r) => unwrap(r, "load sampled trees")),
    db
      .from("challenges")
      .select("id, tree_id, code, expires_at, fulfilled_submission_id, created_at")
      .eq("audit_session_id", session.id)
      .order("created_at")
      .then((r) => unwrap(r, "load session challenges")),
  ]);
  const treeById = new Map(trees.map((t) => [t.tree_id, t]));
  return {
    id: session.id,
    campaign: session.campaign_address,
    status: session.status,
    seed: {
      seed: session.seed,
      blockNumber: session.seed_block_number,
      blockHash: session.seed_block_hash,
    },
    populationSize: session.population_tree_ids.length,
    sampleSize: session.sample_size,
    samples: samples.map((s) => {
      const tree = treeById.get(s.tree_id);
      return {
        ...sampleView(s),
        tree: tree
          ? { status: tree.status, geohash: tree.geohash, checkInCount: tree.check_in_count }
          : null,
      };
    }),
    challenges: challenges.map(challengeView),
    reportHash: session.report_hash,
    report: session.report,
    createdAt: session.created_at,
    closedAt: session.closed_at,
  };
}

export function challengeView(c: {
  id: string;
  tree_id: number;
  code: string;
  expires_at: string;
  fulfilled_submission_id: string | null;
  created_at: string;
}) {
  return {
    id: c.id,
    treeId: c.tree_id,
    code: c.code,
    issuedAt: c.created_at,
    expiresAt: c.expires_at,
    fulfilledSubmissionId: c.fulfilled_submission_id,
  };
}
