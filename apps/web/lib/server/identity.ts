import "server-only";
import { PrivyClient } from "@privy-io/node";
import { isWalletToken, verifyWalletToken, walletFromUserId, walletUserId } from "@treecord/shared";
import { getServerEnv } from "./env";

/** What the API needs from the identity provider. Privy in production (plus wallet sign-in for demos), a fake in tests. */
export interface IdentityProvider {
  /** Verifies an access token and returns the provider user id. Throws if the token is invalid or expired. */
  verifyAccessToken(token: string): Promise<{ userId: string }>;
  /** The user's embedded Ethereum wallet address, or null if none exists yet. */
  getEmbeddedWallet(userId: string): Promise<string | null>;
}

class PrivyIdentityProvider implements IdentityProvider {
  private readonly privy: PrivyClient;

  constructor(appId: string, appSecret: string) {
    this.privy = new PrivyClient({ appId, appSecret });
  }

  async verifyAccessToken(token: string): Promise<{ userId: string }> {
    const claims = await this.privy.utils().auth().verifyAccessToken(token);
    return { userId: claims.user_id };
  }

  async getEmbeddedWallet(userId: string): Promise<string | null> {
    const user = await this.privy.users()._get(userId);
    const wallets = user.linked_accounts
      .filter(
        (account) =>
          account.type === "wallet" &&
          "chain_type" in account &&
          account.chain_type === "ethereum" &&
          "wallet_client_type" in account &&
          account.wallet_client_type === "privy",
      )
      .map((account) => account as { address: string; wallet_index?: number });
    wallets.sort((a, b) => (a.wallet_index ?? 0) - (b.wallet_index ?? 0));
    return wallets[0]?.address ?? null;
  }
}

/** Wallet-signature sign-in for the demo scripts (DEMO_WALLET_AUTH). User ids are "wallet:<address>". */
export class WalletSignatureIdentityProvider implements IdentityProvider {
  constructor(
    private readonly chainId: number,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
  ) {}

  async verifyAccessToken(token: string): Promise<{ userId: string }> {
    const address = await verifyWalletToken(token, { chainId: this.chainId, nowSec: this.now() });
    return { userId: walletUserId(address) };
  }

  async getEmbeddedWallet(userId: string): Promise<string | null> {
    return walletFromUserId(userId);
  }
}

/** Sends wallet tokens to the wallet provider and everything else to Privy. Either may be switched off. */
export class CompositeIdentityProvider implements IdentityProvider {
  constructor(
    private readonly privy: IdentityProvider | null,
    private readonly wallet: IdentityProvider | null,
  ) {}

  async verifyAccessToken(token: string): Promise<{ userId: string }> {
    if (isWalletToken(token)) {
      if (!this.wallet) throw new Error("Wallet sign-in is disabled");
      return this.wallet.verifyAccessToken(token);
    }
    if (!this.privy) throw new Error("Privy is not configured");
    return this.privy.verifyAccessToken(token);
  }

  async getEmbeddedWallet(userId: string): Promise<string | null> {
    if (walletFromUserId(userId)) return this.wallet ? this.wallet.getEmbeddedWallet(userId) : null;
    return this.privy ? this.privy.getEmbeddedWallet(userId) : null;
  }
}

let provider: IdentityProvider | undefined;

export function getIdentityProvider(): IdentityProvider {
  if (!provider) {
    const env = getServerEnv();
    provider = new CompositeIdentityProvider(
      env.PRIVY_APP_ID && env.PRIVY_APP_SECRET
        ? new PrivyIdentityProvider(env.PRIVY_APP_ID, env.PRIVY_APP_SECRET)
        : null,
      env.DEMO_WALLET_AUTH ? new WalletSignatureIdentityProvider(env.CHAIN_ID) : null,
    );
  }
  return provider;
}

/** Test hook: replace the identity provider. */
export function setIdentityProvider(next: IdentityProvider | undefined): void {
  provider = next;
}
