// Canonical evidence payload, device signature checks, geohash and distance helpers.
// See PRODUCT_KNOWLEDGE.md section 7. Uses only WebCrypto, so it runs in Node 20+ and in browsers.
import { concat, keccak256, type Hex } from "viem";
import type { EVIDENCE_PAYLOAD_VERSION, EvidenceKind } from "./constants.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The payload a device signs for every evidence video. */
export interface EvidencePayload {
  v: typeof EVIDENCE_PAYLOAD_VERSION;
  kind: EvidenceKind;
  /** Campaign address, lowercase 0x-prefixed hex. */
  campaign: string;
  /** Decimal string. Set for PLANTED, null otherwise. */
  slotId: string | null;
  /** Decimal string. Null for PLANTED, set otherwise. */
  treeId: string | null;
  milestone: number;
  /** Lowercase hex SHA-256 of the video file, no 0x prefix. */
  videoSha256: string;
  /** Latitude in degrees. Serialized with 6 decimals. */
  lat: number;
  /** Longitude in degrees. Serialized with 6 decimals. */
  lon: number;
  /** GPS accuracy in meters. Serialized with 1 decimal. */
  acc: number;
  /** ISO 8601 UTC with milliseconds, for example 2026-10-20T03:15:00.000Z. */
  capturedAt: string;
  challenge: string | null;
  /** RFC 7638 thumbprint of the device public key. */
  deviceKey: string;
}

/** A P-256 public key as JWK. Private members are never included. */
export interface EcPublicJwk {
  kty: "EC";
  crv: "P-256";
  x: string;
  y: string;
  [member: string]: unknown;
}

export interface LatLon {
  lat: number;
  lon: number;
}

// ---------------------------------------------------------------------------
// Canonical serialization
// ---------------------------------------------------------------------------

/**
 * Serializes a payload exactly as the device signs it: keys in fixed order, no whitespace,
 * lat and lon with 6 decimals, acc with 1 decimal. Strings use JSON escaping.
 *
 * Example:
 * {"v":1,"kind":"PLANTED","campaign":"0x...","slotId":"12","treeId":null,"milestone":0,"videoSha256":"ab..",
 *  "lat":-6.200000,"lon":106.816666,"acc":8.5,"capturedAt":"2026-10-20T03:15:00.000Z","challenge":null,"deviceKey":".."}
 */
export function canonicalize(payload: EvidencePayload): string {
  return (
    "{" +
    [
      `"v":${integer(payload.v, "v")}`,
      `"kind":${JSON.stringify(payload.kind)}`,
      `"campaign":${JSON.stringify(payload.campaign)}`,
      `"slotId":${nullableString(payload.slotId)}`,
      `"treeId":${nullableString(payload.treeId)}`,
      `"milestone":${integer(payload.milestone, "milestone")}`,
      `"videoSha256":${JSON.stringify(payload.videoSha256)}`,
      `"lat":${fixed(payload.lat, 6, "lat")}`,
      `"lon":${fixed(payload.lon, 6, "lon")}`,
      `"acc":${fixed(payload.acc, 1, "acc")}`,
      `"capturedAt":${JSON.stringify(payload.capturedAt)}`,
      `"challenge":${nullableString(payload.challenge)}`,
      `"deviceKey":${JSON.stringify(payload.deviceKey)}`,
    ].join(",") +
    "}"
  );
}

/** UTF-8 bytes of the canonical payload. */
export function canonicalBytes(payload: EvidencePayload): Uint8Array {
  return utf8(canonicalize(payload));
}

function fixed(value: number, decimals: number, field: string): string {
  if (!Number.isFinite(value)) throw new Error(`Evidence payload ${field} must be a finite number`);
  const text = value.toFixed(decimals);
  // toFixed keeps a sign for values that round to zero from below (-0.0000001 -> "-0.000000").
  return /^-0\.0+$/.test(text) ? text.slice(1) : text;
}

function integer(value: number, field: string): string {
  if (!Number.isSafeInteger(value)) throw new Error(`Evidence payload ${field} must be an integer`);
  return String(value);
}

function nullableString(value: string | null): string {
  return value === null ? "null" : JSON.stringify(value);
}

// ---------------------------------------------------------------------------
// Hashes
// ---------------------------------------------------------------------------

/** On-chain evidence hash: keccak256(canonicalBytes ‖ signatureBytes). */
export function computeEvidenceHash(canonical: Uint8Array, signature: Uint8Array): Hex {
  return keccak256(concat([canonical, signature]));
}

/** Lowercase hex SHA-256 of some bytes, without 0x. Used for video files. */
export async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", asBuffer(data));
  return bytesToHex(new Uint8Array(digest));
}

// ---------------------------------------------------------------------------
// Device signatures (ECDSA P-256, SHA-256, IEEE P1363, base64url)
// ---------------------------------------------------------------------------

/**
 * Verifies a device signature over the canonical payload bytes. Returns false for any malformed key or
 * signature instead of throwing, so callers can map it to `signature_invalid`.
 */
export async function verifyDeviceSignature(
  publicKeyJwk: EcPublicJwk,
  canonical: Uint8Array,
  signatureB64url: string,
): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey(
      "jwk",
      { kty: publicKeyJwk.kty, crv: publicKeyJwk.crv, x: publicKeyJwk.x, y: publicKeyJwk.y },
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    const signature = base64UrlToBytes(signatureB64url);
    if (signature.length !== 64) return false;
    return await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      asBuffer(signature),
      asBuffer(canonical),
    );
  } catch {
    return false;
  }
}

