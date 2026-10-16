# Treecord: AI Service Interface

This is the contract between the backend (`apps/web`) and the AI scoring service (`apps/ai`, owned by a teammate). The AI service only **scores**. It never signs attestations, never writes to chain, and never decides pass or fail. The backend applies the policy and signs.

Until the real service is ready, the backend uses a mock client that returns deterministic scores (see `MOCK_AI=true`).

---

## Base

- Protocol: HTTPS, JSON
- Auth: header `Authorization: Bearer <AI_SERVICE_TOKEN>` (shared secret)
- Timeout: backend waits up to 60 seconds

---

## `POST /v1/score`

### Request

```json
{
  "submissionId": "uuid",
  "kind": "PLANTED | ALIVE | DEAD | REPLANTED",
  "video": {
    "url": "https://<supabase signed url, valid 15 min>",
    "sha256": "hex",
    "durationHintSec": 7.2
  },
  "species": "Swietenia macrophylla",
  "location": { "lat": -6.2, "lon": 106.816666, "acc": 8.5 },
  "capturedAt": "2026-10-20T03:15:00.000Z",
  "challengeCode": "K7Q2",
  "tree": {
    "treeId": "42",
    "previousKeyframes": ["https://...jpg", "https://...jpg"],
    "plantedAt": "2026-10-20T03:15:00.000Z"
  }
}
```

- `challengeCode` is null unless an auditor issued a "prove it now" challenge.
- `tree` is null for `PLANTED` submissions.

### Response `200`

```json
{
  "submissionId": "uuid",
  "modelVersion": "treecord-ai-0.1.0",
  "scores": {
    "liveness": 0.94,
    "recapture": 0.03,
    "treePresence": 0.97,
    "speciesMatch": 0.71,
    "growthConsistency": 0.88,
    "duplicate": { "maxSimilarity": 0.12, "matchedSubmissionId": null },
    "challengeVisible": null,
    "ndvi": { "value": 0.41, "source": "sentinel2-sample", "date": "2026-10-01" }
  },
  "keyframes": ["https://...jpg"],
  "notes": ["Seedling height estimated 40 to 60 cm"]
}
```

Score meanings (all 0 to 1):

| Score | High means |
|---|---|
| `liveness` | Real 3D scene with camera motion, not a static image |
| `recapture` | Likely a video of a screen or a printed photo (bad) |
| `treePresence` | A tree or seedling is clearly the subject |
| `speciesMatch` | Matches the campaign species (advisory for seedlings) |
| `growthConsistency` | Same tree as previous keyframes, plausible growth. Null for `PLANTED` |
| `duplicate.maxSimilarity` | Similar to another submission (bad above threshold) |
| `challengeVisible` | Challenge code visible in frame. Null when no challenge |
| `ndvi.value` | Vegetation index sample at the location. Advisory |

Keyframes: the service returns a few JPEG keyframes, either as base64 data URLs (`data:image/jpeg;base64,...`) or as short-lived URLs valid for at least 15 minutes. The backend always copies them into its own Supabase `keyframes` bucket and stores those paths with the submission. Please confirm which form you will return.

Calls come from the backend worker, not from a user request, so the 60 second timeout is a hard limit rather than a user-facing wait.

### Errors

| Status | Meaning | Backend action |
|---|---|---|
| 400 | Bad input | Mark submission `failed`, log |
| 422 | Video unreadable or too short | Reject with reason `video_unreadable` |
| 503 | Busy | Retry with backoff, up to 3 times |

---

## Backend policy (owned by backend, listed here so both sides agree)

| Rule | Reject if |
|---|---|
| Liveness | `liveness < 0.70` |
| Recapture | `recapture > 0.30` |
| Tree presence | `treePresence < 0.70` |
| Duplicate | `maxSimilarity > 0.90` |
| Growth consistency (non-planting) | `growthConsistency < 0.50` |
| Challenge | challenge issued and `challengeVisible < 0.80` |

- Borderline band: a score that passes its threshold but is within 0.10 of it → `needs_review` (operator decides). A score past its threshold is always a reject. Example: liveness 0.70 to below 0.80 is review, below 0.70 is reject.
- `speciesMatch` and `ndvi` are advisory only in MVP and never reject on their own.
- Attestation `score` (0 to 10000) = weighted average: liveness 30%, treePresence 30%, (1 - recapture) 20%, growthConsistency 20% (use treePresence again for `PLANTED`).

---

## `GET /v1/health`

Returns `{ "ok": true, "modelVersion": "..." }`.
