import "server-only";
import type { Profile } from "./auth";

/** Public shape of a profile. */
export function profileView(profile: Profile) {
  return {
    id: profile.id,
    walletAddress: profile.wallet_address,
    role: profile.role,
    displayName: profile.display_name,
    isBuyer: profile.is_buyer,
    carbonRightsAgreementAccepted: profile.carbon_rights_agreement_hash !== null,
    carbonRightsAcceptedAt: profile.carbon_rights_accepted_at,
    createdAt: profile.created_at,
  };
}
