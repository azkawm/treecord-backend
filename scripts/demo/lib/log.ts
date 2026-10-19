// Readable console output for the demo: numbered steps, timestamps and explorer links.
import { CHAIN_ID } from "@treecord/shared";

let stepNumber = 0;
let chainId = 0;

export function setLogChain(id: number): void {
  chainId = id;
}

const time = () => new Date().toISOString().slice(11, 19);

export function step(title: string): void {
  stepNumber += 1;
  console.log(`\n[${time()}] ${stepNumber}. ${title}`);
}

export function info(message: string): void {
  console.log(`[${time()}]    ${message}`);
}

export function ok(message: string): void {
  console.log(`[${time()}]    ✓ ${message}`);
}

export function warn(message: string): void {
  console.log(`[${time()}]    ! ${message}`);
}

/** Basescan link on Base Sepolia, the bare hash on a local chain. */
export function txLink(hash: string | null | undefined): string {
  if (!hash) return "(no tx)";
  return chainId === CHAIN_ID ? `https://sepolia.basescan.org/tx/${hash}` : `${hash} (local)`;
}

export function addressLink(address: string): string {
  return chainId === CHAIN_ID ? `https://sepolia.basescan.org/address/${address}` : address;
}

export function tx(label: string, hash: string | null | undefined): void {
  info(`${label}: ${txLink(hash)}`);
}

/** USDC base units to "1.234567 USDC". */
export function usdc(amount: bigint | string): string {
  const value = BigInt(amount);
  return `${value / 1_000_000n}.${(value % 1_000_000n).toString().padStart(6, "0")} USDC`;
}

export function fail(error: unknown): never {
  console.error(
    `\n[${time()}] Demo stopped: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}
