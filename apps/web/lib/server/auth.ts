import "server-only";
import type { Tables } from "@treecord/shared";
import { conflict, forbidden, unauthorized } from "./errors";
import { getIdentityProvider } from "./identity";
import { getSupabase, PG, unwrap, unwrapMaybe } from "./supabase";

export type Profile = Tables<"profiles">;
export type Role = Profile["role"];

export interface AuthContext {
  profile: Profile;
  /** Lowercase embedded wallet address, or null if Privy has not created one yet. */
  wallet: `0x${string}` | null;
}

/**
 * Verifies the Privy access token in `Authorization: Bearer <token>`, then loads the caller's profile,
 * creating it on first sign-in (role donor). Fills in the wallet address once Privy has one.
 */
export async function authenticate(request: Request): Promise<AuthContext> {
  const header = request.headers.get("authorization");
  const match = header?.match(/^Bearer\s+(\S+)$/i);
  if (!match?.[1]) throw unauthorized("missing_token", "Missing bearer token");

  const identity = getIdentityProvider();
  let userId: string;
  try {
    ({ userId } = await identity.verifyAccessToken(match[1]));
  } catch {
    throw unauthorized("invalid_token", "Access token is invalid or expired");
  }

  const db = getSupabase();
  let profile: Profile | null = unwrapMaybe(
    await db.from("profiles").select("*").eq("privy_user_id", userId).maybeSingle(),
    "load profile",
  );

  if (!profile) {
    const wallet = await lookupWallet(userId);
    const inserted = await db
      .from("profiles")
      .insert({ privy_user_id: userId, wallet_address: wallet })
      .select("*")
      .single();
    if (inserted.error?.code === PG.uniqueViolation) {
      // Either a concurrent first request created this profile, or the wallet already belongs to another account.
      profile = unwrapMaybe(
        await db.from("profiles").select("*").eq("privy_user_id", userId).maybeSingle(),
        "reload profile",
      );
      if (!profile) {
        throw conflict(
          "wallet_already_linked",
          "This wallet is already linked to another Treecord account",
        );
      }
    } else {
      profile = unwrap(inserted, "create profile");
    }
  } else if (!profile.wallet_address) {
    const wallet = await lookupWallet(userId);
    if (wallet) {
      profile = unwrap(
        await db
          .from("profiles")
          .update({ wallet_address: wallet })
          .eq("id", profile.id)
          .select("*")
          .single(),
        "store wallet",
      );
    }
  }

  return { profile, wallet: (profile.wallet_address as `0x${string}` | null) ?? null };
}

/** Authenticates and requires one of the given roles. */
export async function requireRole(request: Request, ...roles: Role[]): Promise<AuthContext> {
  const auth = await authenticate(request);
  assertRole(auth, ...roles);
  return auth;
}

export function assertRole(auth: AuthContext, ...roles: Role[]): void {
  if (roles.length > 0 && !roles.includes(auth.profile.role)) {
    throw forbidden("forbidden_role", `Requires role: ${roles.join(" or ")}`);
  }
}

/** Requires a wallet, which every on-chain action needs. */
export function requireWallet(auth: AuthContext): `0x${string}` {
  if (!auth.wallet)
    throw forbidden(
      "wallet_missing",
      "Your account has no wallet yet. Sign in again to create one.",
    );
  return auth.wallet;
}

async function lookupWallet(userId: string): Promise<string | null> {
  try {
    const wallet = await getIdentityProvider().getEmbeddedWallet(userId);
    return wallet ? wallet.toLowerCase() : null;
  } catch (error) {
    // A Privy outage should not block sign-in. The wallet is filled in on a later request.
    console.warn("Could not load embedded wallet", error);
    return null;
  }
}
