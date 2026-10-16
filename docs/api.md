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

## Testing

Route tests live in `apps/web/test/api` and run against the local Supabase stack (`pnpm db:start`), with Privy replaced by a test identity provider. Without a running database they are skipped with a warning.

```sh
pnpm db:start
pnpm --filter @treecord/web test
```