/**
 * RFC 7638 JWK thumbprint of a P-256 public key: SHA-256 over the required members
 * {"crv","kty","x","y"} in lexicographic order with no whitespace, base64url encoded.
 */
export async function jwkThumbprint(jwk: EcPublicJwk): Promise<string> {
  const required = `{"crv":${JSON.stringify(jwk.crv)},"kty":${JSON.stringify(jwk.kty)},"x":${JSON.stringify(jwk.x)},"y":${JSON.stringify(jwk.y)}}`;
  const digest = await crypto.subtle.digest("SHA-256", asBuffer(utf8(required)));
  return bytesToBase64Url(new Uint8Array(digest));
}

// ---------------------------------------------------------------------------
// Geohash and distance
// ---------------------------------------------------------------------------

const GEOHASH_ALPHABET = "0123456789bcdefghjkmnpqrstuvwxyz";

/** Standard base32 geohash. Precision 7 is about 153 m x 153 m at the equator. */
export function encodeGeohash(lat: number, lon: number, precision: number): string {
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) throw new Error("lat out of range");
  if (!Number.isFinite(lon) || lon < -180 || lon > 180) throw new Error("lon out of range");
  if (!Number.isInteger(precision) || precision < 1 || precision > 12)
    throw new Error("precision must be 1 to 12");

  let latMin = -90;
  let latMax = 90;
  let lonMin = -180;
  let lonMax = 180;
  let hash = "";
  let bits = 0;
  let bitCount = 0;
  let evenBit = true; // longitude first

  while (hash.length < precision) {
    if (evenBit) {
      const mid = (lonMin + lonMax) / 2;
      if (lon >= mid) {
        bits = (bits << 1) | 1;
        lonMin = mid;
      } else {
        bits <<= 1;
        lonMax = mid;
      }
    } else {
      const mid = (latMin + latMax) / 2;
      if (lat >= mid) {
        bits = (bits << 1) | 1;
        latMin = mid;
      } else {
        bits <<= 1;
        latMax = mid;
      }
    }
    evenBit = !evenBit;
    if (++bitCount === 5) {
      hash += GEOHASH_ALPHABET.charAt(bits);
      bits = 0;
      bitCount = 0;
    }
  }
  return hash;
}

/** The geohash as Solidity bytes8: ASCII bytes, right-padded with zeros (same as `bytes8("qqguwvt")`). */
export function geohashToBytes8(geohash: string): Hex {
  if (geohash.length < 1 || geohash.length > 8)
    throw new Error("geohash must be 1 to 8 characters");
  for (const ch of geohash) {
    if (!GEOHASH_ALPHABET.includes(ch)) throw new Error(`invalid geohash character ${ch}`);
  }
  return `0x${bytesToHex(utf8(geohash)).padEnd(16, "0")}`;
}

/** Inverse of geohashToBytes8: the ASCII geohash without its zero padding. */
export function bytes8ToGeohash(value: Hex): string {
  if (!/^0x[0-9a-fA-F]{16}$/.test(value)) throw new Error("bytes8 must be 0x plus 16 hex digits");
  let out = "";
  for (let i = 2; i < 18; i += 2) {
    const code = parseInt(value.slice(i, i + 2), 16);
    if (code === 0) break;
    out += String.fromCharCode(code);
  }
  for (const ch of out) {
    if (!GEOHASH_ALPHABET.includes(ch)) throw new Error(`invalid geohash character ${ch}`);
  }
  return out;
}

/** Center of a geohash cell. */
export function decodeGeohash(geohash: string): LatLon {
  let latMin = -90;
  let latMax = 90;
  let lonMin = -180;
  let lonMax = 180;
  let evenBit = true; // longitude first
  for (const ch of geohash) {
    const index = GEOHASH_ALPHABET.indexOf(ch);
    if (index < 0) throw new Error(`invalid geohash character ${ch}`);
    for (let bit = 4; bit >= 0; bit--) {
      const on = ((index >> bit) & 1) === 1;
      if (evenBit) {
        const mid = (lonMin + lonMax) / 2;
        if (on) lonMin = mid;
        else lonMax = mid;
      } else {
        const mid = (latMin + latMax) / 2;
        if (on) latMin = mid;
        else latMax = mid;
      }
      evenBit = !evenBit;
    }
  }
  return { lat: (latMin + latMax) / 2, lon: (lonMin + lonMax) / 2 };
}

/** Mean Earth radius in meters (IUGG). */
const EARTH_RADIUS_M = 6_371_008.8;

/** Great-circle distance in meters. */
export function haversineMeters(a: LatLon, b: LatLon): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

// ---------------------------------------------------------------------------
// Byte helpers
// ---------------------------------------------------------------------------

export function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

export function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Decodes base64url (no padding required). Throws on characters outside the base64url alphabet. */
export function base64UrlToBytes(text: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new Error("invalid base64url");
  const base64 = text
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(text.length / 4) * 4, "=");
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** WebCrypto wants an ArrayBuffer-backed view. Copies only when the input is backed by something else. */
function asBuffer(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return bytes.buffer instanceof ArrayBuffer
    ? (bytes as Uint8Array<ArrayBuffer>)
    : new Uint8Array(bytes);
}
