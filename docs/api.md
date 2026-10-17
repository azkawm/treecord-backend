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

## Testing

Route tests live in `apps/web/test/api` and run against the local Supabase stack (`pnpm db:start`), with Privy replaced by a test identity provider and chain time following the wall clock. Without a running database they are skipped with a warning. Precheck unit tests (`apps/web/test/precheck.test.ts`) need nothing running.

```sh
pnpm db:start
pnpm --filter @treecord/web test
```
