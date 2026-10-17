import type { Address } from "viem";

/**
 * Hands out transaction nonces per wallet without asking the node before every send, so several
 * transactions can be in flight at once. Sends for one wallet are serialized. If a send fails, the next one
 * re-reads the pending nonce from the chain, which closes any gap the failed send left.
 */
export class NonceManager {
  private readonly next = new Map<Address, number>();
  private readonly queues = new Map<Address, Promise<unknown>>();

  constructor(private readonly fetchPendingNonce: (address: Address) => Promise<number>) {}

  /** Runs `send` with the wallet's next nonce. The nonce is consumed only if `send` resolves. */
  withNonce<T>(address: Address, send: (nonce: number) => Promise<T>): Promise<T> {
    const key = address.toLowerCase() as Address;
    const previous = this.queues.get(key) ?? Promise.resolve();
    const run = previous
      .catch(() => undefined)
      .then(async () => {
        const nonce = this.next.get(key) ?? (await this.fetchPendingNonce(key));
        try {
          const result = await send(nonce);
          this.next.set(key, nonce + 1);
          return result;
        } catch (error) {
          this.next.delete(key);
          throw error;
        }
      });
    this.queues.set(key, run);
    return run;
  }

  /** Forgets the cached nonce, for example after an external transaction from the same key. */
  reset(address: Address): void {
    this.next.delete(address.toLowerCase() as Address);
  }
}
