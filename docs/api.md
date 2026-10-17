# Treecord API

Next.js route handlers in `apps/web/app/api`. All bodies and responses are JSON.

## Conventions

- **Auth:** `Authorization: Bearer <Privy access token>`. The server verifies the token with Privy, then loads the caller's profile, creating it on first sign-in with role `donor` and the user's embedded wallet.
- **Roles:** `donor`, `planter`, `auditor`, `operator`. Users can switch between donor and planter themselves. Auditor and operator are granted manually.
- **Validation:** every body and query string is validated with the zod schemas in `packages/shared/src/schemas.ts`. Unknown fields are rejected.
- **Money** is always a decimal string of USDC base units (6 decimals), for example `"1000000"` = 1 USDC. Carbon amounts are on-chain units with 3 decimals (`"1000"` = 1 tCO2e). Estimates before issuance are labeled `pre-certification`.
- **Addresses** may be sent in any case. Responses always use lowercase.
- **Idempotency:** endpoints that enqueue on-chain work accept an optional `Idempotency-Key` header (1 to 200 visible ASCII characters). Repeating a request with the same key returns the original job with status 200 and `"idempotent": true`. Reusing a key for a different caller or action returns 409 `idempotency_key_reused`.
- **Gasless actions:** planters never send transactions. Endpoints that change the chain enqueue a relayer job and return 202 with the job. Poll `GET /api/jobs/:id`.

### Errors

```json
{ "error": { "code": "planter_cap_exceeded", "message": "You can claim at most 1 more slots in this campaign", "details": { "remaining": 1, "cap": 3 } } }
```

| Status | Code | When |
|---|---|---|
| 400 | `validation_error` | Body or query fails its schema. `details` lists `{ path, message }` per issue |
| 400 | `invalid_json` | Body is not valid JSON |
| 400 | `invalid_path` | Malformed path parameter (UUID or address) |
| 400 | `invalid_idempotency_key` | Malformed Idempotency-Key header |
| 401 | `missing_token` | No bearer token |
| 401 | `invalid_token` | Token invalid or expired |
| 403 | `forbidden_role` | Caller lacks the required role |
| 403 | `wallet_missing` | Action needs a wallet and Privy has not created one yet |
| 404 | `not_found` | Resource does not exist or is not visible to the caller |
| 409 | `wallet_already_linked` | First sign-in with a wallet that belongs to another account |
| 409 | `idempotency_key_reused` | See Idempotency |
| 500 | `database_error`, `internal_error` | Unexpected failure. Details are logged, not returned |

## Endpoints

| Method | Path | Role | Purpose |
|---|---|---|---|
| GET | `/api/me` | any | Caller's profile, wallet and role |
| POST | `/api/profile` | any | Update display name, buyer flag, role (donor or planter) |
| POST | `/api/devices` | planter | Register a device public key |
| DELETE | `/api/devices/:id` | planter | Revoke a device |
| POST | `/api/campaigns/metadata` | donor, operator | Store campaign metadata before the factory call |
| GET | `/api/campaigns/metadata/:id` | public | Resolve a campaign `metadataURI` |
| GET | `/api/campaigns` | public | List campaigns |
| GET | `/api/campaigns/:address` | public | Campaign detail with slot counts |
| POST | `/api/campaigns/:address/claims` | planter | Claim open slots (gasless) |
| POST | `/api/operator/campaigns/:address/anchor-assign` | operator | Assign anchor slots to a planter |
| GET | `/api/jobs/:id` | creator, operator | Relayer job status |
| POST | `/api/evidence/upload-url` | planter | Announce a video and get a signed upload URL |
| POST | `/api/evidence/:submissionId/submit` | planter (owner) | Submit the signed payload, run prechecks, queue scoring |
| GET | `/api/evidence/:submissionId` | owner, operator, auditor | Submission status, reasons, scores, tx hash |
| POST | `/api/operator/submissions/:id/review` | operator | Approve or reject a `needs_review` submission |
| GET | `/api/donor/dashboard` | donor, operator | Contributed campaigns: share, tree health, payouts, carbon, open flags |
| GET | `/api/trees/:treeId` | public (more for planter, operator, auditor) | Tree timeline, milestones, payouts, flags |
| POST | `/api/flags` | contributor of the tree's campaign | Store a flag reason and get its hash for `TreeRegistry.flag` |
| POST | `/api/operator/flags/:id/resolve` | operator | Uphold or dismiss an on-chain flag |
| GET | `/api/reports/campaign/:address` | public | Campaign impact report |
| GET | `/api/planter/trees` | planter | My trees with milestone windows and amounts |
| GET | `/api/planter/challenges` | planter | Open challenges on my trees |
| POST | `/api/audit/sessions` | auditor | Open a session with a reproducible random sample |
| GET | `/api/audit/sessions/:id` | auditor (owner) | Session, sample, findings, challenges |
| GET | `/api/audit/sessions/:id/trees/:treeId` | auditor (owner) | Full evidence bundle for a sampled tree (logged) |
| POST | `/api/audit/sessions/:id/challenges` | auditor (owner) | Issue a "prove it now" challenge |
| POST | `/api/audit/sessions/:id/findings` | auditor (owner) | Record a finding for a sampled tree |
| POST | `/api/audit/sessions/:id/close` | auditor (owner) | Build and hash the report, close the session |
| GET | `/api/audit/sessions/:id/reproduce` | public | Inputs and check for recomputing the sample |
| POST | `/api/operator/carbon/estimate` | operator | Compute and set the pre-certification estimate |
| POST | `/api/operator/carbon/issue` | operator | Mirror a registry issuance on-chain |
| GET | `/api/carbon/batches` | public | Issued batches with inventory |
| GET | `/api/carbon/holdings` | any | My reservations, balances and retirements |
| GET | `/api/carbon/retirements/:id` | public | Retirement certificate |

