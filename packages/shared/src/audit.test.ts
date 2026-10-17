import { keccak256, stringToBytes, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { auditSeed, canonicalJson, reportHash, sampleTreeIds } from "./audit.js";

const SESSION = "5b0f8e1c-6a43-4a8e-9d3b-0f3f3f6f9e21";
const BLOCK = `0x${"ab".repeat(32)}` as Hex;
const population = Array.from({ length: 50 }, (_, i) => BigInt(i + 1));

describe("auditSeed", () => {
  it("is keccak256 of the session id text and the block hash", () => {
    // 36 UTF-8 bytes of the id followed by the 32 hash bytes.
    const preimage = new Uint8Array([...stringToBytes(SESSION), ...new Uint8Array(32).fill(0xab)]);
    expect(auditSeed(SESSION, BLOCK)).toBe(keccak256(preimage));
    expect(auditSeed(SESSION.toUpperCase(), BLOCK)).toBe(auditSeed(SESSION, BLOCK));
    expect(auditSeed(SESSION, `0x${"cd".repeat(32)}`)).not.toBe(auditSeed(SESSION, BLOCK));
  });
});

describe("sampleTreeIds", () => {
  const seed = auditSeed(SESSION, BLOCK);

  it("gives the same sample for the same inputs, whatever the population order", () => {
    const a = sampleTreeIds(population, seed, 10);
    const b = sampleTreeIds([...population].reverse(), seed, 10);
    expect(a).toEqual(b);
    expect(a).toHaveLength(10);
    expect(new Set(a).size).toBe(10);
    for (const id of a) expect(population).toContain(id);
  });

  it("changes with the seed", () => {
    const other = auditSeed(SESSION, `0x${"cd".repeat(32)}`);
    expect(sampleTreeIds(population, other, 10)).not.toEqual(sampleTreeIds(population, seed, 10));
  });

  it("a smaller sample is a prefix of a larger one", () => {
    expect(sampleTreeIds(population, seed, 5)).toEqual(
      sampleTreeIds(population, seed, 20).slice(0, 5),
    );
  });

  it("returns the whole shuffled population when the sample is larger, and ignores duplicates", () => {
    const all = sampleTreeIds([3n, 1n, 2n, 2n], seed, 10);
    expect([...all].sort()).toEqual([1n, 2n, 3n]);
    expect(sampleTreeIds([], seed, 3)).toEqual([]);
    expect(() => sampleTreeIds(population, seed, -1)).toThrow();
  });

  it("stays stable across releases (recorded vector)", () => {
    expect(sampleTreeIds(population, seed, 5)).toMatchInlineSnapshot(`
      [
        33n,
        36n,
        25n,
        34n,
        29n,
      ]
    `);
  });

  it("picks every tree about equally often", () => {
    const counts = new Map<bigint, number>();
    for (let s = 0; s < 400; s++) {
      for (const id of sampleTreeIds(
        population.slice(0, 10),
        auditSeed(`${SESSION}-${s}`, BLOCK),
        3,
      )) {
        counts.set(id, (counts.get(id) ?? 0) + 1);
      }
    }
    // Expected 120 per tree (400 draws × 3 of 10).
    for (const count of counts.values()) {
      expect(count).toBeGreaterThan(80);
      expect(count).toBeLessThan(160);
    }
  });
});

describe("report hashing", () => {
  it("sorts keys at every level", () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { z: true, y: null }], c: "x" } })).toBe(
      '{"a":{"c":"x","d":[2,{"y":null,"z":true}]},"b":1}',
    );
  });

  it("hashes equal reports equally regardless of key order", () => {
    expect(reportHash({ a: 1, b: [1, 2] })).toBe(reportHash({ b: [1, 2], a: 1 }));
    expect(reportHash({ a: 1 })).toBe(keccak256(stringToBytes('{"a":1}')));
    expect(reportHash({ a: 1 })).not.toBe(reportHash({ a: 2 }));
  });
});
