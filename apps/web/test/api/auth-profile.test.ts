import { describe, expect, it } from "vitest";
import { GET as getMe } from "@/app/api/me/route";
import { POST as postProfile } from "@/app/api/profile/route";
import { getSupabase } from "@/lib/server/supabase";
import {
  call,
  createUser,
  dbAvailable,
  field,
  newSignIn,
  randomAddress,
  setWallet,
} from "../helpers";

describe.skipIf(!dbAvailable)("auth", () => {
  it("rejects a missing bearer token", async () => {
    const res = await call(getMe);
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ error: { code: "missing_token" } });
  });

  it("rejects an invalid token", async () => {
    const res = await call(getMe, { token: "forged" });
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ error: { code: "invalid_token" } });
  });

  it("creates a donor profile with the embedded wallet on first sign-in", async () => {
    const wallet = randomAddress();
    const signIn = newSignIn(wallet.toUpperCase().replace("0X", "0x") as `0x${string}`);
    const res = await call(getMe, { token: signIn.token });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ role: "donor", wallet });
    const again = await call(getMe, { token: signIn.token });
    expect(field(again.body, "profile.id")).toBe(field(res.body, "profile.id"));
  });

  it("rejects a wallet that is already linked to another account", async () => {
    const existing = await createUser("donor");
    const signIn = newSignIn(existing.wallet);
    const res = await call(getMe, { token: signIn.token });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: { code: "wallet_already_linked" } });
  });

  it("fills in the wallet later if Privy had none at first sign-in", async () => {
    const signIn = newSignIn(null);
    const first = await call(getMe, { token: signIn.token });
    expect(first.body).toMatchObject({ wallet: null });

    const wallet = randomAddress();
    setWallet(signIn.userId, wallet);
    const res = await call(getMe, { token: signIn.token });
    expect(res.body).toMatchObject({ wallet });
    const stored = await getSupabase()
      .from("profiles")
      .select("wallet_address")
      .eq("privy_user_id", signIn.userId)
      .single();
    expect(stored.data?.wallet_address).toBe(wallet);
  });
});

describe.skipIf(!dbAvailable)("POST /api/profile", () => {
  it("updates display name and buyer flag", async () => {
    const donor = await createUser("donor");
    const res = await call(postProfile, {
      token: donor.token,
      body: { displayName: "PT Hijau", isBuyer: true },
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      profile: { displayName: "PT Hijau", isBuyer: true, role: "donor" },
    });
  });

  it("requires the carbon rights agreement to become a planter", async () => {
    const donor = await createUser("donor");
    const refused = await call(postProfile, { token: donor.token, body: { role: "planter" } });
    expect(refused.status).toBe(400);
    expect(refused.body).toMatchObject({ error: { code: "agreement_required" } });

    const accepted = await call(postProfile, {
      token: donor.token,
      body: { role: "planter", carbonRightsAgreementAccepted: true },
    });
    expect(accepted.status).toBe(200);
    expect(accepted.body).toMatchObject({
      profile: { role: "planter", carbonRightsAgreementAccepted: true },
    });
  });

  it("does not let auditors or operators change their role", async () => {
    for (const role of ["auditor", "operator"] as const) {
      const user = await createUser(role);
      const res = await call(postProfile, { token: user.token, body: { role: "donor" } });
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ error: { code: "role_locked" } });
    }
  });

  it("rejects self-assigned privileged roles and empty or malformed bodies", async () => {
    const donor = await createUser("donor");
    const operator = await call(postProfile, { token: donor.token, body: { role: "operator" } });
    expect(operator.status).toBe(400);
    expect(operator.body).toMatchObject({ error: { code: "validation_error" } });

    const empty = await call(postProfile, { token: donor.token, body: {} });
    expect(empty.status).toBe(400);

    const malformed = await call(postProfile, { token: donor.token, rawBody: "{not json" });
    expect(malformed.status).toBe(400);
    expect(malformed.body).toMatchObject({ error: { code: "invalid_json" } });
  });
});
