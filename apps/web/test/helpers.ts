import { randomBytes, randomUUID } from "node:crypto";
import { MockAiClient, type Logger, type ScoreDeps } from "@treecord/pipeline";
import { CARBON_RIGHTS_AGREEMENT_VERSION, type EcPublicJwk, type Json } from "@treecord/shared";
import { keccak256, stringToBytes } from "viem";
import { getAttester } from "@/lib/server/attester";
import { getChainNow, setChainClock } from "@/lib/server/chain";
import { setIdentityProvider, type IdentityProvider } from "@/lib/server/identity";
import { getSupabase } from "@/lib/server/supabase";
import { newDevice, type TestDevice } from "./helpers-crypto";

// ---------------------------------------------------------------------------
// Database availability
// ---------------------------------------------------------------------------

async function probeDatabase(): Promise<boolean> {
  try {
    const response = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/species?select=code&limit=1`,
      {
        headers: {
          apikey: process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
          authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY ?? ""}`,
        },
        signal: AbortSignal.timeout(2000),
      },
    );
    return response.ok;
  } catch {
    return false;
  }
}

/** True when the local Supabase stack is reachable. Route suites skip (with a warning) otherwise. */
export const dbAvailable = await probeDatabase();
if (!dbAvailable) {
  console.warn(
    `\n⚠ Skipping API route tests: no Supabase at ${process.env.SUPABASE_URL}. Run \`pnpm db:start\` to include them.\n`,
  );
}

// ---------------------------------------------------------------------------
// Chain time
// ---------------------------------------------------------------------------

export function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

// Route tests run without anvil: chain time follows the wall clock.
setChainClock(async () => nowSec());

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

const wallets = new Map<string, string | null>();

/** Test identity provider: a token `test:<userId>` is valid, anything else is rejected. */
const fakeIdentity: IdentityProvider = {
  async verifyAccessToken(token) {
    if (!token.startsWith("test:")) throw new Error("invalid token");
    return { userId: token.slice("test:".length) };
  },
  async getEmbeddedWallet(userId) {
    return wallets.get(userId) ?? null;
  },
};
setIdentityProvider(fakeIdentity);

export function randomAddress(): `0x${string}` {
  return `0x${randomBytes(20).toString("hex")}`;
}

export function randomHash(): `0x${string}` {
  return `0x${randomBytes(32).toString("hex")}`;
}

export interface TestUser {
  userId: string;
  token: string;
  wallet: `0x${string}`;
  profileId: string;
}

/** Creates a profile directly in the database. Auditor and operator roles cannot be self-assigned. */
export async function createUser(
  role: "donor" | "planter" | "auditor" | "operator" = "donor",
): Promise<TestUser> {
  const userId = `did:privy:test-${randomUUID()}`;
  const wallet = randomAddress();
  wallets.set(userId, wallet);
  const { data, error } = await getSupabase()
    .from("profiles")
    .insert({
      privy_user_id: userId,
      wallet_address: wallet,
      role,
      carbon_rights_agreement_hash:
        role === "planter" ? keccak256(stringToBytes(CARBON_RIGHTS_AGREEMENT_VERSION)) : null,
    })
    .select("id")
    .single();
  if (error) throw error;
  return { userId, token: `test:${userId}`, wallet, profileId: data.id };
}

/** Changes what the fake Privy returns as a user's embedded wallet. */
export function setWallet(userId: string, wallet: `0x${string}` | null): void {
  wallets.set(userId, wallet);
}

/** A user who has never called the API: no profile row yet. */
export function newSignIn(wallet: `0x${string}` | null = randomAddress()): {
  userId: string;
  token: string;
} {
  const userId = `did:privy:test-${randomUUID()}`;
  wallets.set(userId, wallet);
  return { userId, token: `test:${userId}` };
}

// ---------------------------------------------------------------------------
// Campaign fixtures (what the indexer would write)
// ---------------------------------------------------------------------------

export interface CampaignFixture {
  status?: "funding" | "active" | "refunding" | "completed";
  treeTarget?: number;
  anchorSlots?: number;
  perPlanterCap?: number;
  claimDeadline?: Date;
  speciesCode?: string;
  regionName?: string;
  estimatedAmount?: string | null;
}

export async function createCampaign(fixture: CampaignFixture = {}): Promise<`0x${string}`> {
  const address = randomAddress();
  const treeTarget = fixture.treeTarget ?? 8;
  const anchorSlots = fixture.anchorSlots ?? 2;
  const { error } = await getSupabase()
    .from("campaigns")
    .insert({
      address,
      chain_id: 31337,
      creator_address: randomAddress(),
      status: fixture.status ?? "active",
      title: "Mahogany for Jakarta",
      species_code: fixture.speciesCode ?? "SWIETENIA_MACROPHYLLA",
      species_name: "Swietenia macrophylla",
      region_name: fixture.regionName ?? "Jakarta",
      region_center_lat: -6.2,
      region_center_lon: 106.816666,
      region_radius_m: 5000,
      region_geohash: "qqguwvt",
      tree_target: treeTarget,
      anchor_slots: anchorSlots,
      open_slots: treeTarget - anchorSlots,
      per_planter_cap: fixture.perPlanterCap ?? 3,
      // uint256 columns are written as decimal strings.
      funding_target: "1000000000" as unknown as number,
      funded_amount: "1000000000" as unknown as number,
      funding_deadline: new Date(Date.now() + 86_400_000).toISOString(),
      claim_deadline: (
        fixture.claimDeadline ?? new Date(Date.now() + 2 * 86_400_000)
      ).toISOString(),
      commitment_units: 36,
      time_unit_seconds: 60,
      split: {
        incentivesBps: 7000,
        seedlingsBps: 1000,
        verificationBps: 500,
        reserveBps: 1000,
        feeBps: 500,
      },
      per_tree_incentive: "87500000" as unknown as number,
      estimated_amount: (fixture.estimatedAmount ?? null) as unknown as number | null,
      metadata_uri: "http://localhost:3000/api/campaigns/metadata/test",
      created_block: 1,
      created_tx: randomHash(),
    });
  if (error) throw error;
  return address;
}

