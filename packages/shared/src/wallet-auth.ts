// Wallet-signature sign-in for the demo scripts and local development. Real users sign in with Privy.
// The API accepts these tokens only when the server sets DEMO_WALLET_AUTH=true.
//
// Token: "wallet.<payload>.<signature>"
//   payload    base64url of the JSON { address, chainId, issuedAt, expiresAt } (unix seconds)
//   signature  EIP-191 personal_sign by `address` over walletSignInMessage(payload), 0x hex
//
// The signature proves the caller holds the wallet's key, so a token cannot claim someone else's wallet.
import { recoverMessageAddress, type Address, type Hex } from "viem";
import { z } from "zod";
import { base64UrlToBytes, bytesToBase64Url } from "./evidence.js";
import { lowercaseAddressSchema } from "./schemas.js";

export const WALLET_TOKEN_PREFIX = "wallet";
/** Profiles created by wallet sign-in use this prefix in place of a Privy user id. */
export const WALLET_USER_ID_PREFIX = "wallet:";
/** Longest token lifetime the API accepts. */
export const WALLET_TOKEN_MAX_LIFETIME_SECONDS = 24 * 60 * 60;
/** Allowed clock difference between the signer and the API. */
export const WALLET_TOKEN_CLOCK_SKEW_SECONDS = 5 * 60;

const walletTokenPayloadSchema = z
  .object({
    address: lowercaseAddressSchema,
    chainId: z.number().int().positive(),
    issuedAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().positive(),
  })
  .strict();
export type WalletTokenPayload = z.infer<typeof walletTokenPayloadSchema>;

/** The exact text the wallet signs. */
export function walletSignInMessage(encodedPayload: string): string {
  return `Treecord demo sign-in\n${encodedPayload}`;
}

export function isWalletToken(token: string): boolean {
  return token.startsWith(`${WALLET_TOKEN_PREFIX}.`);
}

export function walletUserId(address: string): string {
  return `${WALLET_USER_ID_PREFIX}${address.toLowerCase()}`;
}

/** The wallet behind a wallet sign-in user id, or null for any other id. */
export function walletFromUserId(userId: string): Address | null {
  if (!userId.startsWith(WALLET_USER_ID_PREFIX)) return null;
  const address = userId.slice(WALLET_USER_ID_PREFIX.length);
  return lowercaseAddressSchema.safeParse(address).success ? (address as Address) : null;
}

export interface CreateWalletTokenInput {
  address: Address;
  chainId: number;
  nowSec: number;
  lifetimeSec?: number;
  /** personal_sign, for example viem's `account.signMessage({ message })`. */
  signMessage: (message: string) => Promise<Hex>;
}

export async function createWalletToken(input: CreateWalletTokenInput): Promise<string> {
  const lifetime = input.lifetimeSec ?? 60 * 60;
  const payload: WalletTokenPayload = {
    address: input.address.toLowerCase() as Address,
    chainId: input.chainId,
    issuedAt: input.nowSec,
    expiresAt: input.nowSec + lifetime,
  };
  const encoded = bytesToBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
  const signature = await input.signMessage(walletSignInMessage(encoded));
  return `${WALLET_TOKEN_PREFIX}.${encoded}.${signature}`;
}

/**
 * Verifies a wallet token and returns the lowercase wallet address. Throws if the token is malformed,
 * signed by another key, for another chain, not yet valid, expired, or longer-lived than allowed.
 */
export async function verifyWalletToken(
  token: string,
  options: { chainId: number; nowSec: number },
): Promise<Address> {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== WALLET_TOKEN_PREFIX) {
    throw new Error("not a wallet token");
  }
  const [, encoded = "", signature = ""] = parts;
  if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) throw new Error("malformed signature");

  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder().decode(base64UrlToBytes(encoded)));
  } catch {
    throw new Error("malformed payload");
  }
  const parsed = walletTokenPayloadSchema.safeParse(decoded);
  if (!parsed.success) throw new Error("malformed payload");
  const payload = parsed.data;

  if (payload.chainId !== options.chainId) throw new Error("token is for another chain");
  if (payload.issuedAt > options.nowSec + WALLET_TOKEN_CLOCK_SKEW_SECONDS) {
    throw new Error("token issued in the future");
  }
  if (payload.expiresAt <= options.nowSec) throw new Error("token expired");
  if (payload.expiresAt - payload.issuedAt > WALLET_TOKEN_MAX_LIFETIME_SECONDS) {
    throw new Error("token lifetime too long");
  }

  const signer = await recoverMessageAddress({
    message: walletSignInMessage(encoded),
    signature: signature as Hex,
  });
  if (signer.toLowerCase() !== payload.address) throw new Error("signature does not match address");
  return payload.address as Address;
}
