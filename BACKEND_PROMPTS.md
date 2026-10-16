# Treecord: Backend Build Prompts

Run these prompts **in order** with your coding agent. Each prompt is self-contained, ends with acceptance criteria, and assumes the previous ones are done.

**Before prompt 0:** put `PRODUCT_KNOWLEDGE.md`, `AI_SERVICE_INTERFACE.md`, and `CLAUDE.md` at the repo root (or in `docs/`, then update the paths in `CLAUDE.md`).

Suggested schedule (backend days of the 9-day plan):

| Day | Prompts |
|---|---|
| 1 | 0, 1, 2 |
| 2 | 3, 4 |
| 3 | 5, 6, 7 |
| 4 | 8 |
| 5 | 9, 10 |
| 6 | 11 |

---

## Prompt 0: Load context

```
Read PRODUCT_KNOWLEDGE.md and AI_SERVICE_INTERFACE.md fully. They are the source of truth for Treecord.

Do not write code yet. Reply with:
1. A 10-line summary of the product in your own words.
2. The list of on-chain contracts and their responsibilities.
3. The list of off-chain components (web API, worker, AI service, Supabase) and what each owns.
4. Any contradictions or ambiguities you found, with your proposed resolution.

Wait for my confirmation before continuing.
```

---

## Prompt 1: Monorepo scaffold

```
Using PRODUCT_KNOWLEDGE.md sections 6 and 10, scaffold the Treecord monorepo.

Create:
- Root: pnpm workspaces, Turborepo (turbo.json with build, dev, lint, test, typecheck pipelines), .editorconfig, .gitignore, .nvmrc (Node 20), root tsconfig.base.json (strict), ESLint + Prettier shared config, README.md stub.
- packages/contracts: Foundry project (foundry.toml with solc 0.8.24, optimizer on, via_ir off), OpenZeppelin v5 installed as a dependency, remappings, empty src/test/script folders.
- packages/shared: TypeScript package exporting from src/index.ts. Empty modules: constants.ts, eip712.ts, evidence.ts, schemas.ts, abis/ (generated later), addresses.ts.
- apps/web: Next.js App Router + TypeScript. Only a placeholder home page. Folders: app/api, lib/server, lib/shared. Add zod, viem, @privy-io/server-auth, @supabase/supabase-js.
- apps/worker: Node 20 + TypeScript service using tsx for dev, with src/index.ts that logs "worker started". Add viem, zod, @supabase/supabase-js, pino.
- apps/ai: only a README.md that points to AI_SERVICE_INTERFACE.md (teammate owns it).
- supabase/: migrations/ and seed.sql placeholders (Supabase CLI layout).
- .env.example at root listing every env var used anywhere, grouped by app, with comments. Include: BASE_SEPOLIA_RPC_URL, CHAIN_ID=84532, USDC_ADDRESS, DEPLOYER_PRIVATE_KEY, OPERATOR_PRIVATE_KEY, ATTESTER_PRIVATE_KEY, RELAYER_PRIVATE_KEY, TREASURY_ADDRESS, SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, PRIVY_APP_ID, PRIVY_APP_SECRET, AI_SERVICE_URL, AI_SERVICE_TOKEN, MOCK_AI, DEMO_TIME_UNIT_SECONDS.
- A zod env loader in apps/web/lib/server/env.ts and apps/worker/src/env.ts that fails fast on missing vars.

Acceptance:
- `pnpm install`, `pnpm build`, `pnpm typecheck`, `pnpm lint` all pass.
- `forge build` passes in packages/contracts.
```

---

## Prompt 2: Contracts part A (factory, campaign escrow, tree registry)

