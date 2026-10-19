# Treecord database

Supabase Postgres 17 plus Supabase Storage. Migrations live in `supabase/migrations`, reference data in `supabase/seed.sql`, and rule tests in `supabase/tests/database`.

The chain is the source of truth for money and status. The database is an index of chain events plus everything too large or too private for the chain (PRODUCT_KNOWLEDGE.md section 9).

## Commands

Requires Docker Desktop running. The Supabase CLI is a dev dependency of the repo.

```sh
pnpm db:start     # start the local stack (API :44321, Postgres :44322, Studio http://127.0.0.1:44323)
pnpm db:reset     # rebuild the database from migrations and seed.sql
pnpm db:test      # run the pgTAP rule tests
pnpm db:types     # regenerate packages/shared/src/db.types.ts
pnpm db:status    # print local URLs and keys for .env
pnpm db:stop
```

`pnpm db:status` prints the local `API URL`, `anon key` and `service_role key` to copy into the root `.env` as `SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY`.

Local ports use the 443xx range instead of Supabase's default 543xx. Windows (Hyper-V and WSL) reserves port ranges inside 49152 to 65535, which blocked the defaults. Ports below 49152 are never reserved. Run `netsh interface ipv4 show excludedportrange protocol=tcp` to see the current reservations.

## Conventions

- **Names:** snake_case. UUID primary keys, except where the natural key is on-chain (`campaigns.address`, `trees.tree_id`, `carbon_batches.batch_id`, `retirements.retirement_id`) or composite (`slots`, `carbon_reservations`, `carbon_balances`, `audit_samples`).
- **Addresses** use the `eth_address` domain: lowercase `0x` plus 40 hex characters. Uppercase input is rejected, so lowercase before writing.
- **Hashes** (tx hashes, keccak hashes, block hashes) use the `hex32` domain: lowercase `0x` plus 64 hex characters.
- **Money, carbon amounts and nonces** use the `uint256` domain (`numeric(78,0)`, non-negative). PostgREST returns `numeric` as a JSON number, which loses precision above 2^53. **Always read these columns with a `::text` cast** (for example `select("amount::text")` in supabase-js) and parse with `BigInt`. Write them as decimal strings. The public views already cast them to text.
- **Carbon amounts** are on-chain units with 3 decimals: 1000 = 1 tCO2e.
- **Event mirrors** carry `block_number`, `tx_hash` and `log_index` with `unique (tx_hash, log_index)`, so the indexer can upsert idempotently and re-scan blocks after a reorg.
- **Timestamps** are `timestamptz`. Tables that change have `updated_at`, maintained by the `set_updated_at` trigger.

## Security model

- **RLS is enabled on every table, with no client policies.** The API and worker use the service role, which bypasses RLS.
- **Client roles get nothing directly.** `anon` and `authenticated` have all table grants revoked and cannot execute any function.
- **Public data goes through views only:** `v_public_campaigns`, `v_public_trees` and `v_public_payouts` select safe columns and run with their owner's rights. Exact GPS and profile ids are never in them.
- **Storage buckets are private.** The API issues short-lived signed URLs.
- **New tables need RLS too.** Any table added later must enable RLS. A pgTAP test fails if any public table does not.

## Tables

Writer legend: **API** = Next.js route handlers, **Worker** = indexer and relayer in `apps/worker`, **Seed** = `seed.sql`.

### Identity

| Table | Purpose | Written by |
|---|---|---|
| `profiles` | One row per Privy user: wallet, role (`donor`, `planter`, `auditor`, `operator`), display name, buyer flag, accepted carbon rights agreement hash. Planters must have the agreement hash (check constraint). Auditor and operator roles are set manually | API |
| `devices` | Planter device public keys (P-256 JWK) and RFC 7638 thumbprints. A trigger enforces at most 3 active devices per profile. Private keys are rejected by a check constraint | API |

### Reference data

| Table | Purpose | Written by |
|---|---|---|
| `species` | Species codes (matching on-chain `speciesCode`), names, and a rough pre-certification kg CO2 per year for a mature tree plus years to maturity. Used only for the labeled pre-certification estimate | Seed |

### Campaigns

| Table | Purpose | Written by |
|---|---|---|
| `campaign_metadata` | Title, description, species, region and images uploaded before the factory call. Its id becomes the campaign `metadataURI` | API |
| `campaigns` | Mirror of each campaign's config, status and funding, merged with its metadata. `estimated_amount` holds the pre-certification carbon estimate and `estimate_method` how it was computed. `is_demo` marks campaigns created by the demo seed, the only ones `reset_demo_data` may remove | Worker (chain fields), API (estimate and method), demo seed (`is_demo`) |
| `contributions` | `Contributed` events | Worker |
| `refunds` | `Refunded` events | Worker |
| `slots` | Slot ownership and status (`open`, `claimed`, `planted`, `anchor`) from claim, anchor assignment and planting events | Worker |

### Trees and evidence

