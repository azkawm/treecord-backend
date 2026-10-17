import "server-only";
import { Attester, type AttestDeps } from "@treecord/pipeline";
import { getChainDeployment, getChainNow } from "./chain";
import { getServerEnv } from "./env";
import { getSupabase } from "./supabase";

let attester: Attester | undefined;

/** Signs attestations with ATTESTER_PRIVATE_KEY for the configured chain's VerificationGateway. */
export function getAttester(): Attester {
  if (!attester) {
    const env = getServerEnv();
    attester = new Attester(
      env.ATTESTER_PRIVATE_KEY as `0x${string}`,
      env.CHAIN_ID,
      getChainDeployment().verificationGateway,
    );
  }
  return attester;
}

/** Everything attestSubmission needs. */
export function attestDeps(): AttestDeps {
  return { db: getSupabase(), attester: getAttester(), chainNow: getChainNow };
}
