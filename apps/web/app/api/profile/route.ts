import {
  CARBON_RIGHTS_AGREEMENT_VERSION,
  profileUpsertRequestSchema,
  type TablesUpdate,
} from "@treecord/shared";
import { keccak256, stringToBytes } from "viem";
import { authenticate } from "@/lib/server/auth";
import { badRequest, forbidden, json, route } from "@/lib/server/errors";
import { readJson } from "@/lib/server/http";
import { profileView } from "@/lib/server/profiles";
import { getSupabase, unwrap } from "@/lib/server/supabase";

const AGREEMENT_HASH = keccak256(stringToBytes(CARBON_RIGHTS_AGREEMENT_VERSION));

/**
 * POST /api/profile: update display name, buyer flag and role. Users can pick donor or planter only.
 * Auditor and operator roles are granted manually and cannot be changed here.
 * Becoming a planter requires accepting the carbon rights agreement.
 */
export const POST = route(async (request) => {
  const { profile } = await authenticate(request);
  const body = await readJson(request, profileUpsertRequestSchema);

  const update: TablesUpdate<"profiles"> = {};
  if (body.displayName !== undefined) update.display_name = body.displayName;
  if (body.isBuyer !== undefined) update.is_buyer = body.isBuyer;

  if (body.carbonRightsAgreementAccepted) {
    update.carbon_rights_agreement_hash = AGREEMENT_HASH;
    update.carbon_rights_accepted_at = new Date().toISOString();
  }

  if (body.role !== undefined && body.role !== profile.role) {
    if (profile.role === "auditor" || profile.role === "operator") {
      throw forbidden("role_locked", "Auditor and operator roles are managed by Treecord staff");
    }
    if (
      body.role === "planter" &&
      !profile.carbon_rights_agreement_hash &&
      !body.carbonRightsAgreementAccepted
    ) {
      throw badRequest(
        "agreement_required",
        "Planters must accept the carbon rights agreement (carbonRightsAgreementAccepted: true)",
        { agreementVersion: CARBON_RIGHTS_AGREEMENT_VERSION },
      );
    }
    update.role = body.role;
  }

  const updated = unwrap(
    await getSupabase().from("profiles").update(update).eq("id", profile.id).select("*").single(),
    "update profile",
  );
  return json({ profile: profileView(updated) });
});