```
Implement the first contracts in packages/contracts/src following PRODUCT_KNOWLEDGE.md sections 2, 3, 4.

General:
- Solidity ^0.8.24, OpenZeppelin v5, custom errors, events for every state change, SafeERC20, ReentrancyGuard on token-moving functions.
- Put shared enums, structs, and errors in src/libraries/TreecordTypes.sol.
- Put default constants (bps splits, milestone schedule, caps) in src/libraries/TreecordConstants.sol, mirroring section 3.

1) TreecordRoles.sol: a shared AccessControl base or a central RoleRegistry contract that the others query. Choose one and justify it in a comment. Roles: OPERATOR_ROLE, ATTESTER_ROLE, ISSUER_ROLE. Also stores treasury address and the VerificationGateway address.

2) CampaignFactory.sol
- createCampaign(CampaignConfig cfg) returns address. Deploys a minimal proxy clone (OpenZeppelin Clones) of a Campaign implementation and initializes it.
- CampaignConfig: creator, metadataURI, speciesCode (bytes32), regionGeohash (bytes8), regionRadiusM (uint32), treeTarget (uint32), anchorBps (uint16), perPlanterCap (uint16), fundingTarget (uint256, USDC base units), fundingDeadline, claimDeadline, commitmentUnits (uint16, min 36), timeUnit (uint64 seconds), split (incentivesBps, seedlingsBps, verificationBps, reserveBps, feeBps).
- Validates: split sums to 10000, commitmentUnits >= 36, anchorBps <= 10000, deadlines in the future and claimDeadline >= fundingDeadline, treeTarget > 0, timeUnit > 0.
- Emits CampaignCreated(campaign, creator, config). Keeps an array and mapping of campaigns.

3) Campaign.sol (initializable clone)
- Status: Funding, Active, Refunding, Completed.
- contribute(uint256 amount): only while Funding and before fundingDeadline. Tracks contributions[addr] and contributor list. When total >= fundingTarget, caps the accepted amount at the target (refund the excess in the same tx or reject excess, pick one and document), sets Active, records activatedAt, and transfers seedlings + verification + fee buckets to treasury. Emits Contributed and Activated.
- markRefunding(): anyone, after fundingDeadline if not Active.
- claimRefund(): pull refund for contributors while Refunding, or for leftovers after Completed (pro rata).
- Slots: total = treeTarget. anchorSlots = treeTarget * anchorBps / 10000, openSlots = remainder. Slot ids 1..treeTarget, anchor slots first.
  - claimSlotsFor(address planter, uint16 count): OPERATOR_ROLE only (gasless planters). Only Active, before claimDeadline, open slots only, respects perPlanterCap. Emits SlotsClaimed(planter, firstSlotId, count) or one event per slot (pick the cheaper, document it).
  - assignAnchorSlots(address planter, uint16 count): OPERATOR_ROLE. Uses anchor slots, and after claimDeadline also unclaimed open slots (rolled to anchor).
  - slotOwner(slotId) view.
- Incentive accounting:
  - perTreeIncentive = incentivePool / treeTarget, computed at activation.
  - releaseMilestone(uint256 treeId, uint8 milestone, address planter): callable only by the VerificationGateway. Checks milestone not paid, within its window (see section 3: due = plantedAt + monthsDue * timeUnit, window end = due + timeUnit; milestone 0 is due at plantedAt), tree status Alive. Pays planter perTreeIncentive * shareBps / 10000. Emits MilestonePaid.
  - forfeitMilestone(treeId, milestone): anyone, after the window closed and unpaid. Moves that amount to forfeitedPool. Emits MilestoneForfeited.
  - onTreeRemoved(treeId): callable by TreeRegistry. Moves all unpaid milestone amounts of that tree to forfeitedPool.
- complete(): anyone. Allowed once every planted tree is Completed or Removed and block.timestamp >= lastPlantedAt + (commitmentUnits + 1) * timeUnit, where lastPlantedAt is tracked as the latest plantedAt in this campaign. Sets Completed and makes forfeitedPool + remaining reserve + incentives of never-planted slots refundable pro rata.
- Views for everything the backend needs: config, status, totals, slot counts, perTreeIncentive, paid flags per tree per milestone.

4) TreeRegistry.sol
- Tree struct: campaign, slotId, planter, plantedAt, geohash (bytes8), status (Alive, Flagged, Dead, Removed, Completed), statusBeforeFlag, replantDeadline, latestEvidenceHash, checkInCount.
- registerTree(campaign, slotId, planter, geohash, evidenceHash): only VerificationGateway. Requires slot owned by planter in that campaign and slot not yet planted. Mints sequential treeId. Emits TreePlanted.
- recordCheckIn(treeId, evidenceHash): only gateway. Emits CheckInRecorded.
- markDead(treeId, evidenceHash): only gateway or OPERATOR_ROLE. Sets Dead and replantDeadline = now + 2 * timeUnit. Emits TreeDied.
- markReplanted(treeId, evidenceHash): only gateway, before replantDeadline. Sets Alive. Emits TreeReplanted.
- expireDead(treeId): anyone after replantDeadline. Sets Removed, calls campaign.onTreeRemoved. Emits TreeRemoved.
- flag(treeId, bytes32 reasonHash): caller must have contributed to the tree's campaign, tree Alive or Dead, no active flag. Sets Flagged, stores statusBeforeFlag. Emits TreeFlagged(treeId, flagger, reasonHash).
- resolveFlag(treeId, bool uphold, bytes32 noteHash): OPERATOR_ROLE. Uphold → Removed (+ campaign.onTreeRemoved). Dismiss → restore previous status. Emits FlagResolved.
- markCompleted(treeId): anyone once all milestones are paid or forfeited.

Do not write VerificationGateway or CarbonLedger yet, but define their interfaces in src/interfaces/ so Campaign and TreeRegistry compile against them.

Acceptance:
- forge build passes with no warnings.
- NatSpec on every external function.
- A short docs/contracts.md describing each contract, storage layout highlights, and every event.
```

