import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { bytesToBase64Url } from "./evidence.js";
import {
  createWalletToken,
  isWalletToken,
  verifyWalletToken,
  walletFromUserId,
  walletSignInMessage,
  walletUserId,
  WALLET_TOKEN_MAX_LIFETIME_SECONDS,
} from "./wallet-auth.js";

const account = privateKeyToAccount(generatePrivateKey());
const other = privateKeyToAccount(generatePrivateKey());
const NOW = 1_800_000_000;
const verify = (token: string, nowSec = NOW, chainId = 31337) =>
  verifyWalletToken(token, { chainId, nowSec });

function token(overrides: { lifetimeSec?: number; chainId?: number; nowSec?: number } = {}) {
  return createWalletToken({
    address: account.address,
    chainId: overrides.chainId ?? 31337,
    nowSec: overrides.nowSec ?? NOW,
    lifetimeSec: overrides.lifetimeSec,
    signMessage: (message) => account.signMessage({ message }),
  });
}

describe("wallet tokens", () => {
  it("round-trips to the signer's lowercase address", async () => {
    const t = await token();
    expect(isWalletToken(t)).toBe(true);
    expect(await verify(t)).toBe(account.address.toLowerCase());
  });

  it("rejects expired, future, too long and other-chain tokens", async () => {
    const t = await token({ lifetimeSec: 60 });
    await expect(verify(t, NOW + 60)).rejects.toThrow("expired");
    await expect(verify(await token({ nowSec: NOW + 600 }))).rejects.toThrow("future");
    await expect(
      verify(await token({ lifetimeSec: WALLET_TOKEN_MAX_LIFETIME_SECONDS + 1 })),
    ).rejects.toThrow("lifetime");
    await expect(verify(await token({ chainId: 84532 }))).rejects.toThrow("another chain");
  });

  it("rejects a signature from another key and a tampered payload", async () => {
    const payload = bytesToBase64Url(
      new TextEncoder().encode(
        JSON.stringify({
          address: account.address.toLowerCase(),
          chainId: 31337,
          issuedAt: NOW,
          expiresAt: NOW + 60,
        }),
      ),
    );
    const forged = await other.signMessage({ message: walletSignInMessage(payload) });
    await expect(verify(`wallet.${payload}.${forged}`)).rejects.toThrow("does not match");

    const [, , signature] = (await token()).split(".");
    const longer = bytesToBase64Url(
      new TextEncoder().encode(
        JSON.stringify({
          address: account.address.toLowerCase(),
          chainId: 31337,
          issuedAt: NOW,
          expiresAt: NOW + 7200,
        }),
      ),
    );
    await expect(verify(`wallet.${longer}.${signature}`)).rejects.toThrow("does not match");
  });

  it("rejects malformed tokens", async () => {
    await expect(verify("wallet.abc")).rejects.toThrow();
    await expect(verify(`wallet.%%%.0x${"00".repeat(65)}`)).rejects.toThrow("malformed");
    await expect(verify("eyJhbGciOi.payload.sig")).rejects.toThrow("not a wallet token");
    expect(isWalletToken("eyJhbGciOi.payload.sig")).toBe(false);
  });

  it("maps wallets to user ids and back", () => {
    const id = walletUserId(account.address);
    expect(id).toBe(`wallet:${account.address.toLowerCase()}`);
    expect(walletFromUserId(id)).toBe(account.address.toLowerCase());
    expect(walletFromUserId("did:privy:abc")).toBeNull();
    expect(walletFromUserId("wallet:0x12")).toBeNull();
  });
});