| Table | Purpose | Written by |
|---|---|---|
| `trees` | Mirror of TreeRegistry trees. `exact_lat` and `exact_lon` come from the matching planting submission (joined by evidence hash) and stay private | Worker |
| `tree_events` | Tree timeline: planted, check-in, died, replanted, removed, flagged, flag resolved, completed | Worker |
| `submissions` | Every evidence upload: video path and hash, signed payload, canonical string, signature, evidence hash, status, reject reasons, AI response, keyframe paths, policy decision and score, attestation and nonce, tx hash | API (upload, submit, review), Worker (scoring, attestation, on-chain status) |
| `challenges` | "Prove it now" codes issued by auditors for a tree, with expiry and the submission that fulfilled it | API |
| `milestone_payouts` | `MilestonePaid` events. One row per tree and milestone | Worker |
| `milestone_forfeits` | `MilestoneForfeited` events. One row per tree and milestone | Worker |
| `flags` | Flag reason text and its keccak hash. Created as `pending` by the API, linked to the on-chain `TreeFlagged` event by `reason_hash` (status `open`), then `upheld` or `dismissed` | API (text, resolution note), Worker (chain status) |

### Carbon

| Table | Purpose | Written by |
|---|---|---|
| `carbon_reservations` | Reserved and allocated amounts per campaign and holder, and whether the holder declined | Worker |
| `carbon_batches` | Mirrored registry issuances: registry, serial range, vintage, amount, price | Worker |
| `carbon_allocations` | `Allocated` events, to holders or to platform inventory (the ledger address) | Worker |
| `carbon_purchases` | `Purchased` events | Worker |
| `carbon_balances` | Current balance per batch and holder | Worker |
| `retirements` | `Retired` events, plus the off-chain registry retirement status | Worker (event), API (registry status) |

### Audit

| Table | Purpose | Written by |
|---|---|---|
| `audit_sessions` | Auditor sessions scoped to a campaign: seed, seed block number and hash (so anyone can reproduce the sample), sample size, the frozen tree population (`population_tree_ids`), report and its hash | API |
| `audit_samples` | Sampled trees in sample order, with the auditor's finding and notes | API |
| `audit_access_log` | Every evidence access by an auditor. Append only: updates, deletes and truncates are rejected by triggers | API |

### Operations

| Table | Purpose | Written by |
|---|---|---|
| `chain_cursor` | Last indexed block per indexer stream (`indexer:<chainId>`) | Worker |
| `relayer_jobs` | Queue of work for the worker: `score`, `attestation`, `claim`, `anchor_assign`, `estimate`, `issue`, `set_price`, `resolve_flag`. Tracks status, attempts, errors, tx hash and an optional idempotency key. An attestation nonce can be queued only once | API (enqueue), Worker (process) |

## Key constraints

| Rule | Where |
|---|---|
| One accepted ALIVE check-in per tree and milestone | Partial unique index on `submissions (tree_id, milestone)` where status is passed, attested or onchain. DEAD and REPLANTED are excluded because a tree can die, be replanted and die again |
| One accepted planting per slot | Partial unique index on `submissions (campaign_address, slot_id)` for PLANTED |
| A video can be submitted once | `submissions.video_sha256` unique |
| One open flag per tree | Partial unique index on `flags (tree_id)` where status is open |
| At most 3 active devices per planter | `enforce_device_limit` trigger |
| Planters accept the carbon rights agreement | Check constraint on `profiles` |
| An attestation nonce is used once | `submissions.attestation_nonce` unique, partial unique index on `relayer_jobs (payload->>'nonce')` |
| Audit access log is append only | `reject_mutation` triggers for update and truncate, `guard_audit_access_log_delete` for delete (allowed only inside `reset_demo_data` for demo campaigns) |
| Slots add up | `campaigns.anchor_slots + open_slots = tree_target` |

## Functions

`claim_relayer_jobs(kinds, limit, worker, stale_after default 5 minutes)` claims due jobs with `FOR UPDATE SKIP LOCKED`, so several workers never take the same job. It marks them `processing`, records the worker and counts the attempt. Jobs stuck in `processing` or `sent` longer than `stale_after`, for example after a crash, are claimed again. The worker then checks a stored tx hash before sending anything new (see [worker.md](worker.md#relayer)). Only the service role can execute it.

`reset_demo_data(campaigns, profile_ids)` backs `pnpm demo:reset`. It removes only campaigns with `is_demo` and only profiles created by wallet sign-in (`privy_user_id` starting with `wallet:`), together with their audits, carbon mirror, submissions and jobs, and returns counts plus the storage paths of the deleted videos and keyframes. A profile that non-demo rows still reference is kept. Inside the function the access log trigger lets deletes through for demo campaigns only, so the audit trail of every real campaign stays append only. Only the service role can execute it.

## Storage

| Bucket | Path | Limit | Types |
|---|---|---|---|
| `evidence` | `{profile_id}/{submission_id}.mp4` | 25 MB | mp4, webm, quicktime |
| `keyframes` | `{submission_id}/{index}.jpg` | 2 MB | jpeg, png, webp |

Both buckets are private. The API creates signed upload URLs for planters and 15 minute signed read URLs for the AI service and auditors.

## Types

`pnpm db:types` writes `packages/shared/src/db.types.ts` from the local database. The shared package re-exports `Database`, `Tables`, `TablesInsert`, `TablesUpdate` and `Enums` for typed supabase-js clients. Regenerate after every migration.