---

## Prompt 3: Contracts part B (verification gateway, carbon ledger)

```
Implement VerificationGateway.sol and CarbonLedger.sol following PRODUCT_KNOWLEDGE.md sections 3 and 8.

1) VerificationGateway.sol
- EIP-712 (OpenZeppelin EIP712) with name "Treecord", version "1".
- struct Attestation { uint8 kind; address campaign; uint256 slotId; uint256 treeId; address planter; uint8 milestone; bytes32 evidenceHash; bytes8 geohash; uint16 score; uint256 nonce; uint64 expiry; }
- Kinds: 0 PLANTED, 1 ALIVE, 2 DEAD, 3 REPLANTED.
- submit(Attestation att, bytes signature): anyone can call. Recovers signer, requires ATTESTER_ROLE, nonce unused, not expired, campaign was created by the factory.
  - PLANTED: TreeRegistry.registerTree, then Campaign.releaseMilestone(treeId, 0, planter).
  - ALIVE: requires att.planter == tree planter; TreeRegistry.recordCheckIn, then Campaign.releaseMilestone(treeId, milestone, planter).
  - DEAD: TreeRegistry.markDead.
  - REPLANTED: TreeRegistry.markReplanted.
  - Emits AttestationAccepted(nonce, kind, treeId, evidenceHash, score).
- submitBatch(Attestation[] atts, bytes[] sigs): loops, reverts whole batch on any failure (document it).
- hashAttestation(att) view for off-chain parity tests.

2) CarbonLedger.sol (ERC-1155 based, token id = batch id)
- Non-transferable between users: override _update so only these paths move balances: mint on allocation, transfer from treasury inventory on sale, burn on retire.
- setEstimate(campaign, uint256 estimatedTonnes): OPERATOR_ROLE, campaign must be Active, once (or updatable before any issuance). Creates reservations for each contributor pro rata to contribution. Emits EstimateSet and Reserved per contributor.
- declineReservation(campaign): contributor moves their reservation to platform inventory. Emits ReservationDeclined.
- issueBatch(campaign, string registry, string serialStart, string serialEnd, uint16 vintage, uint256 tonnes): ISSUER_ROLE. Creates batch id, mints to reservation holders first (pro rata, capped by each remaining reservation), remainder to treasury. Emits BatchIssued and Allocated per holder.
- setPrice(batchId, uint256 usdcPerTonne): OPERATOR_ROLE.
- buy(batchId, uint256 tonnes): buyer pays USDC to treasury, receives tonnes from treasury inventory. Emits Purchased.
- retire(batchId, uint256 tonnes, string beneficiary, string purpose): burns from caller, increments retirement id, stores Retirement struct, emits Retired(retirementId, batchId, holder, tonnes, beneficiary, purpose).
- Views: reservations per campaign per holder, remaining reserved, batch info, retirements.
- uri(): returns a metadata URI pattern; metadata itself is off-chain.

Acceptance:
- forge build passes.
- docs/contracts.md updated with both contracts, events, and the EIP-712 type string exactly as in PRODUCT_KNOWLEDGE.md section 8.
```

---

## Prompt 4: Contract tests and deployment

