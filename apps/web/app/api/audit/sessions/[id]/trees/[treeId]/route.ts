import {
  EVIDENCE_BUCKET,
  SIGNED_READ_URL_SECONDS,
  SUBMISSION_COLUMNS,
  type SubmissionRow,
} from "@treecord/pipeline";
import {
  base64UrlToBytes,
  canonicalize,
  computeEvidenceHash,
  sha256Hex,
  utf8,
  verifyDeviceSignature,
  type EcPublicJwk,
  type EvidencePayload,
} from "@treecord/shared";
import { requireRole } from "@/lib/server/auth";
import { loadOwnSession, loadSample, sampleView } from "@/lib/server/audit";
import { txUrl } from "@/lib/server/chain";
import { json, route } from "@/lib/server/errors";
import { parseUuid } from "@/lib/server/http";
import { check, getSupabase, unwrap } from "@/lib/server/supabase";
import { loadTree, parseTreeId, signedKeyframeUrls, treeLocation } from "@/lib/server/trees";

type Params = { params: Promise<{ id: string; treeId: string }> };

/**
 * GET /api/audit/sessions/:id/trees/:treeId: the full evidence bundle for a sampled tree. Every submission
 * with a 15 minute video URL, the canonical payload and signature, checks the server re-runs now (device
 * signature, canonical form, evidence hash, video hash), the AI response, policy decision, attestation and
 * transaction, plus the tree's payouts. Every call is written to audit_access_log before anything is returned.
 */
export const GET = route(async (request, { params }: Params) => {
  const auth = await requireRole(request, "auditor");
  const { id, treeId: rawTreeId } = await params;
  const session = await loadOwnSession(auth, parseUuid(id));
  const treeId = parseTreeId(rawTreeId);
  const sample = await loadSample(session.id, treeId);
  const db = getSupabase();

  check(
    await db.from("audit_access_log").insert({
      session_id: session.id,
      auditor_profile_id: auth.profile.id,
      resource: `tree:${treeId}`,
    }),
    "write audit access log",
  );

  const tree = await loadTree(treeId);
  const [byTree, planting, payouts, events] = await Promise.all([
    db.from("submissions").select(SUBMISSION_COLUMNS).eq("tree_id", treeId),
    db
      .from("submissions")
      .select(SUBMISSION_COLUMNS)
      .eq("kind", "PLANTED")
      .eq("campaign_address", tree.campaign_address)
      .eq("slot_id", tree.slot_id),
    db
      .from("milestone_payouts")
      .select("milestone, amount::text, planter_address, block_time, tx_hash")
      .eq("tree_id", treeId)
      .order("milestone"),
    db
      .from("tree_events")
      .select("kind, evidence_hash, data, block_number, block_time, tx_hash")
      .eq("tree_id", treeId)
      .order("block_number")
      .order("log_index"),
  ]);
  const submissions = [
    ...(unwrap(planting, "load planting submissions") as unknown as SubmissionRow[]),
    ...(unwrap(byTree, "load tree submissions") as unknown as SubmissionRow[]),
  ].sort((a, b) => a.created_at.localeCompare(b.created_at));

  const deviceIds = [...new Set(submissions.flatMap((s) => (s.device_id ? [s.device_id] : [])))];
  const devices =
    deviceIds.length === 0
      ? []
      : unwrap(
          await db
            .from("devices")
            .select("id, public_key_jwk, thumbprint, revoked_at")
            .in("id", deviceIds),
          "load devices",
        );
  const deviceById = new Map(devices.map((d) => [d.id, d]));
  const keyframes = await signedKeyframeUrls(submissions.flatMap((s) => s.keyframe_paths));

  const bundle = await Promise.all(
    submissions.map(async (s) => {
      const device = s.device_id ? deviceById.get(s.device_id) : undefined;
      return {
        id: s.id,
        kind: s.kind,
        milestone: s.milestone,
        status: s.status,
        receivedAt: s.received_at,
        capturedAt: s.captured_at,
        video: {
          path: s.video_path,
          sha256: s.video_sha256,
          sizeBytes: s.size_bytes,
          durationSec: s.duration_sec,
          url: await signedVideoUrl(s.video_path),
        },
        payload: s.payload,
        canonical: s.canonical,
        signature: s.signature,
        device: device
          ? { id: device.id, thumbprint: device.thumbprint, revokedAt: device.revoked_at }
          : null,
        verification: await reverify(s, device?.public_key_jwk as EcPublicJwk | undefined),
        evidenceHash: s.evidence_hash,
        ai: s.ai_response,
        keyframeUrls: s.keyframe_paths.flatMap((p) => {
          const url = keyframes.get(p);
          return url ? [url] : [];
        }),
        policy: {
          decision: s.policy_decision,
          score: s.policy_score,
          rejectReasons: s.reject_reasons,
        },
        review: s.reviewed_at ? { note: s.review_note, reviewedAt: s.reviewed_at } : null,
        attestation: s.attestation,
        tx: { hash: s.tx_hash, url: txUrl(s.tx_hash) },
      };
    }),
  );

  return json({
    sessionId: session.id,
    sample: sampleView(sample),
    tree: {
      treeId: tree.tree_id,
      campaign: tree.campaign_address,
      slotId: tree.slot_id,
      planter: tree.planter_address,
      status: tree.status,
      plantedAt: tree.planted_at,
      location: treeLocation(tree, true),
      replantDeadline: tree.replant_deadline,
      pausedSeconds: Number(tree.paused_seconds),
      latestEvidenceHash: tree.latest_evidence_hash,
    },
    submissions: bundle,
    events: unwrap(events, "load tree events").map((e) => ({
      type: e.kind,
      evidenceHash: e.evidence_hash,
      data: e.data,
      blockNumber: e.block_number,
      at: e.block_time,
      tx: { hash: e.tx_hash, url: txUrl(e.tx_hash) },
    })),
    payouts: unwrap(payouts, "load payouts").map((p) => ({
      milestone: p.milestone,
      amount: p.amount,
      planter: p.planter_address,
      at: p.block_time,
      tx: { hash: p.tx_hash, url: txUrl(p.tx_hash) },
    })),
  });
});