/** Marks slots as handed out, as the indexer does after SlotsClaimed / AnchorSlotsAssigned. */
export async function assignSlots(
  campaign: string,
  slots: { slotId: number; kind: "open" | "anchor"; planter: string }[],
): Promise<void> {
  const { error } = await getSupabase()
    .from("slots")
    .insert(
      slots.map((s) => ({
        campaign_address: campaign,
        slot_id: s.slotId,
        kind: s.kind,
        status: "claimed" as const,
        planter_address: s.planter,
        claimed_at: new Date().toISOString(),
      })),
    );
  if (error) throw error;
}

export interface TreeFixture {
  campaign: string;
  planter: string;
  slotId?: number;
  status?: "alive" | "flagged" | "dead" | "removed" | "completed";
  plantedAtSec?: number;
  exact?: { lat: number; lon: number } | null;
  replantDeadlineSec?: number | null;
}

/** Inserts a tree as the indexer would after TreePlanted. Returns its id. */
export async function createTree(fixture: TreeFixture): Promise<number> {
  const treeId = Date.now() * 1000 + Math.floor(Math.random() * 1000);
  const exact = fixture.exact === undefined ? { lat: -6.2, lon: 106.816666 } : fixture.exact;
  const { error } = await getSupabase()
    .from("trees")
    .insert({
      tree_id: treeId,
      campaign_address: fixture.campaign,
      slot_id: fixture.slotId ?? 1,
      planter_address: fixture.planter,
      status: fixture.status ?? "alive",
      planted_at: new Date((fixture.plantedAtSec ?? nowSec()) * 1000).toISOString(),
      geohash: "qqguwvt",
      exact_lat: exact?.lat ?? null,
      exact_lon: exact?.lon ?? null,
      replant_deadline:
        fixture.replantDeadlineSec == null
          ? null
          : new Date(fixture.replantDeadlineSec * 1000).toISOString(),
      latest_evidence_hash: randomHash(),
      planted_tx: randomHash(),
    });
  if (error) throw error;
  return treeId;
}

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

/** Generates a device keypair and registers its public key for the user, as POST /api/devices would. */
export async function registerDevice(user: TestUser): Promise<TestDevice> {
  const device = await newDevice();
  const { error } = await getSupabase()
    .from("devices")
    .insert({
      profile_id: user.profileId,
      public_key_jwk: device.jwk as unknown as { [key: string]: Json },
      thumbprint: device.thumbprint,
    });
  if (error) throw error;
  return device;
}

const silentLogger: Logger = { info: () => {}, warn: () => {}, error: () => {} };

/** What the worker passes to processScoreJob, with the mock AI. */
export function scoreDeps(ai = new MockAiClient()): ScoreDeps {
  return {
    db: getSupabase(),
    attester: getAttester(),
    chainNow: getChainNow,
    ai,
    log: silentLogger,
  };
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

type Handler<P> = (request: Request, context: { params: Promise<P> }) => Promise<Response>;

interface CallOptions<P> {
  method?: string;
  token?: string;
  body?: unknown;
  rawBody?: string;
  params?: P;
  query?: Record<string, string>;
  headers?: Record<string, string>;
}

export interface ApiResult {
  status: number;
  body: Record<string, unknown>;
}

/** Reads a nested field from a JSON response, for example `field(res.body, "job.id")`. */
export function field<T = unknown>(body: unknown, path: string): T {
  let current: unknown = body;
  for (const key of path.split(".")) {
    if (current === null || typeof current !== "object") return undefined as T;
    current = (current as Record<string, unknown>)[key];
  }
  return current as T;
}

/** Calls a route handler directly with a real Request. */
export async function call<P = Record<string, never>>(
  handler: Handler<P>,
  options: CallOptions<P> = {},
): Promise<ApiResult> {
  const url = new URL("http://localhost/api/test");
  for (const [key, value] of Object.entries(options.query ?? {})) url.searchParams.set(key, value);
  const headers = new Headers(options.headers);
  if (options.token) headers.set("authorization", `Bearer ${options.token}`);
  let body: string | undefined = options.rawBody;
  if (options.body !== undefined) {
    body = JSON.stringify(options.body);
    headers.set("content-type", "application/json");
  }
  const request = new Request(url, {
    method: options.method ?? (body ? "POST" : "GET"),
    headers,
    body,
  });
  const response = await handler(request, { params: Promise.resolve((options.params ?? {}) as P) });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : {} };
}

/** A fresh P-256 public key JWK, as a planter device would register. */
export async function newDeviceJwk(): Promise<EcPublicJwk> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  return (await crypto.subtle.exportKey("jwk", pair.publicKey)) as EcPublicJwk;
}