```
Write Foundry tests and deployment scripts for all contracts.

Tests (packages/contracts/test):
- A MockUSDC (6 decimals) for local tests.
- A TestBase that deploys everything, grants roles, creates labeled actors (admin, operator, attester, relayer, treasury, donorA, donorB, planter1, planter2, outsider), and provides helpers to sign attestations with vm.sign using the attester key.
- Cover at minimum:
  - Factory validation (bad splits, short commitment, bad deadlines).
  - Funding: partial, exact, overfunding behavior, activation transfers to treasury with exact amounts, refund path after missed deadline.
  - Slots: open claims respect cap and deadline, anchor assignment, rollover after claim deadline, no double assignment.
  - Gateway: valid PLANTED pays milestone 0, wrong signer rejected, reused nonce rejected, expired rejected, wrong planter rejected, unknown campaign rejected.
  - Milestones: early check-in rejected, in-window paid, late rejected, forfeit after window, double pay rejected. Use vm.warp with a short timeUnit.
  - Dead, replant within deadline, expire after deadline moves unpaid amounts to forfeited pool.
  - Flags: only contributors, one active flag, payouts paused while flagged, uphold removes, dismiss restores.
  - Completion and leftover refunds pro rata.
  - Carbon: estimate creates pro-rata reservations, decline moves to inventory, issuance allocation order, buy moves USDC and tonnes, user-to-user transfer reverts, retire burns and records.
- Fuzz tests: budget split math never loses or creates USDC (sum of all outflows plus contract balance equals inflows), pro-rata allocation rounding never exceeds totals.
- An invariant test: campaign USDC balance always >= unpaid incentives + reserve + forfeited pool.

Scripts (packages/contracts/script):
- Deploy.s.sol: deploys RoleRegistry (or base), TreeRegistry, Campaign implementation, CampaignFactory, VerificationGateway, CarbonLedger, wires addresses, grants OPERATOR/ATTESTER/ISSUER to addresses from env, sets treasury and USDC from env. Writes deployments/84532.json with all addresses and the deploy block number.
- CreateDemoCampaign.s.sol: creates one demo campaign with timeUnit from DEMO_TIME_UNIT_SECONDS.
- A script/export-abis.ts (run with tsx) that copies ABIs from out/ into packages/shared/src/abis/*.ts as `as const` exports and copies deployments/84532.json into packages/shared/src/addresses.ts.

Acceptance:
- forge test passes, forge coverage shows >= 90% line coverage for src/.
- Deploy works against a local anvil and against Base Sepolia.
- pnpm --filter shared build exposes typed ABIs and addresses.
```

---

## Prompt 5: Shared package

```
Complete packages/shared so the web API, worker, and later the PWA share one implementation of every protocol detail.

- constants.ts: all defaults from PRODUCT_KNOWLEDGE.md section 3 (bps splits, milestone schedule, caps, upload window 72h, GPS accuracy 30m, check-in radius 15m, replant units 2, geohash precision 7), chain id 84532.
- evidence.ts:
  - EvidencePayload type and a canonicalize(payload) function that produces the exact key order and number formatting from section 7.
  - computeEvidenceHash(canonicalBytes, signatureBytes) using viem keccak256.
  - verifyDeviceSignature(publicKeyJwk, canonicalBytes, signatureB64url) using WebCrypto (works in Node 20 and browsers).
  - jwkThumbprint(jwk) per RFC 7638.
  - encodeGeohash(lat, lon, precision) and geohashToBytes8.
  - haversineMeters(a, b).
- eip712.ts: domain builder, Attestation types, a typed signAttestation helper using a viem account, and hashAttestation for parity tests with the contract.
- schemas.ts: zod schemas for every API request body defined in prompts 7 to 10 (write them as you implement those prompts, start with evidence and campaigns now).
- policy.ts: pure function applyPolicy(aiResponse, context) returning { decision: "pass" | "reject" | "needs_review", score: number (0..10000), reasons: string[] } exactly per AI_SERVICE_INTERFACE.md.

Tests (vitest):
- canonicalize is stable and matches fixtures.
- sign with a generated P-256 key then verify passes, tampered payload fails.
- hashAttestation matches the Solidity hash (use a fixture produced by a forge test or a cast command, documented in the test).
- policy: every threshold, every borderline band, score weighting.

Acceptance: pnpm --filter shared test passes.
```

