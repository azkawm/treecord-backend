import type { Address } from "viem";
import { describe, expect, it } from "vitest";
import { NonceManager } from "./nonces.js";

const A = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as Address;
const B = "0x90f79bf6eb2c4f870365e785982e1f101e93b906" as Address;

describe("NonceManager", () => {
  it("reads the pending nonce once, then counts locally per wallet", async () => {
    const reads: string[] = [];
    const nonces = new NonceManager(async (address) => {
      reads.push(address);
      return address === A.toLowerCase() ? 7 : 0;
    });
    const used = await Promise.all([
      nonces.withNonce(A, async (n) => n),
      nonces.withNonce(A, async (n) => n),
      nonces.withNonce(B, async (n) => n),
      nonces.withNonce(A, async (n) => n),
    ]);
    expect(used).toEqual([7, 8, 0, 9]);
    expect(reads).toEqual([A.toLowerCase(), B.toLowerCase()]);
  });

  it("serializes sends for one wallet", async () => {
    const nonces = new NonceManager(async () => 0);
    const order: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const first = nonces.withNonce(A, async (n) => {
      order.push(`start ${n}`);
      await gate;
      order.push(`end ${n}`);
    });
    const second = nonces.withNonce(A, async (n) => {
      order.push(`start ${n}`);
    });
    await Promise.resolve();
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(["start 0", "end 0", "start 1"]);
  });

  it("re-reads from the chain after a failed send instead of leaving a gap", async () => {
    let chainNonce = 3;
    const nonces = new NonceManager(async () => chainNonce);
    expect(await nonces.withNonce(A, async (n) => n)).toBe(3);
    chainNonce = 4;
    await expect(
      nonces.withNonce(A, async () => {
        throw new Error("rejected");
      }),
    ).rejects.toThrow("rejected");
    // The failed send did not consume nonce 4.
    expect(await nonces.withNonce(A, async (n) => n)).toBe(4);
    nonces.reset(A);
    chainNonce = 9;
    expect(await nonces.withNonce(A, async (n) => n)).toBe(9);
  });
});
