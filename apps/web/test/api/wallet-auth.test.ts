import { createWalletToken } from "@treecord/shared";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterAll, describe, expect, it } from "vitest";
import { GET as getMe } from "@/app/api/me/route";
import {
  CompositeIdentityProvider,
  setIdentityProvider,
  WalletSignatureIdentityProvider,
} from "@/lib/server/identity";
import { call, dbAvailable, fakeIdentity, nowSec } from "../helpers";

function walletToken(chainId = 31337) {
  const account = privateKeyToAccount(generatePrivateKey());
  return createWalletToken({
    address: account.address,
    chainId,
    nowSec: nowSec(),
    signMessage: (message) => account.signMessage({ message }),
  }).then((token) => ({ token, wallet: account.address.toLowerCase() }));
}

describe("CompositeIdentityProvider", () => {
  it("sends wallet tokens to wallet sign-in and the rest to Privy", async () => {
    const provider = new CompositeIdentityProvider(
      fakeIdentity,
      new WalletSignatureIdentityProvider(31337),
    );
    const { token, wallet } = await walletToken();
    const { userId } = await provider.verifyAccessToken(token);
    expect(userId).toBe(`wallet:${wallet}`);
    expect(await provider.getEmbeddedWallet(userId)).toBe(wallet);
    expect(await provider.verifyAccessToken("test:did:privy:abc")).toEqual({
      userId: "did:privy:abc",
    });
  });

  it("rejects wallet tokens when wallet sign-in is off, and Privy tokens when Privy is not configured", async () => {
    const { token } = await walletToken();
    await expect(
      new CompositeIdentityProvider(fakeIdentity, null).verifyAccessToken(token),
    ).rejects.toThrow("disabled");
    await expect(
      new CompositeIdentityProvider(fakeIdentity, null).getEmbeddedWallet(
        "wallet:0x" + "a".repeat(40),
      ),
    ).resolves.toBeNull();
    await expect(
      new CompositeIdentityProvider(
        null,
        new WalletSignatureIdentityProvider(31337),
      ).verifyAccessToken("test:did:privy:abc"),
    ).rejects.toThrow("Privy");
  });

  it("rejects a token signed for another chain", async () => {
    const { token } = await walletToken(84532);
    await expect(
      new WalletSignatureIdentityProvider(31337).verifyAccessToken(token),
    ).rejects.toThrow();
  });
});

describe.skipIf(!dbAvailable)("wallet sign-in through the API", () => {
  afterAll(() => setIdentityProvider(fakeIdentity));

  it("creates a donor profile bound to the signing wallet", async () => {
    setIdentityProvider(
      new CompositeIdentityProvider(null, new WalletSignatureIdentityProvider(31337)),
    );
    const { token, wallet } = await walletToken();
    const res = await call(getMe, { token });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ role: "donor", wallet });

    const tampered = `${token.slice(0, -4)}0000`;
    expect((await call(getMe, { token: tampered })).status).toBe(401);
  });
});