---

## Prompt 6: Supabase schema, RLS, storage

```
Create the Supabase database in supabase/migrations following PRODUCT_KNOWLEDGE.md sections 2, 4, 9.

Tables (snake_case, uuid primary keys unless noted, created_at/updated_at timestamps):
- profiles: id, privy_user_id unique, wallet_address unique (lowercase), role (donor | planter | auditor | operator), display_name, is_buyer bool, carbon_rights_agreement_hash (planters), created_at.
- devices: id, profile_id, public_key_jwk jsonb, thumbprint unique, revoked_at.
- campaigns: address (text pk, lowercase), chain_id, creator_profile_id, status, title, description, species_code, species_name, region_name, region_center_lat, region_center_lon, region_radius_m, tree_target, anchor_slots, open_slots, per_planter_cap, funding_target (numeric), funded_amount (numeric), funding_deadline, claim_deadline, commitment_units, time_unit_seconds, split jsonb, per_tree_incentive (numeric), activated_at, estimated_tonnes, metadata_uri, created_block.
- contributions: campaign_address, contributor_address, amount numeric, tx_hash, log_index, unique(tx_hash, log_index).
- slots: campaign_address, slot_id int, planter_address, kind (anchor | open), status (open | claimed | planted | anchor), claimed_at, unique(campaign_address, slot_id).
- trees: tree_id bigint pk, campaign_address, slot_id, planter_address, status, planted_at, geohash, exact_lat, exact_lon, replant_deadline, latest_evidence_hash, check_in_count.
- submissions: id, profile_id, device_id, campaign_address, slot_id, tree_id, kind, milestone, video_path, video_sha256 unique, payload jsonb, canonical text, signature text, evidence_hash, captured_at, received_at, status (queued | uploaded | checking | scored | passed | rejected | needs_review | attested | onchain | failed), reject_reasons text[], ai_response jsonb, policy_score int, attestation jsonb, attestation_nonce numeric unique, tx_hash, error text. Unique partial index on (tree_id, milestone) where status in (passed, attested, onchain).
- challenges: id, tree_id, code, issued_by_profile_id, audit_session_id, expires_at, fulfilled_submission_id.
- milestone_payouts: tree_id, milestone, planter_address, amount numeric, tx_hash, log_index, unique(tx_hash, log_index).
- flags: id, tree_id, flagger_address, reason_text, reason_hash, status (open | upheld | dismissed), resolution_note, opened_tx, resolved_tx.
- carbon_reservations: campaign_address, holder_address, reserved_tonnes numeric, declined bool.
- carbon_batches: batch_id bigint pk, campaign_address, registry, serial_start, serial_end, vintage, tonnes, price_usdc numeric, issued_tx.
- carbon_balances: batch_id, holder_address, tonnes numeric (mirror).
- retirements: retirement_id bigint pk, batch_id, holder_address, tonnes, beneficiary, purpose, tx_hash, registry_retirement_status (pending | done).
- audit_sessions: id, auditor_profile_id, campaign_address, seed text, seed_block_hash, sample_size, status (open | closed), report jsonb, report_hash, created_at, closed_at.
- audit_samples: session_id, tree_id, finding (ok | issue | needs_followup), notes.
- audit_access_log: id, session_id, auditor_profile_id, resource, accessed_at (append only).
- chain_cursor: name text pk, last_block bigint.
- relayer_jobs: id, kind (attestation | claim | anchor_assign | issue | estimate), payload jsonb, status (pending | sent | confirmed | failed), tx_hash, attempts, last_error, unique on payload->>'nonce' for attestations.

Security:
- Enable RLS on every table. The API uses the service role, so RLS mainly protects direct client access later.
- Public read policies only for non-sensitive columns via views: v_public_campaigns, v_public_trees (no exact_lat/exact_lon), v_public_payouts.
- Storage: private bucket "evidence" with path convention evidence/{profile_id}/{submission_id}.mp4 and "keyframes" bucket. No public access; API issues signed URLs.

Also:
- supabase/seed.sql with species reference rows (mahogany, durian, mangrove Rhizophora, sengon, avocado) in a species table (code, scientific_name, local_name, est_kg_co2_per_year_mature).
- Generate TypeScript types into packages/shared/src/db.types.ts with the Supabase CLI and add a script for it.

Acceptance: `supabase db reset` runs clean locally, types generate, a short docs/database.md explains each table and which component writes it (API, worker, or both).
```

