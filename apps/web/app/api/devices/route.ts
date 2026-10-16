import { deviceRegisterRequestSchema, jwkThumbprint, MAX_ACTIVE_DEVICES } from "@treecord/shared";
import { requireRole } from "@/lib/server/auth";
import { conflict, json, route } from "@/lib/server/errors";
import { readJson } from "@/lib/server/http";
import { check, getSupabase, PG, unwrap } from "@/lib/server/supabase";

/**
 * POST /api/devices: register a planter device public key (P-256 JWK). Only the public members are stored.
 * At most 3 active devices per planter (also enforced by a database trigger).
 */
export const POST = route(async (request) => {
  const { profile } = await requireRole(request, "planter");
  const { publicKeyJwk, label } = await readJson(request, deviceRegisterRequestSchema);

  const jwk = {
    kty: publicKeyJwk.kty,
    crv: publicKeyJwk.crv,
    x: publicKeyJwk.x,
    y: publicKeyJwk.y,
  };
  const thumbprint = await jwkThumbprint(jwk);
  const db = getSupabase();

  const active = await db
    .from("devices")
    .select("id", { count: "exact", head: true })
    .eq("profile_id", profile.id)
    .is("revoked_at", null);
  check(active, "count devices");
  if ((active.count ?? 0) >= MAX_ACTIVE_DEVICES) throw deviceLimit();

  const inserted = await db
    .from("devices")
    .insert({ profile_id: profile.id, public_key_jwk: jwk, thumbprint, label: label ?? null })
    .select("id, thumbprint, label, created_at")
    .single();
  if (inserted.error?.code === PG.uniqueViolation) {
    throw conflict("device_already_registered", "This device key is already registered");
  }
  if (
    inserted.error?.code === PG.checkViolation &&
    inserted.error.message.includes("device_limit_reached")
  ) {
    throw deviceLimit();
  }
  const device = unwrap(inserted, "register device");
  return json(
    {
      device: {
        id: device.id,
        thumbprint: device.thumbprint,
        label: device.label,
        createdAt: device.created_at,
      },
    },
    { status: 201 },
  );
});

function deviceLimit() {
  return conflict(
    "device_limit_reached",
    `A planter can have at most ${MAX_ACTIVE_DEVICES} active devices. Revoke one first.`,
  );
}
