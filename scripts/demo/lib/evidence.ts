// Planter device and evidence uploads, the same steps the PWA takes: hash the video, announce it, upload it
// to the signed URL, sign the canonical payload with the device key, submit.
import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { extname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  EVIDENCE_PAYLOAD_VERSION,
  bytesToBase64Url,
  canonicalize,
  jwkThumbprint,
  sha256Hex,
  type EcPublicJwk,
  type EvidenceKind,
  type EvidencePayload,
} from "@treecord/shared";
import { ApiRequestError, type DemoApi } from "./api.js";
import { warn } from "./log.js";
import type { DeviceState } from "./state.js";
import type { DemoUser } from "./users.js";

/** A device keypair like the PWA's, but exportable so the next script run can reuse it. */
export async function newDevice(): Promise<DeviceState> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  const publicJwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as EcPublicJwk;
  const privateJwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as Record<
    string,
    unknown
  >;
  return {
    privateJwk,
    publicJwk: { kty: "EC", crv: "P-256", x: publicJwk.x, y: publicJwk.y },
    thumbprint: await jwkThumbprint(publicJwk),
  };
}

async function sign(device: DeviceState, text: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "jwk",
    device.privateJwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    new TextEncoder().encode(text),
  );
  return bytesToBase64Url(new Uint8Array(signature));
}

// ---------------------------------------------------------------------------
// Videos
// ---------------------------------------------------------------------------

const videoDir = fileURLToPath(new URL("../videos/", import.meta.url));
const CONTENT_TYPES = {
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
} as const;
type VideoExt = keyof typeof CONTENT_TYPES;

interface SampleVideo {
  name: string;
  bytes: Uint8Array;
  contentType: (typeof CONTENT_TYPES)[VideoExt];
}

let samples: SampleVideo[] | undefined;
let nextSample = 0;

function loadSamples(): SampleVideo[] {
  if (samples) return samples;
  const files = existsSync(videoDir)
    ? readdirSync(videoDir)
        .filter((name) => extname(name).toLowerCase() in CONTENT_TYPES)
        .sort()
    : [];
  samples = files.map((name) => ({
    name,
    bytes: new Uint8Array(readFileSync(`${videoDir}${name}`)),
    contentType: CONTENT_TYPES[extname(name).toLowerCase() as VideoExt],
  }));
  if (samples.length === 0) {
    warn(
      "scripts/demo/videos/ has no .mp4, .mov or .webm files. Using generated placeholder clips, which only the mock AI accepts.",
    );
  }
  return samples;
}

/** MP4 box: 4-byte big-endian size, 4-byte type, payload. */
function mp4Box(type: string, payload: Uint8Array): Uint8Array {
  const box = new Uint8Array(8 + payload.length);
  new DataView(box.buffer).setUint32(0, box.length);
  box.set(new TextEncoder().encode(type), 4);
  box.set(payload, 8);
  return box;
}

/** EBML Void element (ID 0xEC), which WebM players skip. Payload under 127 bytes. */
function ebmlVoid(payload: Uint8Array): Uint8Array {
  return new Uint8Array([0xec, 0x80 | payload.length, ...payload]);
}

/**
 * The next video to upload. The API refuses a video hash it has seen before, so every upload gets 16 random
 * bytes in a container element players ignore (an MP4 `free` box or a WebM Void element). The real AI
 * service would still spot reused footage, so give it one distinct clip per submission.
 */
export function nextVideo(): SampleVideo {
  const all = loadSamples();
  const nonce = new Uint8Array(randomBytes(16));
  const base: SampleVideo = all[nextSample++ % Math.max(all.length, 1)] ?? {
    name: "placeholder.mp4",
    // An ftyp box: enough for the API, which checks the hash and size, not the frames.
    bytes: mp4Box("ftyp", new TextEncoder().encode("isom\0\0\x02\0isomiso2mp41")),
    contentType: "video/mp4",
  };
  const trailer = base.contentType === "video/webm" ? ebmlVoid(nonce) : mp4Box("free", nonce);
  const bytes = new Uint8Array(base.bytes.length + trailer.length);
  bytes.set(base.bytes);
  bytes.set(trailer, base.bytes.length);
  return { ...base, bytes };
}

// ---------------------------------------------------------------------------
// Submitting
// ---------------------------------------------------------------------------

export interface EvidenceTarget {
  kind: EvidenceKind;
  campaign: string;
  slotId?: number;
  treeId?: number;
  milestone: number;
  location: { lat: number; lon: number };
  challenge?: string | null;
}

/** Small GPS jitter, well inside the 15 m check-in radius. */
function jitter(location: { lat: number; lon: number }) {
  const offset = () => (Math.random() - 0.5) * 0.00002; // about ±1 m
  return {
    lat: Number((location.lat + offset()).toFixed(6)),
    lon: Number((location.lon + offset()).toFixed(6)),
  };
}

/** Announces, uploads, signs and submits one video. Returns the submission id. */
export async function submitEvidence(
  api: DemoApi,
  planter: DemoUser,
  device: DeviceState,
  target: EvidenceTarget,
): Promise<string> {
  const video = nextVideo();
  const sha256 = await sha256Hex(video.bytes);
  const slotId = target.slotId === undefined ? null : String(target.slotId);
  const treeId = target.treeId === undefined ? null : String(target.treeId);

  const announced = await api.post<{ submissionId: string; uploadUrl: string }>(
    planter,
    "/api/evidence/upload-url",
    {
      kind: target.kind,
      campaign: target.campaign,
      ...(slotId ? { slotId } : { treeId }),
      milestone: target.milestone,
      sha256,
      sizeBytes: video.bytes.length,
      durationSec: 7,
      contentType: video.contentType,
    },
  );

  const upload = await fetch(announced.uploadUrl, {
    method: "PUT",
    headers: { "content-type": video.contentType, "x-upsert": "false" },
    body: video.bytes,
  });
  if (!upload.ok) {
    throw new Error(`Video upload failed with ${upload.status}: ${await upload.text()}`);
  }

  const { lat, lon } = jitter(target.location);
  const payload: EvidencePayload = {
    v: EVIDENCE_PAYLOAD_VERSION,
    kind: target.kind,
    campaign: target.campaign.toLowerCase(),
    slotId,
    treeId,
    milestone: target.milestone,
    videoSha256: sha256,
    lat,
    lon,
    acc: 6.5,
    capturedAt: new Date().toISOString(),
    challenge: target.challenge ?? null,
    deviceKey: device.thumbprint,
  };
  const canonical = canonicalize(payload);
  try {
    await api.post(planter, `/api/evidence/${announced.submissionId}/submit`, {
      payload,
      canonical,
      signature: await sign(device, canonical),
    });
  } catch (error) {
    if (error instanceof ApiRequestError && error.status === 422) {
      const reasons = (error.body as { reasons?: string[] }).reasons ?? [];
      throw new Error(`${target.kind} evidence was rejected: ${reasons.join(", ")}`, {
        cause: error,
      });
    }
    throw error;
  }
  return announced.submissionId;
}