---

## Prompt 7: API part A (auth, profiles, devices, campaigns, claims)

```
Implement the first API route handlers in apps/web/app/api. Use lib/server for shared logic.

Infrastructure (lib/server):
- auth.ts: verify Privy access token from Authorization header, load or create the profile, return { profile, wallet }. Helper requireRole(...roles).
- supabase.ts: service-role client (server only).
- chain.ts: viem public client for Base Sepolia, typed contract instances from packages/shared ABIs and addresses.
- errors.ts: a typed ApiError and a wrapper that turns errors into JSON { error: { code, message, details } } with proper status codes.
- jobs.ts: enqueueRelayerJob(kind, payload) inserting into relayer_jobs.
- All handlers validate input with the zod schemas from packages/shared.

Endpoints:
- POST /api/profile: create or update display name and role (donor or planter only; auditor and operator are set manually). Planters must send carbonRightsAgreementAccepted: true, store a hash of the agreement version.
- GET /api/me: profile, wallet, role.
- POST /api/devices: register a device public key JWK (planter). Store thumbprint. Max 3 active devices per planter.
- DELETE /api/devices/:id: revoke.
- POST /api/campaigns/metadata: donor uploads off-chain metadata (title, description, species, region name and center) before calling the factory; returns metadataURI (Supabase row id based URL).
- GET /api/campaigns: list with filters (status, species, region), from DB mirror.
- GET /api/campaigns/:address: detail incl. slot counts, funding progress, per-tree incentive, carbon estimate (labeled pre-certification).
- POST /api/campaigns/:address/claims: planter claims N open slots. Checks DB mirror for availability and cap, then enqueues a relayer job (kind claim) to call claimSlotsFor. Returns job id. Idempotency-Key header supported.
- POST /api/operator/campaigns/:address/anchor-assign: operator assigns anchor slots to a planter (relayer job).
- GET /api/jobs/:id: job status.

Acceptance:
- Route handler tests with vitest and a test Supabase (or mocked client) covering auth failures, role checks, validation errors, cap enforcement, idempotency.
- docs/api.md lists every endpoint with method, auth role, request, response, errors. Keep it updated in later prompts.
```

---

## Prompt 8: API part B (evidence pipeline, AI client, attestation signer)

```
Implement the evidence pipeline exactly as PRODUCT_KNOWLEDGE.md sections 3, 5, 7, 8 and AI_SERVICE_INTERFACE.md describe.

lib/server:
- ai-client.ts: real client for POST /v1/score with timeout, retries on 503 (3 times, exponential backoff), and a MockAiClient used when MOCK_AI=true. The mock returns passing scores by default, but deterministic failures for test hooks (for example if the submission payload has challenge "FAIL-LIVENESS").
- attester.ts: signs Attestation with ATTESTER_PRIVATE_KEY via packages/shared eip712 helpers. Nonce = a random uint256 stored in submissions.attestation_nonce (unique). Expiry = now + 1 hour.
- precheck.ts: pure functions, each returning a reason code on failure:
  - device_unknown_or_revoked, device_not_owned
  - signature_invalid
  - hash_mismatch (server recomputes SHA-256 of the stored video)
  - stale_capture (older than 72h) or future_capture (more than 5 min in the future)
  - gps_inaccurate (> 30m)
  - outside_region (PLANTED: outside campaign radius)
  - moved_tree (later kinds: > 15m from tree's first exact location)
  - duplicate_video (same sha256 seen before)
  - milestone_not_open (not inside the milestone window based on chain time and campaign timeUnit), milestone_already_done
  - slot_not_owned (PLANTED), tree_not_owned
  - challenge_missing (active challenge exists but payload challenge differs)
  - video_too_long or video_too_short if duration metadata is outside 4 to 12 seconds

Endpoints:
- POST /api/evidence/upload-url: planter requests a signed upload URL. Body: kind, campaign, slotId or treeId, milestone, sha256, sizeBytes (max 25 MB). Creates a submission row in status queued and returns { submissionId, uploadUrl, path }.
- POST /api/evidence/:submissionId/submit: body { payload, canonical, signature }. Steps:
  1. Load submission, ensure owner.
  2. Verify canonical == canonicalize(payload) and signature with the device key.
  3. Recompute file hash from storage and compare.
  4. Run all prechecks. On failure: status rejected with reasons, return 422 with reasons.
  5. Status checking, call AI client with a 15 min signed video URL and previous keyframes for that tree.
  6. Store ai_response, run applyPolicy. reject → rejected. needs_review → needs_review. pass → sign attestation, store it, status attested, enqueue relayer job (kind attestation).
  7. Return { status, reasons, policyScore, jobId? }.
  Make the endpoint idempotent per submissionId.
- GET /api/evidence/:submissionId: status, reasons, scores, tx hash.
- POST /api/operator/submissions/:id/review: operator approves (sign and enqueue) or rejects a needs_review submission with a note.

Long work note: if steps 5 to 6 risk exceeding the hosting time limit, move them to a relayer_jobs kind "score" processed by the worker and keep the endpoint fast. Decide based on the Vercel plan and document the choice.

Acceptance:
- Unit tests for every precheck reason.
- An integration test using MockAiClient: upload → submit → attested job enqueued with a valid attestation that verifies against hashAttestation and recovers to the attester address.
- docs/api.md updated, plus docs/evidence-pipeline.md with a sequence diagram (Mermaid).
```

