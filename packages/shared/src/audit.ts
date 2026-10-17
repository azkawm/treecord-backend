// Reproducible audit sampling (PRODUCT_KNOWLEDGE.md section 7). Pure, so anyone can recompute a session's
// sample from its published inputs: session id, block hash, and the tree population.
import {
  concatHex,
  encodePacked,
  hexToBigInt,
  keccak256,
  stringToBytes,
  stringToHex,
  type Hex,
} from "viem";

export const AUDIT_SAMPLE_ALGORITHM =
  "seed = keccak256(utf8(sessionId) ++ blockHash). Sort the population ascending. For i from n-1 down to 1: " +
  "r = uint256(keccak256(seed ++ uint256(i))), j = r mod (i + 1), swap items i and j. The sample is the " +
  "first sampleSize items.";

/** seed = keccak256(utf8(sessionId) ‖ blockHash). The session id is the lowercase UUID string. */
export function auditSeed(sessionId: string, blockHash: Hex): Hex {
  return keccak256(concatHex([stringToHex(sessionId.toLowerCase()), blockHash]));
}

/**
 * Seeded Fisher-Yates over the population sorted ascending, returning the first `sampleSize` ids in sample
 * order. Draw i uses keccak256(seed ‖ uint256(i)) mod (i + 1). With 256-bit draws the modulo bias is negligible.
 */
export function sampleTreeIds(
  population: readonly bigint[],
  seed: Hex,
  sampleSize: number,
): bigint[] {
  if (!Number.isInteger(sampleSize) || sampleSize < 0)
    throw new Error("sampleSize must be a whole number");
  const items = [...new Set(population)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (let i = items.length - 1; i > 0; i--) {
    const draw = hexToBigInt(keccak256(encodePacked(["bytes32", "uint256"], [seed, BigInt(i)])));
    const j = Number(draw % BigInt(i + 1));
    const a = items[i] as bigint;
    items[i] = items[j] as bigint;
    items[j] = a;
  }
  return items.slice(0, Math.min(sampleSize, items.length));
}

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** JSON with object keys sorted at every level, so the same report always hashes the same. */
export function canonicalJson(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k] as JsonValue)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** keccak256 of the canonical JSON, as stored in audit_sessions.report_hash. */
export function reportHash(report: JsonValue): Hex {
  return keccak256(stringToBytes(canonicalJson(report)));
}

export type { JsonValue };