---

### GET /api/me

Returns the caller's profile. Creates it on first sign-in and fills in the wallet once Privy has one.

**200**

```json
{
  "profile": {
    "id": "uuid",
    "walletAddress": "0xabc...",
    "role": "donor",
    "displayName": null,
    "isBuyer": false,
    "carbonRightsAgreementAccepted": false,
    "carbonRightsAcceptedAt": null,
    "createdAt": "2026-10-17T00:00:00.000Z"
  },
  "wallet": "0xabc...",
  "role": "donor"
}
```

Errors: 401, 409 `wallet_already_linked`.

### POST /api/profile

```json
{ "displayName": "PT Hijau", "role": "planter", "carbonRightsAgreementAccepted": true, "isBuyer": false }
```

All fields are optional, but at least one is required. `role` is `donor` or `planter`. Becoming a planter requires `carbonRightsAgreementAccepted: true` (now or earlier): planters assign carbon rights to the platform and earn incentives only. The keccak256 hash of `CARBON_RIGHTS_AGREEMENT_VERSION` is stored with the acceptance time.

**200** `{ "profile": { ... } }` (same shape as `/api/me`)

| Status | Code | When |
|---|---|---|
| 400 | `agreement_required` | Becoming a planter without accepting the agreement |
| 400 | `validation_error` | Empty body, unknown field, or a role other than donor or planter |
| 403 | `role_locked` | Caller is an auditor or operator |

### POST /api/devices

Role: planter.

```json
{ "publicKeyJwk": { "kty": "EC", "crv": "P-256", "x": "...", "y": "..." }, "label": "Pixel 8" }
```

Only the public members are stored. The key's RFC 7638 thumbprint is the `deviceKey` in every signed evidence payload.

**201** `{ "device": { "id": "uuid", "thumbprint": "43 base64url chars", "label": "Pixel 8", "createdAt": "..." } }`

| Status | Code | When |
|---|---|---|
| 400 | `validation_error` | Not a P-256 public JWK, or it includes the private member `d` |
| 409 | `device_limit_reached` | Already 3 active devices |
| 409 | `device_already_registered` | Same key registered before |

### DELETE /api/devices/:id

Role: planter. Revokes one of the caller's devices. Revoking an already revoked device returns the original revocation time.

**200** `{ "device": { "id": "uuid", "revokedAt": "..." } }`

