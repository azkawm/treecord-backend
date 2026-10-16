import { calculateJwkThumbprint } from "jose";
import { concat, keccak256 } from "viem";
import { describe, expect, it } from "vitest";
import {
  base64UrlToBytes,
  bytesToBase64Url,
  canonicalBytes,
  canonicalize,
  computeEvidenceHash,
  encodeGeohash,
  geohashToBytes8,
  haversineMeters,
  jwkThumbprint,
  sha256Hex,
  utf8,
  verifyDeviceSignature,
  type EcPublicJwk,
  type EvidencePayload,
} from "./evidence.js";

const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const DEVICE_KEY = "NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs";

/** The example payload from PRODUCT_KNOWLEDGE.md section 7, with concrete values. */
const PLANTED: EvidencePayload = {
  v: 1,
  kind: "PLANTED",
  campaign: "0x2222222222222222222222222222222222222222",
  slotId: "12",
  treeId: null,
  milestone: 0,
  videoSha256: EMPTY_SHA256,
  lat: -6.2,
  lon: 106.816666,
  acc: 8.5,
  capturedAt: "2026-10-20T03:15:00.000Z",
  challenge: null,
  deviceKey: DEVICE_KEY,
};

const PLANTED_CANONICAL =
  `{"v":1,"kind":"PLANTED","campaign":"0x2222222222222222222222222222222222222222","slotId":"12","treeId":null,` +
  `"milestone":0,"videoSha256":"${EMPTY_SHA256}","lat":-6.200000,"lon":106.816666,"acc":8.5,` +
  `"capturedAt":"2026-10-20T03:15:00.000Z","challenge":null,"deviceKey":"${DEVICE_KEY}"}`;

const ALIVE: EvidencePayload = {
  ...PLANTED,
  kind: "ALIVE",
  slotId: null,
  treeId: "42",
  milestone: 3,
  lat: 0.1,
  lon: -73,
  acc: 12,
  challenge: "K7Q2",
};

const ALIVE_CANONICAL =
  `{"v":1,"kind":"ALIVE","campaign":"0x2222222222222222222222222222222222222222","slotId":null,"treeId":"42",` +
  `"milestone":3,"videoSha256":"${EMPTY_SHA256}","lat":0.100000,"lon":-73.000000,"acc":12.0,` +
  `"capturedAt":"2026-10-20T03:15:00.000Z","challenge":"K7Q2","deviceKey":"${DEVICE_KEY}"}`;

describe("canonicalize", () => {
  it("matches the PLANTED fixture", () => {
    expect(canonicalize(PLANTED)).toBe(PLANTED_CANONICAL);
  });

  it("matches the ALIVE fixture with a challenge and padded decimals", () => {
    expect(canonicalize(ALIVE)).toBe(ALIVE_CANONICAL);
  });

  it("ignores the key order of the input object", () => {
    const reversed = Object.fromEntries(
      Object.entries(PLANTED).reverse(),
    ) as unknown as EvidencePayload;
    expect(canonicalize(reversed)).toBe(PLANTED_CANONICAL);
  });

  it("is stable across repeated calls and round-trips through JSON.parse", () => {
    const first = canonicalize(PLANTED);
    expect(canonicalize(PLANTED)).toBe(first);
    const parsed = JSON.parse(first) as EvidencePayload;
    expect(canonicalize(parsed)).toBe(first);
  });

  it("rounds to the fixed precision", () => {
    const text = canonicalize({ ...PLANTED, lat: -6.2000004, lon: 106.8166666, acc: 8.04 });
    expect(text).toContain('"lat":-6.200000,"lon":106.816667,"acc":8.0');
  });

  it("never emits a negative zero", () => {
    expect(canonicalize({ ...PLANTED, lat: -0.0000001, lon: -0 })).toContain(
      '"lat":0.000000,"lon":0.000000',
    );
  });

  it("escapes strings with JSON rules", () => {
    expect(canonicalize({ ...ALIVE, challenge: 'a"b' })).toContain('"challenge":"a\\"b"');
  });

  it("rejects non-finite numbers and non-integer milestones", () => {
    expect(() => canonicalize({ ...PLANTED, lat: Number.NaN })).toThrow(/lat/);
    expect(() => canonicalize({ ...PLANTED, acc: Number.POSITIVE_INFINITY })).toThrow(/acc/);
    expect(() => canonicalize({ ...PLANTED, milestone: 1.5 })).toThrow(/milestone/);
  });

  it("returns UTF-8 bytes of the canonical string", () => {
    expect(new TextDecoder().decode(canonicalBytes(PLANTED))).toBe(PLANTED_CANONICAL);
  });
});