---

## Prompt 9: Worker (indexer and relayer)

```
Implement apps/worker as two loops in one process (configurable to run either alone).

Indexer:
- Polls Base Sepolia logs from chain_cursor.last_block (start from deploy block in addresses) in chunks of 2000 blocks, with a confirmation depth of 2 blocks.
- Decodes events from all contracts with viem using packages/shared ABIs. Handles new campaigns dynamically (CampaignCreated adds the clone to the watched address set).
- Upserts into Supabase idempotently (unique tx_hash + log_index or natural keys): campaigns, contributions, status changes, slots, trees (merging exact lat/lon from the matching submission by evidence hash), check-ins, milestone payouts, forfeits, flags, carbon reservations, batches, balances, purchases, retirements.
- Updates submissions to onchain when AttestationAccepted with matching nonce is seen.
- Advances the cursor in the same transaction as the writes for that chunk where possible.
- Handles reorgs simply: re-scan the last 5 blocks every cycle (idempotent upserts make it safe).

Relayer:
- Picks pending relayer_jobs with SELECT ... FOR UPDATE SKIP LOCKED (use a Postgres function via Supabase RPC).
- Job kinds: attestation (VerificationGateway.submit, batch up to 10 when several are pending), claim (Campaign.claimSlotsFor with operator key), anchor_assign, estimate (CarbonLedger.setEstimate), issue (CarbonLedger.issueBatch).
- Uses separate wallets: relayer for attestations, operator for operator-role calls, issuer key = operator key in MVP.
- Manages nonces per wallet locally, simulates before sending, waits for receipt, retries up to 5 times with backoff, marks failed with last_error.
- Exposes GET /health and GET /metrics (simple JSON counters) on a small HTTP server.

Scheduled tasks inside the worker:
- Every minute: call forfeitMilestone for windows that closed unpaid, expireDead for passed replant deadlines (operator wallet, batched), and markCompleted where eligible. Keep these cheap and idempotent.

Acceptance:
- Running anvil + deploy script + worker locally: a contribution, a claim job, and an attestation job flow end to end and appear in Supabase.
- Unit tests for event decoding and job state transitions.
- Dockerfile for Railway deployment.
```

---

## Prompt 10: API part C (donor, flags, audit workspace, carbon)