Errors: 400 `invalid_path`, 404 (not the caller's device).

### POST /api/campaigns/metadata

Role: donor or operator. Store metadata, then pass the returned `metadataURI` to `CampaignFactory.createCampaign`.

```json
{
  "title": "Mahogany for Jakarta",
  "description": "Restoring the Ciliwung riverbank.",
  "speciesCode": "SWIETENIA_MACROPHYLLA",
  "regionName": "Jakarta",
  "regionCenter": { "lat": -6.2, "lon": 106.816666 },
  "regionRadiusM": 5000,
  "imageUrls": []
}
```

`regionRadiusM` is 100 to 100000. `description` and `imageUrls` (up to 10) are optional.

**201** `{ "id": "uuid", "metadataURI": "https://<PUBLIC_APP_URL>/api/campaigns/metadata/<id>" }`

Errors: 400 `unknown_species`, 400 `validation_error`, 403.

### GET /api/campaigns/metadata/:id

Public. What a campaign's `metadataURI` resolves to.

**200**

```json
{
  "id": "uuid",
  "title": "...",
  "description": "...",
  "species": { "code": "SWIETENIA_MACROPHYLLA", "scientificName": "Swietenia macrophylla", "localName": "Mahoni" },
  "region": { "name": "Jakarta", "center": { "lat": -6.2, "lon": 106.816666 }, "radiusM": 5000 },
  "imageUrls": [],
  "createdAt": "..."
}
```

### GET /api/campaigns

Public. Lists campaigns from the database mirror, newest first.

| Query | Type | Notes |
|---|---|---|
| `status` | `funding`, `active`, `refunding`, `completed` | Optional |
| `species` | species code | Optional |
| `region` | string | Optional, case-insensitive substring of the region name |
| `limit` | 1 to 100 | Default 20 |
| `cursor` | string | `nextCursor` from the previous page |

**200** `{ "items": [Campaign], "nextCursor": "20" | null }`

**Campaign**

```json
{
  "address": "0x...",
  "chainId": 84532,
  "creator": "0x...",
  "status": "active",
  "title": "...",
  "description": "...",
  "species": { "code": "SWIETENIA_MACROPHYLLA", "name": "Swietenia macrophylla" },
  "region": { "name": "Jakarta", "center": { "lat": -6.2, "lon": 106.816666 }, "radiusM": 5000, "geohash": "qqguwvt" },
  "treeTarget": 8,
  "anchorSlots": 2,
  "openSlots": 6,
  "perPlanterCap": 3,
  "funding": { "target": "1000000000", "raised": "600000000", "progressBps": 6000, "deadline": "..." },
  "claimDeadline": "...",
  "commitmentUnits": 36,
  "timeUnitSeconds": 2592000,
  "split": { "incentivesBps": 7000, "seedlingsBps": 1000, "verificationBps": 500, "reserveBps": 1000, "feeBps": 500 },
  "incentivePool": "700000000",
  "perTreeIncentive": "87500000",
  "activatedAt": "...",
  "completedAt": null,
  "carbon": { "label": "pre-certification", "estimatedUnits": "12345", "estimatedTonnes": "12.345" },
  "metadataUri": "...",
  "createdAt": "..."
}
```

`carbon` is null until an operator sets an estimate. `incentivePool`, `perTreeIncentive` and `activatedAt` are null before activation.

Errors: 400 `validation_error` (bad filter or unknown parameter), 400 `invalid_cursor`.

### GET /api/campaigns/:address

Public. The campaign plus slot counts.

**200**

```json
{
  "campaign": {
    "...": "Campaign fields",
    "slots": {
      "total": 8,
      "anchor": 2,
      "open": 6,
      "openClaimed": 2,
      "anchorAssigned": 1,
      "planted": 0,
      "openAvailable": 4
    }
  }
}
```

`openAvailable` is 0 once the claim deadline has passed. Remaining open slots then roll into the anchor portion.

Errors: 400 `invalid_path`, 404.

### POST /api/campaigns/:address/claims

Role: planter, with a wallet. Supports `Idempotency-Key`.

```json
{ "count": 2 }
```

`count` is 1 to 50. The API checks against the mirror plus claims already queued:

- the campaign is `active` and its claim deadline has not passed
- `count` is at most the open slots left: `openSlots` minus slots handed out minus queued claims
- `count` is at most the caller's remaining cap: `perPlanterCap` minus open slots held minus own queued claims

It then enqueues a `claim` job with payload `{ "campaign", "planter", "count" }`. The worker sends `claimSlotsFor` from the operator wallet. The contract enforces the same rules, so two racing requests can only make the later job fail, never over-assign.

**202** `{ "job": Job, "idempotent": false }`, or **200** with `"idempotent": true` for a repeated key.

| Status | Code | When |
|---|---|---|
| 400 | `validation_error` | Bad count |
| 403 | `forbidden_role`, `wallet_missing` | |
| 404 | `not_found` | Unknown campaign |
| 409 | `campaign_not_active` | Status is not active (`details.status`) |
| 409 | `claim_window_closed` | Claim deadline passed (`details.claimDeadline`) |
| 409 | `not_enough_slots` | `details.available` |
| 409 | `planter_cap_exceeded` | `details.remaining`, `details.cap` |
| 409 | `idempotency_key_reused` | |

### POST /api/operator/campaigns/:address/anchor-assign

Role: operator. Supports `Idempotency-Key`.

```json
{ "planter": "0x...", "count": 2 }
```

Available = anchor slots not yet assigned + (after the claim deadline) open slots not yet claimed − queued anchor assignments. The per-planter cap does not apply. Enqueues an `anchor_assign` job with payload `{ "campaign", "planter", "count" }`.

**202** `{ "job": Job, "idempotent": false }`

Errors: 403, 404, 409 `campaign_not_active`, 409 `not_enough_slots`, 409 `idempotency_key_reused`.

### GET /api/jobs/:id

Visible to the user who created the job and to operators. Anyone else gets 404, so job ids do not leak.

**200**

```json
{
  "job": {
    "id": "uuid",
    "kind": "claim",
    "status": "pending",
    "txHash": null,
    "attempts": 0,
    "createdAt": "...",
    "updatedAt": "..."
  }
}
```

Job statuses: `pending` → `processing` → `sent` → `confirmed`, or `failed`. Operators also see `lastError`.

### Evidence

The full flow, prechecks and states are in [evidence-pipeline.md](evidence-pipeline.md). In short: announce the video, upload it, submit the signed payload, then poll `GET /api/evidence/:submissionId`. Scoring, policy and signing happen in the worker, so submit returns quickly.

Precheck reason codes:

| Code | Meaning |
|---|---|
| `device_unknown_or_revoked` | `deviceKey` is not a registered, active device |
| `device_not_owned` | The device belongs to another planter |
| `signature_invalid` | The signature does not verify against the device key |
| `hash_mismatch` | SHA-256 of the stored file differs from the signed `videoSha256` |
| `stale_capture`, `future_capture` | Captured more than 72 hours ago, or more than 5 minutes in the future |
| `gps_inaccurate` | `acc` above 30 m |
| `outside_region` | PLANTED: outside the campaign radius |
| `moved_tree` | Other kinds: more than 15 m from the tree's first location |
| `duplicate_video` | The video hash was used before (rejected videos included) |
| `milestone_not_open`, `milestone_already_done` | ALIVE: chain time outside the window, or the milestone is already paid or accepted. PLANTED: the slot is already planted |
| `slot_not_owned`, `tree_not_owned` | The slot or tree is not the caller's wallet |
| `challenge_missing` | An auditor challenge is active and the payload does not carry its code |
| `video_too_short`, `video_too_long` | Recorder duration outside 4 to 12 seconds |
| `campaign_not_active` | PLANTED on a campaign that is not active |
| `wrong_tree_status` | ALIVE or DEAD on a tree that is not alive, REPLANTED on a tree that is not dead |
| `replant_deadline_passed` | REPLANTED after the replant deadline |

Reasons added later in the pipeline: the policy codes from `AI_SERVICE_INTERFACE.md` (`liveness_low`, `growth_borderline`, ...), `video_unreadable` (AI returned 422), `milestone_already_done` (another submission was attested first) and `operator_rejected`.

### POST /api/evidence/upload-url

Role: planter, with a wallet.

```json
{
  "kind": "PLANTED",
  "campaign": "0x...",
  "slotId": "12",
  "milestone": 0,
  "sha256": "<lowercase hex>",
  "sizeBytes": 4194304,
  "durationSec": 7.2,
  "contentType": "video/webm"
}
```

`slotId` is required for PLANTED (milestone 0). Other kinds send `treeId` instead: ALIVE with milestone 1 to 5, DEAD and REPLANTED with milestone 0. `sizeBytes` is at most 25 MB. `durationSec` is optional. `contentType` is `video/mp4` (default), `video/webm` or `video/quicktime`.

The target prechecks (campaign status, slot or tree ownership, tree status, milestone window and history, duration, duplicate video) run before anything is created, so a doomed video is never uploaded. Then a `queued` submission is created.

**201**

```json
{
  "submissionId": "uuid",
  "uploadUrl": "https://<project>.supabase.co/storage/v1/object/upload/sign/evidence/<profile>/<submission>.webm?token=...",
  "token": "...",
  "path": "<profile>/<submission>.webm",
  "expiresInSec": 7200,
  "idempotent": false
}
```

Upload the file with `PUT uploadUrl` (or `supabase.storage.from("evidence").uploadToSignedUrl(path, token, file)`). Asking again with the same SHA-256 and target while the submission is still `queued` returns the same submission with a fresh URL (**200**, `"idempotent": true`).

| Status | Code | When |
|---|---|---|
| 400 | `validation_error` | Bad body, wrong kind shape, file too large |
| 403 | `forbidden_role`, `wallet_missing` | |
| 404 | `not_found` | Unknown campaign, or tree not in this campaign |
| 422 | `precheck_failed` | `details.reasons` lists every failing reason |

### POST /api/evidence/:submissionId/submit

Role: planter who owns the submission.

```json
{
  "payload": { "v": 1, "kind": "PLANTED", "campaign": "0x...", "slotId": "12", "treeId": null, "milestone": 0, "videoSha256": "...", "lat": -6.2, "lon": 106.816666, "acc": 8.5, "capturedAt": "2026-10-20T03:15:00.000Z", "challenge": null, "deviceKey": "<jwk thumbprint>" },
  "canonical": "{\"v\":1,\"kind\":\"PLANTED\",...}",
  "signature": "<base64url P1363>"
}
```

Steps: check the payload matches the announced upload and `canonical == canonicalize(payload)`, download the stored file and recompute its SHA-256, verify the device and signature, run every precheck, store the payload, signature and `evidenceHash`, then enqueue a `score` job (status `checking`).

**202**

```json
{ "submissionId": "uuid", "status": "checking", "reasons": [], "policyScore": null, "jobId": "uuid", "idempotent": false }
```

**422** when prechecks fail. The submission becomes `rejected`:

```json
{ "submissionId": "uuid", "status": "rejected", "reasons": ["gps_inaccurate", "outside_region"], "policyScore": null, "jobId": null, "idempotent": false, "error": { "code": "evidence_rejected", "message": "Evidence was rejected", "details": { "reasons": ["gps_inaccurate", "outside_region"] } } }
```

Idempotent per submission: once it has left `queued`, the same request returns its current state (**200**, or **422** if rejected) with `"idempotent": true` and runs nothing again.

| Status | Code | When |
|---|---|---|
| 400 | `validation_error` | Payload fails its schema |
| 400 | `payload_mismatch` | Payload kind, campaign, slot, tree, milestone or hash differs from the upload (`details.fields`) |
| 400 | `canonical_mismatch` | `canonical` is not the canonical form of `payload` |
| 404 | `not_found` | Unknown submission, or someone else's |
| 409 | `video_not_uploaded` | Nothing stored at the upload path yet. The submission stays `queued` |
| 409 | `submission_in_progress` | A concurrent submit is running |
| 422 | `evidence_rejected` | See above |

### GET /api/evidence/:submissionId

Visible to the planter who submitted it, operators and auditors. Anyone else gets 404. Exact GPS is not included.

**200**

```json
{
  "submission": {
    "id": "uuid",
    "kind": "ALIVE",
    "campaign": "0x...",
    "slotId": null,
    "treeId": 42,
    "milestone": 1,
    "status": "attested",
    "reasons": [],
    "policyDecision": "pass",
    "policyScore": 9230,
    "scores": { "liveness": 0.93, "recapture": 0.04, "treePresence": 0.95, "...": "..." },
    "modelVersion": "treecord-ai-0.1.0",
    "evidenceHash": "0x...",
    "attestation": { "nonce": "...", "expiry": "1793000000", "digest": "0x..." },
    "txHash": null,
    "jobId": "uuid",
    "review": null,
    "capturedAt": "...",
    "receivedAt": "...",
    "updatedAt": "..."
  }
}
```

Statuses: `queued` → `uploaded` → `checking` → `scored` → `attested` → `onchain`, or `rejected`, `needs_review`, `failed`. `jobId` is the latest score or attestation job.

### POST /api/operator/submissions/:id/review

Role: operator.

```json
{ "approve": true, "note": "Seedling clearly visible, camera shake explains liveness." }
```

Only for `needs_review` submissions. Approve checks the tree status and milestone window again with chain time, signs the attestation and enqueues the `attestation` job. Reject sets `rejected` and appends `operator_rejected`. The policy's own decision and reasons are kept.

**200** `{ "submission": Submission, "idempotent": false }`. Repeating the same decision returns **200** with `"idempotent": true`.

| Status | Code | When |
|---|---|---|
| 400 | `validation_error` | Missing note |
| 403 | `forbidden_role` | |
| 404 | `not_found` | |
| 409 | `not_in_review` | The submission is not in `needs_review` (`details.status`) |
| 409 | `cannot_attest` | The tree status or milestone window no longer allows it (`details.reasons`). Reject instead |

### Donors and trees

### GET /api/donor/dashboard

Role: donor or operator, with a wallet. Covers every campaign the wallet contributed to.

**200**

```json
{
  "wallet": "0x...",
  "campaigns": [
    {
      "campaign": { "address": "0x...", "title": "...", "status": "active", "species": { "code": "...", "name": "..." }, "region": "Jakarta", "treeTarget": 10, "fundingTarget": "20000000", "raised": "20000000" },
      "contributed": "6000000",
      "refunded": "0",
      "fundingShareBps": 3000,
      "trees": { "planted": 4, "alive": 1, "flagged": 1, "dead": 1, "removed": 1, "completed": 0, "survivalRateBps": 5000 },
      "payoutsReleased": "17500000",
      "carbon": {
        "campaignEstimate": { "label": "pre-certification", "units": "67", "tonnes": "0.067" },
        "reserved": { "label": "pre-certification", "units": "20", "tonnes": "0.020", "declined": false },
        "issued": { "label": "issued", "allocatedUnits": "5", "heldUnits": "5", "heldTonnes": "0.005" }
      },
      "openFlags": [{ "id": "uuid", "treeId": 42, "status": "open", "reasonText": "...", "createdAt": "...", "openedAt": "..." }]
    }
  ],
  "totals": { "campaigns": 1, "contributed": "6000000", "treesPlanted": 4, "survivalRateBps": 5000, "payoutsReleased": "17500000", "openFlags": 1 }
}
```

Survival rate is (alive + flagged + completed) / planted, in basis points, or null before any planting. Open flags include `pending` ones (text stored, not yet sent on-chain).

### GET /api/trees/:treeId

Public. A bearer token is optional. The tree's planter, operators and auditors get the exact GPS. Everyone else gets the center of the precision-7 geohash cell (`location.precision` says which).

**200**

```json
{
  "tree": {
    "treeId": 42, "campaign": { "address": "0x...", "title": "...", "species": { "code": "...", "name": "..." }, "region": "Jakarta" },
    "slotId": 3, "planter": "0x...", "status": "alive", "plantedAt": "...",
    "location": { "precision": "geohash", "lat": -6.2004, "lon": 106.8164, "geohash": "qqguwvt" },
    "replantDeadline": null, "pausedSeconds": 0, "checkInCount": 1, "latestEvidenceHash": "0x...",
    "plantedTx": { "hash": "0x...", "url": "https://sepolia.basescan.org/tx/0x..." }
  },
  "timeline": [
    { "type": "check_in", "at": "...", "blockNumber": 1234, "tx": { "hash": "0x...", "url": "..." }, "evidenceHash": "0x...", "data": { "checkInCount": 1 },
      "evidence": { "kind": "ALIVE", "milestone": 1, "score": 9230, "thumbnailUrl": "https://.../keyframes/...?token=..." } }
  ],
  "milestones": [{ "milestone": 1, "opensAt": "...", "closesAt": "...", "amount": "1000000", "state": "open" }],
  "payouts": [{ "milestone": 0, "amount": "1000000", "planter": "0x...", "at": "...", "tx": { "hash": "0x...", "url": "..." } }],
  "forfeits": [],
  "flags": [{ "id": "uuid", "status": "dismissed", "reasonText": "...", "reasonHash": "0x...", "resolutionNote": "...", "openedAt": "...", "openedTx": "0x...", "resolvedAt": "...", "resolvedTx": "0x..." }]
}
```

Timeline types: `planted`, `check_in`, `died`, `replanted`, `removed`, `flagged`, `flag_resolved`, `completed`. Thumbnails are 15 minute signed URLs. Milestone states: `paid`, `forfeited`, `upcoming`, `open`, `missed` (window closed, forfeit not mirrored yet). Windows use chain time and include paused seconds. Transaction URLs are null on a local chain. Flags appear once they are on-chain.

Errors: 400 `invalid_path`, 401 for an invalid token (a missing token is fine), 404.

### POST /api/flags

Any role, with a wallet that contributed to the tree's campaign (the same rule `TreeRegistry.flag` enforces).

```json
{ "treeId": "42", "reasonText": "The video shows a different tree than last month" }
```

`reasonText` is 10 to 2000 characters. The text is stored as a `pending` flag and the response gives `reasonHash = keccak256(utf8(reasonText))`. The contributor then calls `TreeRegistry.flag(treeId, reasonHash)` from their own wallet. The indexer links the `TreeFlagged` event to this row by `reasonHash` and the flag becomes `open`.

**201**

```json
{
  "flag": { "id": "uuid", "treeId": 42, "status": "pending", "reasonText": "...", "reasonHash": "0x...", "createdAt": "..." },
  "reasonHash": "0x...",
  "call": { "contract": "<TreeRegistry>", "function": "flag(uint256,bytes32)", "args": ["42", "0x..."] },
  "idempotent": false
}
```

Sending the same text again returns the same pending flag (**200**, `"idempotent": true`).

| Status | Code | When |
|---|---|---|
| 400 | `validation_error` | Bad tree id or text length |
| 403 | `not_contributor` | The wallet did not contribute to this campaign |
| 403 | `wallet_missing` | |
| 404 | `not_found` | Unknown tree |
| 409 | `tree_not_flaggable` | The tree is not alive or dead (a flagged tree already has an active flag) |

### POST /api/operator/flags/:id/resolve

Role: operator.

```json
{ "uphold": false, "note": "Site visit confirmed the tree is alive and in place" }
```

For `open` (on-chain) flags. Stores the note and enqueues a `resolve_flag` job with payload `{ "treeId", "uphold", "noteHash" }`, where `noteHash = keccak256(utf8(note))`. Upholding removes the tree on-chain. Dismissing restores its status and adds the flagged time to its schedule. The flag's status changes when the indexer sees `FlagResolved`.

**202** `{ "flag": { "id", "status" }, "job": Job, "idempotent": false }`. Repeating the same decision returns the same job (**200**, `"idempotent": true`). If the earlier job failed, the same job is queued again with the new decision.

| Status | Code | When |
|---|---|---|
| 403 | `forbidden_role` | |
| 404 | `not_found` | |
| 409 | `flag_not_open` | The flag is still `pending` (not on-chain) or already resolved (`details.status`) |
| 409 | `flag_resolution_pending` | A different decision is already queued |

### GET /api/reports/campaign/:address

Public. The impact report as JSON. A PDF rendering will use the same data.

**200**

```json
{
  "report": {
    "generatedAt": "...",
    "campaign": Campaign,
    "funding": { "target": "20000000", "raised": "20000000", "contributors": 3, "refunded": "0" },
    "trees": { "planted": 10, "alive": 8, "flagged": 0, "dead": 1, "removed": 1, "completed": 0, "survivalRateBps": 8000, "averageAgeDays": 412 },
    "incentives": { "paid": "...", "forfeited": "...", "byMilestone": [{ "milestone": 0, "payouts": 10, "amount": "..." }] },
    "carbon": {
      "estimate": { "label": "pre-certification", "units": "54", "tonnes": "0.054", "method": EstimateMethod },
      "issued": { "label": "issued", "units": "2000", "tonnes": "2.000", "retiredUnits": "0", "batches": [{ "batchId": 1, "registry": "SRN-PPI", "serialStart": "...", "serialEnd": "...", "vintage": 2027, "units": "2000", "tonnes": "2.000", "tx": { "hash": "0x...", "url": "..." } }] }
    },
    "evidence": [{ "treeId": 42, "event": "planted", "evidenceHash": "0x...", "blockNumber": 1234, "at": "...", "tx": { "hash": "0x...", "url": "..." } }]
  }
}
```

`evidence` lists every on-chain event that carries an evidence hash, so anyone can check them against the chain. `method` is what `POST /api/operator/carbon/estimate` stored (see below), or null.

### Planters

### GET /api/planter/trees

Role: planter, with a wallet.

**200**

```json
{
  "chainTime": "...",
  "trees": [
    {
      "treeId": 42, "campaign": { "address": "0x...", "title": "...", "status": "active" }, "slotId": 3, "status": "alive",
      "plantedAt": "...", "location": { "precision": "exact", "lat": -6.2, "lon": 106.816666, "geohash": "qqguwvt" },
      "replantDeadline": null, "checkInCount": 0,
      "nextMilestone": { "milestone": 1, "opensAt": "...", "closesAt": "...", "amount": "1000000", "state": "upcoming" },
      "milestones": [MilestoneView]
    }
  ]
}
```

`nextMilestone` is the first milestone still `upcoming` or `open`, or null when the tree is not alive. Amounts follow `Campaign.milestoneAmount`: milestones 0 to 4 pay their share of the per-tree incentive, milestone 5 the remainder.

### GET /api/planter/challenges

Role: planter, with a wallet. Unexpired, unfulfilled challenges on the caller's trees, soonest expiry first.

**200** `{ "challenges": [{ "id": "uuid", "treeId": 42, "campaign": "0x...", "code": "K7Q2", "issuedAt": "...", "expiresAt": "..." }] }`

The next check-in for that tree must carry the code in its signed payload (`challenge`), or it is rejected with `challenge_missing`.

### Audit

All session endpoints except `reproduce` need the auditor role and only work on the caller's own sessions. Another auditor's session is a 404.

### POST /api/audit/sessions

```json
{ "campaign": "0x...", "sampleSize": 10 }
```

`sampleSize` is 1 to 100, capped at the population. The population is the campaign's trees that are not removed, sorted by id and frozen with the session. The server reads the latest block and computes:

- `seed = keccak256(utf8(sessionId) ‖ blockHash)`, with the session id as the lowercase UUID text
- Fisher-Yates over the sorted population, from the last index down: draw `i` is `keccak256(seed ‖ uint256(i)) mod (i + 1)`
- the sample is the first `sampleSize` items

The algorithm is `sampleTreeIds` in `packages/shared/src/audit.ts`, so anyone can run it.

**201** `{ "session": Session }`

```json
{
  "id": "uuid", "campaign": "0x...", "status": "open",
  "seed": { "seed": "0x...", "blockNumber": 4242, "blockHash": "0x..." },
  "populationSize": 7, "sampleSize": 4,
  "samples": [{ "position": 0, "treeId": 42, "finding": null, "notes": null, "recordedAt": null, "tree": { "status": "alive", "geohash": "qqguwvt", "checkInCount": 2 } }],
  "challenges": [], "reportHash": null, "report": null, "createdAt": "...", "closedAt": null
}
```

Errors: 400 `validation_error`, 403 `forbidden_role`, 404 unknown campaign, 409 `no_trees`.

### GET /api/audit/sessions/:id

**200** `{ "session": Session }`

### GET /api/audit/sessions/:id/trees/:treeId

The full evidence bundle for a sampled tree. Every call is written to `audit_access_log` before anything is returned. Refused calls (tree not sampled, someone else's session) are not logged and return 404.

**200**

```json
{
  "sessionId": "uuid",
  "sample": { "position": 0, "treeId": 42, "finding": null, "notes": null, "recordedAt": null },
  "tree": { "treeId": 42, "location": { "precision": "exact", "...": "..." }, "...": "..." },
  "submissions": [
    {
      "id": "uuid", "kind": "PLANTED", "milestone": 0, "status": "onchain",
      "video": { "path": "...", "sha256": "...", "sizeBytes": 4194304, "durationSec": 7.2, "url": "<15 minute signed URL>" },
      "payload": EvidencePayload, "canonical": "...", "signature": "...",
      "device": { "id": "uuid", "thumbprint": "...", "revokedAt": null },
      "verification": { "checkedAt": "...", "signatureValid": true, "canonicalMatchesPayload": true, "evidenceHashMatches": true, "videoHashMatches": true, "recomputedSha256": "..." },
      "evidenceHash": "0x...", "ai": AiScoreResponse, "keyframeUrls": ["..."],
      "policy": { "decision": "pass", "score": 9230, "rejectReasons": [] },
      "review": null, "attestation": SignedAttestationRecord, "tx": { "hash": "0x...", "url": "..." }
    }
  ],
  "events": [TimelineEvent],
  "payouts": [Payout]
}
```

`verification` is recomputed on every call: the device signature over `canonical`, `canonical == canonicalize(payload)`, `evidenceHash == keccak256(canonical ‖ signature)`, and the SHA-256 of the stored video against the signed hash. A check that cannot run (no signed payload yet, video missing) is null.

### POST /api/audit/sessions/:id/challenges

```json
{ "treeId": "42" }
```

Issues a random 4-character code (A to Z, 0 to 9) for a sampled, alive tree. It expires in 2 campaign time units. The planter sees it in `GET /api/planter/challenges`.

**201** `{ "challenge": { "id": "uuid", "treeId": 42, "code": "K7Q2", "issuedAt": "...", "expiresAt": "...", "fulfilledSubmissionId": null } }`

| Status | Code | When |
|---|---|---|
| 404 | `not_found` | Tree not in the sample |
| 409 | `session_closed` | |
| 409 | `challenge_active` | The tree already has an open challenge (`details.challengeId`, `details.expiresAt`) |
| 409 | `tree_not_alive` | (`details.status`) |

### POST /api/audit/sessions/:id/findings

```json
{ "treeId": "42", "finding": "issue", "notes": "Tree not found at the recorded spot" }
```

`finding` is `ok`, `issue` or `needs_followup`. Recording again replaces the earlier finding.

**200** `{ "sample": { "position": 0, "treeId": 42, "finding": "issue", "notes": "...", "recordedAt": "..." } }`

Errors: 404 tree not in the sample, 409 `session_closed`.

### POST /api/audit/sessions/:id/close

```json
{ "summary": "One tree missing, one to revisit" }
```

Every sampled tree needs a finding. Builds the report (session, campaign, auditor, seed inputs and algorithm, population, findings, totals, challenges, summary, close time), stores `reportHash = keccak256(canonical JSON)` (keys sorted at every level, `reportHash` in `packages/shared/src/audit.ts`), and closes the session.

**200** `{ "session": Session, "idempotent": false }`. Closing a closed session returns it with `"idempotent": true`.

Errors: 409 `findings_incomplete` (`details.missing` lists tree ids).

### GET /api/audit/sessions/:id/reproduce

Public, no token needed.

**200**

```json
{
  "sessionId": "uuid", "campaign": "0x...", "blockNumber": "4242", "blockHash": "0x...", "seed": "0x...",
  "algorithm": "seed = keccak256(utf8(sessionId) ++ blockHash). ...",
  "population": ["40", "41", "42"], "sampleSize": 2, "sample": ["42", "40"],
  "check": { "seedMatches": true, "recomputedSample": ["42", "40"], "sampleMatches": true },
  "status": "closed", "reportHash": "0x..."
}
```

The block hash can be checked against any node, and the population against the `TreePlanted` events up to that block.

### Carbon

Carbon amounts are units with 3 decimals (`"1000"` = 1 tCO2e). Every amount is labeled `pre-certification` (estimates and reservations) or `issued` (registry-backed credits).

### POST /api/operator/carbon/estimate

Role: operator. Supports `Idempotency-Key`.

```json
{ "campaign": "0x..." }
```

Computes the estimate from the species table, stores it in `campaigns.estimated_amount` with its method, and enqueues an `estimate` job (`CarbonLedger.setEstimate`, which sets each contributor's pro-rata reservation).

The model (`estimateCarbon` in `packages/shared/src/carbon.ts`), in integer math rounded down:

- tree count = the campaign's tree target minus removed trees
- one campaign time unit stands for one month (30 days in production)
- each tree grows linearly to the species' mature rate over `years_to_maturity`, using its age at the middle of each month
- total kg = tree count × Σ over months m = 1..M of `kgCo2PerYearMature / 12 × min(1, (m − 0.5) / (12 × yearsToMaturity))`
- 1 kg = 1 carbon unit

Example: 8 mahogany trees (30 kg/yr at 20 years) over 36 months add 6.75 kg each, 54 units in total.

**202**

```json
{
  "estimate": {
    "label": "pre-certification", "units": "54", "tonnes": "0.054",
    "method": { "model": "linear-maturity-v1", "label": "pre-certification", "formula": "...", "kgCo2PerYearMature": "30.00", "yearsToMaturity": 20, "treeCount": 8, "commitmentMonths": 36, "averageMaturityBps": 750, "kgPerTree": "6.75", "species": { "code": "SWIETENIA_MACROPHYLLA", "name": "Swietenia macrophylla" }, "computedAt": "..." }
  },
  "job": Job,
  "idempotent": false
}
```

| Status | Code | When |
|---|---|---|
| 409 | `campaign_not_active` | The contract only accepts estimates while active |
| 409 | `estimate_locked` | A batch was already issued |
| 409 | `species_unknown` | No species, or not in the species table |

### POST /api/operator/carbon/issue

Role: operator. Send an `Idempotency-Key` so the same issuance is never mirrored twice.

```json
{ "campaign": "0x...", "registry": "SRN-PPI", "serialStart": "IDN-2027-000001", "serialEnd": "IDN-2027-012500", "vintage": 2027, "tonnes": "12.5" }
```

`tonnes` has at most 3 decimals. Enqueues an `issue` job (`CarbonLedger.issueBatch` from the operator wallet, which holds `ISSUER_ROLE`) with payload `{ "campaign", "registry", "serialStart", "serialEnd", "vintage", "amount" }`, amount in units. The ledger fills reservations pro rata and puts the rest in platform inventory.

**202** `{ "issuance": { "units": "12500", "tonnes": "12.500" }, "job": Job, "idempotent": false }`

Errors: 400 `validation_error`, 403, 404, 409 `campaign_not_issuable` (not active or completed).

### GET /api/carbon/batches

Public. Optional `?campaign=0x...`.

**200** `{ "batches": [{ "batchId": 1, "label": "issued", "campaign": { "address": "0x...", "title": "...", "species": "...", "region": "..." }, "registry": "SRN-PPI", "serialStart": "...", "serialEnd": "...", "vintage": 2027, "units": "12500", "tonnes": "12.500", "priceUsdcPerTonne": "15000000", "inventory": { "units": "9500", "tonnes": "9.500" }, "issuedTx": { "hash": "0x...", "url": "..." }, "issuedAt": "..." }] }`

`inventory` is what platform inventory (the ledger's own balance) still has for sale. `priceUsdcPerTonne` is null until set.

### GET /api/carbon/holdings

Any role, with a wallet.

**200**

```json
{
  "wallet": "0x...",
  "reservations": [{ "campaign": "0x...", "label": "pre-certification", "reservedUnits": "4000", "allocatedUnits": "3000", "unfilledUnits": "1000", "unfilledTonnes": "1.000", "declined": false, "updatedAt": "..." }],
  "balances": [{ "batchId": 1, "label": "issued", "campaign": "0x...", "registry": "SRN-PPI", "serialStart": "...", "serialEnd": "...", "vintage": 2027, "units": "3000", "tonnes": "3.000" }],
  "retirements": [{ "retirementId": 1, "batchId": 1, "units": "500", "tonnes": "0.500", "beneficiary": "...", "purpose": "...", "retiredAt": "...", "registryRetirementStatus": "pending", "tx": { "hash": "0x...", "url": "..." } }]
}
```

Planters get empty lists: they receive incentives, never carbon.

### GET /api/carbon/retirements/:id

Public certificate.

**200**

```json
{
  "certificate": {
    "retirementId": 1, "units": "500", "tonnes": "0.500", "beneficiary": "PT Hijau Lestari", "purpose": "2026 scope 3 offset",
    "retiredAt": "...", "holder": "0x...", "tx": { "hash": "0x...", "url": "..." },
    "registryRetirement": { "status": "pending", "reference": null },
    "batch": { "batchId": 1, "registry": "SRN-PPI", "serialStart": "...", "serialEnd": "...", "vintage": 2027, "units": "12500", "issuedTx": { "hash": "0x...", "url": "..." } },
    "campaign": { "address": "0x...", "title": "...", "species": { "code": "...", "name": "..." }, "region": { "name": "Jakarta", "geohash": "qqguwvt" }, "treeTarget": 10 },
    "trees": { "count": 10, "list": [{ "treeId": 42, "status": "alive", "geohash": "qqguwvt", "plantedAt": "..." }] }
  }
}
```

Trees show only the public geohash. `registryRetirement` tracks the matching retirement in the registry, which happens off-chain.

Errors: 400 `invalid_path`, 404.

## Testing

Route tests live in `apps/web/test/api` and run against the local Supabase stack (`pnpm db:start`), with Privy replaced by a test identity provider, chain time following the wall clock, and a fixed latest block for audit seeds. Without a running database they are skipped with a warning. Precheck unit tests (`apps/web/test/precheck.test.ts`) need nothing running. Sampling, report hashing and the estimate math have unit tests in `packages/shared` (`audit.test.ts`, `carbon.test.ts`). Flag hash linking is tested on both sides: the API stores `keccak256(reasonText)` (`trees-flags.test.ts`), and the indexer links `TreeFlagged` by that hash (`apps/worker/src/indexer/apply.db.test.ts`).

```sh
pnpm db:start
pnpm --filter @treecord/web test
```
