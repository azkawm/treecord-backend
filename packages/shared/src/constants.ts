// Protocol defaults from PRODUCT_KNOWLEDGE.md sections 3, 7, 8 and 15.
// Mirrors packages/contracts/src/libraries/TreecordConstants.sol where the two overlap.

/** Base Sepolia. */
export const CHAIN_ID = 84532;
/** Local anvil. */
export const ANVIL_CHAIN_ID = 31337;

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

/** USDC decimals. Amounts are always bigint base units. */
export const USDC_DECIMALS = 6;
/** Basis point denominator. */
export const BPS = 10_000;

/** Default budget split in basis points (sums to BPS). */
export const DEFAULT_SPLIT = {
  incentivesBps: 7000,
  seedlingsBps: 1000,
  verificationBps: 500,
  reserveBps: 1000,
  feeBps: 500,
} as const;

// ---------------------------------------------------------------------------
// Campaigns
// ---------------------------------------------------------------------------

export const DEFAULT_ANCHOR_BPS = 2500;
export const DEFAULT_PER_PLANTER_CAP = 50;
export const MIN_COMMITMENT_UNITS = 36;
/** Production time unit: 30 days. */
export const PRODUCTION_TIME_UNIT_SECONDS = 30 * 24 * 60 * 60;
/** Default demo time unit (section 15, rule 4). */
export const DEFAULT_DEMO_TIME_UNIT_SECONDS = 180;

// ---------------------------------------------------------------------------
// Milestones
// ---------------------------------------------------------------------------

export const MILESTONE_COUNT = 6;
/** Time units after planting at which each milestone is due. Fixed regardless of commitment (rule 11). */
export const MILESTONE_DUE_UNITS = [0, 3, 6, 12, 24, 36] as const;
/** Share of the per-tree incentive per milestone, in bps. The last milestone pays the per-tree remainder on-chain. */
export const MILESTONE_SHARES_BPS = [1000, 1000, 1000, 1500, 1500, 4000] as const;
/** A milestone window stays open for this many time units after it opens. */
export const MILESTONE_WINDOW_UNITS = 1;
/** Time units a dead tree has to be replanted. */
export const REPLANT_UNITS = 2;

// ---------------------------------------------------------------------------
// Evidence capture and prechecks
// ---------------------------------------------------------------------------

/** Submissions must arrive within this long after capture. */
export const UPLOAD_WINDOW_MS = 72 * 60 * 60 * 1000;
/** Capture times further in the future than this are rejected. */
export const MAX_FUTURE_CAPTURE_MS = 5 * 60 * 1000;
/** Required GPS accuracy, in meters. */
export const MAX_GPS_ACCURACY_M = 30;
/** Later check-ins must be within this distance of the tree's first location, in meters. */
export const CHECK_IN_RADIUS_M = 15;
/** Public on-chain geohash precision (about 150 m cells). */
export const GEOHASH_PRECISION = 7;
/** Clip length enforced by the app (rule 10). */
export const APP_VIDEO_MIN_SEC = 5;
export const APP_VIDEO_MAX_SEC = 10;
/** Clip length accepted by the server, allowing for metadata jitter (rule 10). */
export const SERVER_VIDEO_MIN_SEC = 4;
export const SERVER_VIDEO_MAX_SEC = 12;
/** Maximum upload size. */
export const MAX_VIDEO_BYTES = 25 * 1024 * 1024;
/** Video types accepted by the evidence bucket. MediaRecorder produces webm on Android and mp4 on iOS. */
export const EVIDENCE_VIDEO_TYPES = ["video/mp4", "video/webm", "video/quicktime"] as const;
/** Devices a planter may have active at once. */
export const MAX_ACTIVE_DEVICES = 3;
/** Canonical evidence payload version. */
export const EVIDENCE_PAYLOAD_VERSION = 1;

// ---------------------------------------------------------------------------
// Attestations
// ---------------------------------------------------------------------------

/** Evidence kinds. The on-chain AttestationKind value is the index. */
export const EVIDENCE_KINDS = ["PLANTED", "ALIVE", "DEAD", "REPLANTED"] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

/** Maximum attestation score (100.00%). */
export const MAX_ATTESTATION_SCORE = 10_000;
/** Attestations expire this long after signing. */
export const ATTESTATION_TTL_SECONDS = 60 * 60;

// ---------------------------------------------------------------------------
// Carbon
// ---------------------------------------------------------------------------

/**
 * Version label of the planter agreement that assigns carbon rights to the platform. Its keccak256 hash is
 * stored on the planter's profile when they accept. Bump it when the agreement text changes.
 */
export const CARBON_RIGHTS_AGREEMENT_VERSION = "treecord-planter-carbon-rights-v1";

/** Carbon amounts use 3 decimals on-chain: 1000 units = 1 tCO2e. */
export const CARBON_DECIMALS = 3;
export const CARBON_UNITS_PER_TONNE = 1000;
