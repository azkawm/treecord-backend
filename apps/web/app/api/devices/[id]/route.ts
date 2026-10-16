import { requireRole } from "@/lib/server/auth";
import { json, notFound, route } from "@/lib/server/errors";
import { parseUuid } from "@/lib/server/http";
import { getSupabase, unwrap, unwrapMaybe } from "@/lib/server/supabase";

/** DELETE /api/devices/:id: revoke one of the caller's devices. Revoking twice is a no-op. */
export const DELETE = route(async (request, { params }: { params: Promise<{ id: string }> }) => {
  const { profile } = await requireRole(request, "planter");
  const id = parseUuid((await params).id);
  const db = getSupabase();

  const device = unwrapMaybe(
    await db
      .from("devices")
      .select("id, revoked_at")
      .eq("id", id)
      .eq("profile_id", profile.id)
      .maybeSingle(),
    "load device",
  );
  if (!device) throw notFound("Device");
  if (device.revoked_at) return json({ device: { id, revokedAt: device.revoked_at } });

  const revoked = unwrap(
    await db
      .from("devices")
      .update({ revoked_at: new Date().toISOString() })
      .eq("id", id)
      .select("id, revoked_at")
      .single(),
    "revoke device",
  );
  return json({ device: { id: revoked.id, revokedAt: revoked.revoked_at } });
});
