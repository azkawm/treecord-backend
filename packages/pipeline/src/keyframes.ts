// Copies AI keyframes into the backend's own "keyframes" bucket (PRODUCT_KNOWLEDGE.md section 15, rule 6).
import { base64UrlToBytes } from "@treecord/shared";
import { KEYFRAMES_BUCKET, type Db, type Logger } from "./db.js";

/** Bucket limit from the storage migration. */
export const MAX_KEYFRAME_BYTES = 2 * 1024 * 1024;
/** Keyframes kept per submission. */
export const MAX_KEYFRAMES = 8;

const EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

interface Image {
  bytes: Uint8Array;
  contentType: string;
}

/**
 * Stores up to MAX_KEYFRAMES keyframes at keyframes/{submissionId}/{index}.{ext} and returns their paths.
 * Keyframes are context for later growth checks, not proof, so one that cannot be fetched or decoded is
 * logged and skipped instead of failing the submission.
 */
export async function storeKeyframes(
  db: Db,
  submissionId: string,
  keyframes: string[],
  log: Logger,
  fetchImpl: typeof fetch = fetch,
): Promise<string[]> {
  const paths: string[] = [];
  for (const [index, source] of keyframes.slice(0, MAX_KEYFRAMES).entries()) {
    try {
      const image = source.startsWith("data:")
        ? decodeDataUrl(source)
        : await download(source, fetchImpl);
      const path = `${submissionId}/${index}.${EXTENSIONS[image.contentType] ?? "jpg"}`;
      const { error } = await db.storage
        .from(KEYFRAMES_BUCKET)
        .upload(path, image.bytes, { contentType: image.contentType, upsert: true });
      if (error) throw error;
      paths.push(path);
    } catch (error) {
      log.warn({ submissionId, index, error: String(error) }, "Skipping keyframe");
    }
  }
  return paths;
}

function decodeDataUrl(source: string): Image {
  const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+=*)$/.exec(source);
  if (!match?.[1] || !match[2]) throw new Error("unsupported data URL");
  const base64Url = match[2].replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return checkSize({ bytes: base64UrlToBytes(base64Url), contentType: match[1] });
}

async function download(url: string, fetchImpl: typeof fetch): Promise<Image> {
  if (!/^https?:\/\//.test(url)) throw new Error("keyframe URL must be http(s)");
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`keyframe download returned ${response.status}`);
  const contentType = (response.headers.get("content-type") ?? "").split(";")[0]?.trim() ?? "";
  if (!(contentType in EXTENSIONS)) throw new Error(`unsupported keyframe type ${contentType}`);
  return checkSize({ bytes: new Uint8Array(await response.arrayBuffer()), contentType });
}

function checkSize(image: Image): Image {
  if (image.bytes.length === 0 || image.bytes.length > MAX_KEYFRAME_BYTES) {
    throw new Error(
      `keyframe size ${image.bytes.length} is outside 1 to ${MAX_KEYFRAME_BYTES} bytes`,
    );
  }
  return image;
}
