import { flagCreateRequestSchema } from "@treecord/shared";
import { keccak256, stringToBytes } from "viem";
import { authenticate, requireWallet } from "@/lib/server/auth";
import { getChainDeployment } from "@/lib/server/chain";
import { conflict, forbidden, json, route } from "@/lib/server/errors";
import { readJson } from "@/lib/server/http";
import { check, getSupabase, unwrap, unwrapMaybe } from "@/lib/server/supabase";
import { loadTree } from "@/lib/server/trees";

/**
 * POST /api/flags: a contributor of the tree's campaign explains what is wrong. The server stores the text
 * and returns its keccak256 hash, which the contributor passes to TreeRegistry.flag from their own wallet.
 * The indexer then links the on-chain flag to this row by the hash. Same rules as the contract: contributors
 * only, and the tree must be Alive or Dead (a Flagged tree already has an active flag).
 */
export const POST = route(async (request) => {
  const auth = await authenticate(request);
  const wallet = requireWallet(auth);
  const { treeId, reasonText } = await readJson(request, flagCreateRequestSchema);
  const tree = await loadTree(Number(treeId));
  const db = getSupabase();

  const contributed = await db
    .from("contributions")
    .select("id", { count: "exact", head: true })
    .eq("campaign_address", tree.campaign_address)
    .eq("contributor_address", wallet);
  check(contributed, "check contribution");
  if ((contributed.count ?? 0) === 0) {
    throw forbidden("not_contributor", "Only contributors to this tree's campaign can flag it");
  }
  if (tree.status !== "alive" && tree.status !== "dead") {
    throw conflict("tree_not_flaggable", `A ${tree.status} tree cannot be flagged`, {
      status: tree.status,
    });
  }

  const reasonHash = keccak256(stringToBytes(reasonText));
  const call = {
    contract: getChainDeployment().treeRegistry.toLowerCase(),
    function: "flag(uint256,bytes32)",
    args: [treeId, reasonHash],
  };

  // The same contributor sending the same text again gets the same pending flag back.
  const existing = unwrapMaybe(
    await db
      .from("flags")
      .select("*")
      .eq("tree_id", tree.tree_id)
      .eq("flagger_address", wallet)
      .eq("reason_hash", reasonHash)
      .eq("status", "pending")
      .limit(1)
      .maybeSingle(),
    "find pending flag",
  );
  if (existing) return json({ flag: flagView(existing), reasonHash, call, idempotent: true });

  const flag = unwrap(
    await db
      .from("flags")
      .insert({
        tree_id: tree.tree_id,
        campaign_address: tree.campaign_address,
        flagger_address: wallet,
        flagger_profile_id: auth.profile.id,
        reason_text: reasonText,
        reason_hash: reasonHash,
      })
      .select("*")
      .single(),
    "create flag",
  );
  return json({ flag: flagView(flag), reasonHash, call, idempotent: false }, { status: 201 });
});

function flagView(flag: {
  id: string;
  tree_id: number;
  status: string;
  reason_text: string;
  reason_hash: string;
  created_at: string;
}) {
  return {
    id: flag.id,
    treeId: flag.tree_id,
    status: flag.status,
    reasonText: flag.reason_text,
    reasonHash: flag.reason_hash,
    createdAt: flag.created_at,
  };
}
