import "server-only";
import { estimateCarbon, type CarbonEstimate } from "@treecord/shared";
import type { CampaignRow } from "./campaigns";
import { getChainDeployment } from "./chain";
import { conflict } from "./errors";
import { check, getSupabase, unwrapMaybe } from "./supabase";

/**
 * The pre-certification estimate for a campaign from the species table: every committed tree that has not
 * been removed, over the commitment period (one time unit stands for one month).
 */
export async function campaignEstimate(
  campaign: CampaignRow,
): Promise<CarbonEstimate & { species: { code: string; name: string } }> {
  const db = getSupabase();
  if (!campaign.species_code) {
    throw conflict("species_unknown", "The campaign has no species, so it cannot be estimated");
  }
  const [species, removed] = await Promise.all([
    db
      .from("species")
      .select("code, scientific_name, est_kg_co2_per_year_mature::text, years_to_maturity")
      .eq("code", campaign.species_code)
      .maybeSingle(),
    db
      .from("trees")
      .select("tree_id", { count: "exact", head: true })
      .eq("campaign_address", campaign.address)
      .eq("status", "removed"),
  ]);
  const row = unwrapMaybe(species, "load species");
  check(removed, "count removed trees");
  if (!row) {
    throw conflict(
      "species_unknown",
      `Species ${campaign.species_code} is not in the species table`,
    );
  }
  const estimate = estimateCarbon({
    kgCo2PerYearMature: row.est_kg_co2_per_year_mature,
    yearsToMaturity: row.years_to_maturity,
    treeCount: Math.max(0, campaign.tree_target - (removed.count ?? 0)),
    commitmentMonths: campaign.commitment_units,
  });
  return { ...estimate, species: { code: row.code, name: row.scientific_name } };
}

/** Lowercase CarbonLedger address. Platform inventory is the ledger's own balance. */
export function ledgerAddress(): string {
  return getChainDeployment().carbonLedger.toLowerCase();
}
