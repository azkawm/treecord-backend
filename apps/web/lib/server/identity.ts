import "server-only";
import { PrivyClient } from "@privy-io/node";
import { getServerEnv } from "./env";

/** What the API needs from the identity provider. Privy in production, a fake in tests. */
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

let provider: IdentityProvider | undefined;

export function getIdentityProvider(): IdentityProvider {
  if (!provider) {
    const env = getServerEnv();
    provider = new PrivyIdentityProvider(env.PRIVY_APP_ID, env.PRIVY_APP_SECRET);
  }
  return provider;
}

/** Test hook: replace the identity provider. */
export function setIdentityProvider(next: IdentityProvider | undefined): void {
  provider = next;
}