```
Implement the remaining endpoints.

Donor:
- GET /api/donor/dashboard: campaigns contributed to, funding share, trees alive/dead/removed, survival rate, payouts released, reserved and issued carbon (labeled), open flags.
- GET /api/trees/:treeId: public timeline (planted, check-ins with keyframe thumbnails, payouts with tx links, flags, status changes). Exact GPS only for the planter, operators, and auditors; others get the geohash center.
- POST /api/flags: contributor submits reasonText for a tree. Server stores text and returns reasonHash (keccak256 of the text) for the donor to call TreeRegistry.flag from their wallet. Indexer links the on-chain event to this row by reasonHash.
- POST /api/operator/flags/:id/resolve: uphold or dismiss with a note; enqueue job that calls resolveFlag.
- GET /api/reports/campaign/:address: impact report JSON (later rendered as PDF): trees, survival rate, payouts, pre-certification carbon estimate with the method used (species table, tree age), evidence hash list.

Planter:
- GET /api/planter/trees: my trees with next milestone due time, window, and amount.
- GET /api/planter/challenges: open challenges for my trees.

Auditor (role auditor):
- POST /api/audit/sessions: body { campaign, sampleSize }. Server reads the latest block hash, seed = keccak256(sessionId, blockHash), deterministically samples tree ids (Fisher-Yates with a seeded PRNG), stores seed and block hash so anyone can reproduce the sample.
- GET /api/audit/sessions/:id: sample list with status.
- GET /api/audit/sessions/:id/trees/:treeId: full evidence bundle: every submission with signed video URL (15 min), canonical payload, signature, server re-verification results (signature valid, hash match recomputed now), AI response, policy decision, attestation, on-chain tx, payouts. Every call writes audit_access_log.
- POST /api/audit/sessions/:id/challenges: issue a challenge (random 4-char code, expires in 2 time units) for a sampled tree.
- POST /api/audit/sessions/:id/findings: record finding per tree.
- POST /api/audit/sessions/:id/close: build report JSON, store report_hash = keccak256(report), close session.
- GET /api/audit/sessions/:id/reproduce: returns the inputs needed to recompute the sample independently.

Carbon:
- POST /api/operator/carbon/estimate: compute estimated tonnes for a campaign from the species table (est_kg_co2_per_year_mature times tree count times a maturity curve over the commitment period), store it, enqueue setEstimate job.
- POST /api/operator/carbon/issue: mirror a registry issuance (registry, serial range, vintage, tonnes), enqueue issueBatch job.
- GET /api/carbon/batches, GET /api/carbon/holdings (my reservations and balances), GET /api/carbon/retirements/:id (certificate data with batch, serials, trees, campaign, tx).

Acceptance:
- Tests for role checks, sample reproducibility (same inputs → same sample), access logging, flag hash linking, estimate math.
- docs/api.md complete.
```

---

## Prompt 11: Demo seed, end-to-end script, deploy

```
Make the backend demo-ready.

- scripts/demo/seed.ts: on Base Sepolia (or anvil), creates demo profiles (1 corporate donor, 1 individual donor, 3 planters, 1 auditor, 1 operator), mints or funds test USDC where possible (document the Circle faucet steps where it is not), creates one demo campaign with DEMO_TIME_UNIT_SECONDS (for example 60), funds it to activation, claims slots, and uploads sample videos from scripts/demo/videos/ through the real API so every check runs.
- scripts/demo/run-lifecycle.ts: advances through milestones in real time (short timeUnit), submits ALIVE check-ins, one DEAD then REPLANTED, one flagged tree (upheld), sets the carbon estimate, mirrors one issuance batch, a buyer purchase, and a retirement. Prints a readable log with tx links to basescan sepolia.
- scripts/demo/reset.ts: clears demo rows in Supabase (not chain).
- Deployment:
  - Vercel project for apps/web with env vars, Node 20 runtime for API routes.
  - Railway services for apps/worker (Dockerfile) and a placeholder for apps/ai.
  - Supabase cloud project, migrations applied, buckets created.
  - docs/deploy.md with exact steps and an env checklist.
- README.md at the root: what Treecord is (from PRODUCT_KNOWLEDGE.md), architecture diagram (Mermaid), how to run locally (anvil + supabase start + worker + web), how to run the demo, deployed addresses, and the API overview.

Acceptance: a fresh clone can follow README to run the full demo lifecycle locally, and the deployed stack can run it on Base Sepolia.
```

---

## Working rules for the agent (paste once at the start of a session if needed)

```
- PRODUCT_KNOWLEDGE.md is the source of truth. If something is unclear, ask before inventing behavior.
- Keep money as bigint USDC base units everywhere.
- Never put exact GPS on-chain. Only the precision-7 geohash.
- The AI service only scores. The backend decides and signs.
- Every endpoint: zod validation, role check, typed errors, docs/api.md entry, tests.
- Small commits per prompt with conventional commit messages.
- Prose in docs: plain sentences, no em dashes as sentence separators.
```