describe("device signatures", () => {
  async function newDevice() {
    const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
      "verify",
    ]);
    const jwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as EcPublicJwk;
    const sign = async (bytes: Uint8Array) =>
      bytesToBase64Url(
        new Uint8Array(
          await crypto.subtle.sign(
            { name: "ECDSA", hash: "SHA-256" },
            pair.privateKey,
            bytes as Uint8Array<ArrayBuffer>,
          ),
        ),
      );
    return { jwk, sign };
  }

  it("verifies a signature over the canonical bytes", async () => {
    const device = await newDevice();
    const bytes = canonicalBytes(PLANTED);
    const signature = await device.sign(bytes);
    expect(base64UrlToBytes(signature)).toHaveLength(64);
    expect(await verifyDeviceSignature(device.jwk, bytes, signature)).toBe(true);
  });

  it("fails for a tampered payload", async () => {
    const device = await newDevice();
    const signature = await device.sign(canonicalBytes(PLANTED));
    const tampered = canonicalBytes({ ...PLANTED, lat: -6.200001 });
    expect(await verifyDeviceSignature(device.jwk, tampered, signature)).toBe(false);
  });

  it("fails for another device's key", async () => {
    const [a, b] = [await newDevice(), await newDevice()];
    const bytes = canonicalBytes(PLANTED);
    expect(await verifyDeviceSignature(b.jwk, bytes, await a.sign(bytes))).toBe(false);
  });

  it("returns false instead of throwing for malformed input", async () => {
    const device = await newDevice();
    const bytes = canonicalBytes(PLANTED);
    expect(await verifyDeviceSignature(device.jwk, bytes, "not base64url!")).toBe(false);
    expect(
      await verifyDeviceSignature(device.jwk, bytes, bytesToBase64Url(new Uint8Array(63))),
    ).toBe(false);
    expect(
      await verifyDeviceSignature({ ...device.jwk, x: "AAAA" }, bytes, await device.sign(bytes)),
    ).toBe(false);
  });
});

describe("jwkThumbprint", () => {
  it("matches jose's RFC 7638 implementation", async () => {
    const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
    ]);
    const jwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as EcPublicJwk;
    expect(await jwkThumbprint(jwk)).toBe(await calculateJwkThumbprint(jwk, "sha256"));
  });

  it("ignores optional members and is 43 base64url characters", async () => {
    const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
    ]);
    const jwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as EcPublicJwk;
    const thumbprint = await jwkThumbprint(jwk);
    expect(await jwkThumbprint({ ...jwk, kid: "device-1", key_ops: ["verify"], ext: true })).toBe(
      thumbprint,
    );
    expect(thumbprint).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});

describe("hashes", () => {
  it("computes keccak256(canonical ‖ signature)", () => {
    const canonical = canonicalBytes(PLANTED);
    const signature = new Uint8Array(64).fill(7);
    expect(computeEvidenceHash(canonical, signature)).toBe(
      keccak256(concat([canonical, signature])),
    );
  });

  it("computes SHA-256 hex", async () => {
    expect(await sha256Hex(utf8("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(await sha256Hex(new Uint8Array())).toBe(EMPTY_SHA256);
  });
});

describe("geohash", () => {
  it("matches the reference vector", () => {
    expect(encodeGeohash(57.64911, 10.40744, 11)).toBe("u4pruydqqvj");
  });

  it("handles the origin and the extreme corners", () => {
    expect(encodeGeohash(0, 0, 7)).toBe("s000000");
    expect(encodeGeohash(90, 180, 7)).toBe("zzzzzzz");
    expect(encodeGeohash(-90, -180, 7)).toBe("0000000");
  });

  it("is a prefix-stable hierarchy", () => {
    const full = encodeGeohash(-6.2, 106.816666, 9);
    expect(encodeGeohash(-6.2, 106.816666, 7)).toBe(full.slice(0, 7));
  });

  it("rejects bad input", () => {
    expect(() => encodeGeohash(91, 0, 7)).toThrow();
    expect(() => encodeGeohash(0, 181, 7)).toThrow();
    expect(() => encodeGeohash(0, 0, 0)).toThrow();
    expect(() => encodeGeohash(Number.NaN, 0, 7)).toThrow();
  });

  it('converts to Solidity bytes8 like bytes8("qqguwvt")', () => {
    expect(geohashToBytes8("qqguwvt")).toBe("0x7171677577767400");
    expect(geohashToBytes8("s0000000")).toBe("0x7330303030303030");
    expect(() => geohashToBytes8("qqguwvta")).toThrow(/character a/);
    expect(() => geohashToBytes8("123456789")).toThrow();
    expect(() => geohashToBytes8("")).toThrow();
  });
});

describe("haversineMeters", () => {
  it("measures one degree of latitude", () => {
    expect(haversineMeters({ lat: 0, lon: 0 }, { lat: 1, lon: 0 })).toBeCloseTo(111_195.08, 1);
  });

  it("is zero for the same point and symmetric", () => {
    const a = { lat: -6.2, lon: 106.816666 };
    const b = { lat: -6.20009, lon: 106.816666 };
    expect(haversineMeters(a, a)).toBe(0);
    expect(haversineMeters(a, b)).toBeCloseTo(haversineMeters(b, a), 9);
    expect(haversineMeters(a, b)).toBeGreaterThan(9.9);
    expect(haversineMeters(a, b)).toBeLessThan(10.1);
  });
});

describe("base64url", () => {
  it("round-trips arbitrary bytes", () => {
    const bytes = new Uint8Array(256).map((_, i) => i);
    expect(base64UrlToBytes(bytesToBase64Url(bytes))).toEqual(bytes);
  });
});