async function signedVideoUrl(path: string | null): Promise<string | null> {
  if (!path) return null;
  const { data, error } = await getSupabase()
    .storage.from(EVIDENCE_BUCKET)
    .createSignedUrl(path, SIGNED_READ_URL_SECONDS);
  return error ? null : data.signedUrl;
}

/**
 * The checks the server ran at submit time, run again now from the stored data. Null means the check could
 * not run (for example no signed payload yet, or the video is missing from storage).
 */
async function reverify(s: SubmissionRow, jwk: EcPublicJwk | undefined) {
  const payload = s.payload as EvidencePayload | null;
  const canonical = s.canonical;
  const signature = s.signature;

  let signatureValid: boolean | null = null;
  let evidenceHashMatches: boolean | null = null;
  let canonicalMatchesPayload: boolean | null = null;
  if (canonical && signature) {
    try {
      signatureValid = jwk ? await verifyDeviceSignature(jwk, utf8(canonical), signature) : null;
      evidenceHashMatches =
        s.evidence_hash === null
          ? null
          : computeEvidenceHash(utf8(canonical), base64UrlToBytes(signature)) === s.evidence_hash;
    } catch {
      signatureValid = false;
      evidenceHashMatches = false;
    }
    canonicalMatchesPayload = payload ? canonicalize(payload) === canonical : null;
  }

  let videoHashMatches: boolean | null = null;
  let recomputedSha256: string | null = null;
  if (s.video_path) {
    const { data, error } = await getSupabase()
      .storage.from(EVIDENCE_BUCKET)
      .download(s.video_path);
    if (!error && data) {
      recomputedSha256 = await sha256Hex(new Uint8Array(await data.arrayBuffer()));
      videoHashMatches =
        recomputedSha256 === s.video_sha256 &&
        (!payload || recomputedSha256 === payload.videoSha256);
    }
  }

  return {
    checkedAt: new Date().toISOString(),
    signatureValid,
    canonicalMatchesPayload,
    evidenceHashMatches,
    videoHashMatches,
    recomputedSha256,
  };
}
