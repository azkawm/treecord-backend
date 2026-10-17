# Treecord: Product Knowledge

> Read this file fully before writing any code. It is the single source of truth for what Treecord is, how it behaves, and which technical decisions are already locked. If a prompt conflicts with this file, this file wins unless the prompt explicitly says it overrides it.

---

## 1. What Treecord is

**Name:** Treecord
**Tagline:** Every tree, proven.
**One sentence:** We pay communities to keep forests alive and make every tree provable, so donors trust their impact, verifiers trust the data, and companies trust their carbon.

Treecord is a sustainable tree-planting platform and a shared system layer for community carbon in Indonesia. It has three layers:

1. **Tree campaigns:** donors fund campaigns, local planters plant and care for trees, and planters are paid for survival, not just planting.
2. **Digital Monitoring and Reporting (M and R):** every tree produces tamper-proof evidence (signed video, GPS, timestamps, AI checks, on-chain records) that can support carbon credit certification.
3. **Audit workspace:** accredited verifiers (LVVs in Indonesia, VVBs for Verra) inspect the evidence remotely. They license the tool; they never buy project data and never share project revenue (independence).

Treecord is the **M and R layer**. Verification (the V) is always done by independent accredited bodies. Credits are issued by registries (SRN PPI or Verra). Treecord mirrors registry serials on-chain for traceability.

---

## 2. Actors

| Actor | Off-chain role (DB) | What they do |
|---|---|---|
| Donor (individual or corporate) | `donor` | Creates or funds campaigns, watches trees, flags questionable submissions, receives impact reports, holds or retires carbon credits |
| Planter | `planter` | Claims tree slots, plants seedlings, submits signed videos, earns incentives |
| Auditor (LVV) | `auditor` | Opens audit sessions, samples trees, inspects evidence trails, records findings. Granted manually |
| Operator (Treecord staff) | `operator` | Assigns anchor slots, resolves flags, sets carbon estimates, mirrors registry issuance |
| Credit buyer | `donor` (buyer flag) | Buys issued credits, retires them |
| Local partner | not built in MVP | Pitch and roadmap only: onboarding, seedling distribution, random field audits |
| AI service | service account | Scores evidence. Owned by a teammate. Stateless scorer, does not sign attestations |

### On-chain roles (OpenZeppelin AccessControl)

| Role | Holder | Powers |
|---|---|---|
| `DEFAULT_ADMIN_ROLE` | Deployer multisig or EOA | Grants roles, sets treasury |
| `OPERATOR_ROLE` | Backend operator wallet | Assign anchor slots, claim slots on behalf of planters, resolve flags, set carbon estimates |
| `ATTESTER_ROLE` | Backend attestation signer key | Its EIP-712 signatures are the only way to register trees and release incentives |
| `ISSUER_ROLE` | Backend operator wallet | Mirrors registry credit issuance (batches with serials) |
| `RELAYER` (not a role) | Backend relayer wallet | Submits signed attestations and pays gas. Anyone may submit a valid attestation |

---

## 3. Core business rules (MVP defaults)

All defaults live in one constants module so they can be tuned.

### Campaign
- Created by a donor with: species, region (name + center lat/lon + radius in meters), tree target, anchor split, per-planter cap, funding deadline, claim deadline, commitment period, time unit.
- **Commitment period:** minimum 36 months.
- **Anchor split:** default 25 percent of slots are platform-managed (anchor), 75 percent are open to public planters.
- **Per-planter cap:** default 50 trees per planter per campaign.
- **Funding:** campaign has a funding target in USDC. Status `Funding` until the target is reached, then `Active`. If the funding deadline passes without reaching the target, contributors can pull refunds.
- **Contributions:** any donor can contribute while `Funding`. Each contribution is tracked per address for refunds, flagging rights, and carbon reservations.
- **Unclaimed open slots** after the claim deadline roll into the anchor portion and can be assigned by an operator. Donors always get their full tree count.

### Budget split (basis points, must sum to 10000)
| Bucket | Default bps | Goes to |
|---|---|---|
| Planter incentives | 7000 | Paid per tree on milestones |
| Seedlings and planting | 1000 | Treasury (operations wallet for seedlings) on activation |
| Verification | 500 | Treasury on activation (funds verification costs) |
| Replacement reserve | 1000 | Stays in campaign, used for replanting dead trees |
| Platform fee | 500 | Treasury on activation |

### Incentive milestones (per tree)
Per-tree incentive = incentive pool / tree target.

| Index | Due at (months after planting) | Share of per-tree incentive (bps) | Meaning |
|---|---|---|---|
| 0 | 0 | 1000 | Planting verified |
| 1 | 3 | 1000 | Survival check |
| 2 | 6 | 1000 | Survival check |
| 3 | 12 | 1500 | Survival check |
| 4 | 24 | 1500 | Survival check |
| 5 | 36 | 4000 | Completion bonus |

- A milestone check-in is accepted from its due time until **one time unit** after it (the window). Milestone 0 is due immediately on planting.
- A missed window forfeits that milestone's payout back to the campaign pool.
- Each milestone is paid at most once per tree.

### Tree health
- **Dead:** a `DEAD` attestation (or operator decision) sets the tree to `Dead` with a replant deadline of **2 time units** (about 60 days).
- **Replanted:** a `REPLANTED` attestation before the deadline sets the tree back to `Alive`. The milestone schedule continues from the original planting time. Seedling cost comes from the replacement reserve (off-chain accounting in MVP).
- **Removed:** after the replant deadline, or when a flag is upheld, the tree becomes `Removed`. All its unpaid incentives return to the campaign pool.

### Flags
- Only addresses that contributed to the campaign can flag a tree in that campaign.
- One active flag per tree at a time. Flagged trees have payouts paused.
- An operator resolves: **uphold** → tree `Removed`; **dismiss** → tree returns to its previous status.
- Flag reason text is stored off-chain; its hash is stored on-chain.

### Campaign completion
- After the commitment period ends and the last milestone window closes, the campaign can be `Completed`.
- Leftover incentive pool (forfeits, removed trees) and unused replacement reserve are refundable to contributors pro rata (pull pattern).

### Evidence capture
- Video only, recorded through the in-app camera, 5 to 10 seconds. Gallery uploads are rejected.
- The PWA generates a device keypair with WebCrypto (ECDSA P-256, non-extractable, stored in IndexedDB) and registers the public key with the backend.
- The device signs a canonical payload (see section 7) including the video SHA-256, GPS, accuracy, capture time, slot or tree id, submission kind, and challenge code if any.
- Videos can be recorded offline and queued. The capture time and GPS are locked in the signature, so delayed upload does not weaken the proof.
- **Upload window:** submissions must arrive within 72 hours of capture.
- **GPS accuracy:** must be 30 meters or better.
- **Location rules:** planting must be inside the campaign region radius. Later check-ins must be within 15 meters of the tree's first recorded location.

### Carbon credits
- Planters do **not** receive carbon. They receive activity incentives only. Carbon rights are assigned to the platform at registration (planter agreement, its hash recorded off-chain).
- Carbon goes to exactly one owner: the donor who funded it (reservation) or the buyer who buys it from the platform.
- **Reservation:** when a campaign becomes `Active`, the operator sets an estimated tonnage for the campaign (pre-certification estimate). Each contributor gets a reserved claim pro rata to their contribution. A donor may decline their reservation, which moves it to platform inventory.
- **Issuance (mirror):** when a registry issues credits off-chain, the issuer mirrors it on-chain as a batch with registry name, serial range, vintage, and tonnes. Issued tonnes go to reservation holders first (pro rata, up to their reserved amount), the rest to platform inventory.
- **Sale:** buyers purchase from platform inventory at an operator-set USDC price per tonne.
- **Retirement:** a holder retires credits with a beneficiary name and purpose. Credits are burned and a retirement record is emitted. Off-chain, the same retirement must happen in the registry (out of scope in MVP, shown as a status).
- **No secondary market:** credits are not freely transferable between users (avoids financial instrument concerns). Only platform inventory transfers and retirement exist.
- Carbon estimates shown before issuance are always labeled **pre-certification**.

### Demo time scaling
Every campaign stores `timeUnit` in seconds. Production uses 30 days. Demo campaigns use a short unit (for example 60 seconds) so the full 36-month lifecycle can be shown live. All month-based rules multiply by `timeUnit`.

---

## 4. State machines

**Campaign:** `Funding → Active → Completed`, or `Funding → Refunding` (deadline missed).

**Slot:** `Open → Claimed → Planted`. Open slots past the claim deadline → `Anchor` (assignable by operator).

**Tree:** `Alive ⇄ Flagged`, `Alive → Dead → Alive` (replanted), `Dead → Removed` (deadline passed), `Flagged → Removed` (upheld), `Alive → Completed` (all milestones done).

**Submission (off-chain):** `queued → uploaded → checking → scored → passed | rejected → attested → onchain | failed`.

**Carbon:** `estimated → reserved → issued → (sold) → retired`.

---

## 5. Main flows

### Donor
1. Sign in (Privy email, embedded wallet).
2. Create campaign or contribute to an existing one. Approve USDC, call `contribute`.
3. Campaign activates when funded. Fee, seedling, and verification buckets move to treasury.
4. Watch dashboard: slots claimed, trees planted, per-tree timeline with videos, AI scores, payouts, tx links.
5. Flag questionable trees.
6. Receive impact report (trees alive, survival rate, pre-certification carbon estimate).
7. Hold reserved carbon, then retire issued credits for a certificate.

### Planter (gasless)
1. Sign in, register device key.
2. Browse campaigns, claim slots. Backend calls `claimSlotsFor` with the operator wallet.
3. Plant, record video in app, device signs payload, upload when online.
4. Backend validates, AI scores, backend signs an EIP-712 attestation, relayer submits it on-chain.
5. Incentive for the milestone is pushed to the planter's wallet in USDC.
6. Repeat for each milestone check-in. Respond to "prove it now" challenges.

### Verification pipeline
1. Pre-checks in backend (signature, device ownership, hash match, freshness, GPS accuracy, location, duplicates by exact hash, one submission per tree per milestone, challenge code).
2. AI service scores the video (liveness, recapture, duplicate similarity, tree presence, species match, growth consistency, NDVI sample).
3. Backend applies the policy thresholds. Pass → sign attestation. Fail → reject with reasons. Borderline → `needs_review` for operator.
4. Relayer submits attestation. Indexer mirrors events to DB.

### Auditor (LVV)
1. Opens an audit session scoped to a campaign.
2. Gets a verifiable random sample of trees (seed derived from session id and a recent block hash).
3. For each sampled tree: full evidence trail, recomputed hashes, signature check result, AI scores, on-chain records, payout history.
4. May issue a "prove it now" challenge: the planter must record a new video showing a one-time code.
5. Records findings. Session report JSON is hashed and the hash stored.

### Carbon mirror
Operator records registry issuance as a batch, credits are allocated, sold, and retired as described in section 3.

---

## 6. Locked technical decisions

| Layer | Decision |
|---|---|
| Chain | Base Sepolia (chain id 84532) |
| Stablecoin | Circle test USDC on Base Sepolia, 6 decimals. Address configured via env (verify on Circle docs; commonly `0x036CbD53842c5426634e7929541eC2318f3dCF7e`) |
| Contracts | Solidity ^0.8.24, Foundry, OpenZeppelin v5. No upgradeability in MVP |
| Monorepo | pnpm workspaces + Turborepo |
| Web app and API | Next.js (App Router) + TypeScript. API lives in route handlers under `apps/web/app/api` |
| Auth | Privy (email login, embedded wallets). Server verifies Privy access tokens |
| Chain client | viem (server), wagmi + viem (client) |
| DB and storage | Supabase Postgres + Supabase Storage (private bucket for videos) |
| Worker | Node + TypeScript service in `apps/worker`: event indexer and transaction relayer |
| AI service | Python FastAPI in `apps/ai`, owned by a teammate. Contract defined in `AI_SERVICE_INTERFACE.md`. Backend ships with a mock client |
| Attestation signing | **In the backend**, not in the AI service. AI returns scores; backend applies policy and signs |
| Validation | zod for all API input and env |
| Deployment | Vercel (web + API), Railway (worker, AI), Supabase cloud, contracts on Base Sepolia |
| Planter app | PWA (part of `apps/web`). Real device attestation (Play Integrity, App Attest) is roadmap only |

---

## 7. Evidence payload (canonical)

The device signs the UTF-8 bytes of this JSON, with keys in exactly this order, no whitespace:

```json
{"v":1,"kind":"PLANTED","campaign":"0x...","slotId":"12","treeId":null,"milestone":0,"videoSha256":"<hex>","lat":-6.200000,"lon":106.816666,"acc":8.5,"capturedAt":"2026-10-20T03:15:00.000Z","challenge":null,"deviceKey":"<jwk thumbprint>"}
```

- `kind`: `PLANTED | ALIVE | DEAD | REPLANTED`
- `lat`, `lon`: 6 decimal places. `acc`: meters, 1 decimal.
- Signature: ECDSA P-256 with SHA-256, IEEE P1363 format (WebCrypto default), base64url.
- `evidenceHash` (on-chain) = `keccak256(canonicalJsonBytes ‖ signatureBytes)`.
- Public geohash on-chain uses **precision 7** (about 150 m) for privacy. Exact coordinates stay in the DB and are visible only to the planter, operators, and auditors.

## 8. EIP-712 attestation

- Domain: `name = "Treecord"`, `version = "1"`, `chainId = 84532`, `verifyingContract = VerificationGateway`.
- Type:
```
Attestation(uint8 kind,address campaign,uint256 slotId,uint256 treeId,address planter,uint8 milestone,bytes32 evidenceHash,bytes8 geohash,uint16 score,uint256 nonce,uint64 expiry)
```
- `score`: 0 to 10000 (AI confidence after policy).
- Nonces are single use. Expiry is short (for example 1 hour).

---

## 9. Data placement

| Data | On-chain | Off-chain (Supabase) |
|---|---|---|
| Campaign config, funds, status | Yes (truth) | Mirror + rich metadata (description, images, region name) |
| Slots and claims | Yes | Mirror |
| Trees, status, milestones paid | Yes | Mirror |
| Evidence hash, coarse geohash | Yes | Full payload, signature, exact GPS, video file, keyframes, AI results |
| Payouts | Yes (events) | Mirror |
| Flags | Reason hash | Reason text, resolution notes |
| Carbon reservations, batches, retirements | Yes | Mirror + certificate metadata |
| Audit sessions and findings | Report hash (optional) | Full |

Chain is the source of truth for money and status. The DB is an index plus everything too large or too private for chain.

---

## 10. Folder structure

```
treecord/
├── apps/
│   ├── web/                    # Next.js: UI (later) + API route handlers (now)
│   │   ├── app/api/            # backend endpoints
│   │   ├── lib/                # server: auth, supabase, chain, attestation, policy, ai client
│   │   └── styles/tokens.css
│   ├── worker/                 # indexer + relayer (Node, TS)
│   └── ai/                     # FastAPI scorer (teammate)
├── packages/
│   ├── contracts/              # Foundry: src, test, script
│   ├── pipeline/               # server-only evidence pipeline shared by web and worker: AI client, attester, score job
│   └── shared/                 # ABIs, addresses, EIP-712 types, canonical payload, constants, zod schemas
├── supabase/
│   ├── migrations/
│   └── seed.sql
├── docs/
└── package.json
```

---

## 11. Out of scope for MVP

Native app and hardware attestation, local partner module, real registry API integration, secondary credit market, fiat off-ramp, multi-language UI, real satellite pipeline (use precomputed NDVI samples), notifications beyond simple DB records.

---

## 12. Glossary

- **MRV:** Monitoring, Reporting, Verification. Treecord does M and R.
- **LVV:** Lembaga Validasi dan Verifikasi, Indonesian accredited verifier (KAN). Examples: Mutuagung Lestari, TÜV Rheinland Indonesia, Sucofindo.
- **VVB:** Validation/Verification Body for Verra.
- **SRN PPI:** Indonesia's national climate registry. Issues **SPE-GRK** certificates.
- **ARR:** Afforestation, Reforestation, Revegetation.
- **Buffer pool:** share of credits held back against reversal risk (fire, disease).
- **Pre-certification:** an estimate not yet verified or issued.

---

## 13. Design tokens (for UI work later)

| Token | Value |
|---|---|
| `--color-primary` | `#1F5D3A` |
| `--color-primary-soft` | `#E6F0E9` |
| `--color-earth` | `#8B5E3C` |
| `--color-bg` | `#F7F6F2` |
| `--color-surface` | `#FFFFFF` |
| `--color-text` | `#1C1F1D` |
| `--color-muted` | `#6B726E` |
| `--color-verified` | `#2E9E5B` |
| `--color-pending` | `#D9A23A` |
| `--color-flagged` | `#C8553D` |
| `--font-sans` | Plus Jakarta Sans |
| `--font-mono` | JetBrains Mono |
| `--radius-card` / `--radius-input` | 12px / 8px |
| spacing | 4px base scale |

---

## 14. Engineering conventions

- TypeScript strict mode. No `any` in committed code.
- All money in USDC base units (`bigint`, 6 decimals). Never floats for money.
- All external input validated with zod. All env validated at boot.
- Every state-changing endpoint is idempotent where possible (idempotency key or natural unique constraint).
- Contracts: checks, effects, interactions; `ReentrancyGuard` on functions that move tokens; `SafeERC20`; custom errors; events for every state change.
- Tests are required for every contract function and every policy rule.
- Prose in docs and UI copy: plain sentences, no em dashes as sentence separators.

---

## 15. Resolved decisions (confirmed after prompt 0)

These resolve ambiguities found in the sections above. Where they conflict with earlier text, this section wins.

1. **Borderline band is one-sided.** A score that passes its threshold but sits within 0.10 of it goes to `needs_review`. A score past its threshold is rejected. Example: liveness 0.70 to below 0.80 is review, below 0.70 is reject. Duplicate similarity above 0.90 is always reject.
2. **Flags freeze the clock.** While a tree is `Flagged`, `forfeitMilestone` and `expireDead` revert. When a flag is dismissed, the flagged duration is added to the tree's pause offset, which shifts every later milestone due time, every window end, and the replant deadline. When a flag is upheld, the tree is `Removed` as before.
3. **Dead trees can be flagged.** Flagging is allowed from `Alive` or `Dead`. Dismissal restores the previous status, with deadlines extended per rule 2.
4. **Milestone windows use chain time.** The contract enforces windows at the time the attestation lands. The backend rejects early with `milestone_not_open` using the same rule. The default demo time unit is 180 seconds so scoring and relaying fit inside one window.
5. **Scoring runs in the worker.** `POST /api/evidence/:id/submit` runs prechecks, enqueues a `score` relayer job, and returns immediately. The worker calls the AI service, applies policy, signs the attestation, and enqueues the `attestation` job. The client polls `GET /api/evidence/:id`.
6. **Keyframes are stored by the backend.** The AI service returns keyframes as base64 JPEGs or short-lived URLs. The backend always copies them into the Supabase `keyframes` bucket. To be confirmed with the AI teammate.
7. **Overfunding is never pulled.** `contribute` transfers only `min(amount, fundingTarget - totalRaised)` from the donor, so no excess refund is needed.
8. **Upload retries are idempotent.** Requesting an upload URL again for the same owner and the same SHA-256 while the submission is still `queued` returns the existing submission. A previously `rejected` video still counts as a duplicate.
9. **Donors pay their own gas** for `contribute` and `flag` in the MVP. The demo seed funds demo donor wallets with test ETH.
10. **Video duration tolerance.** The app enforces 5 to 10 seconds. The server accepts 4 to 12 seconds to allow for metadata jitter.
11. **Milestone schedule is fixed.** The six milestones end at month 36 regardless of `commitmentUnits`. A longer commitment only delays campaign completion.
12. **Rounding dust is tracked.** Remainders from per-tree and per-milestone division are tracked explicitly and become refundable at completion. Fuzz tests prove no USDC is created or lost.
13. **Toolchain versions.** Node 24 LTS (Node 20 reached end of life in April 2026). TypeScript 6.0 (typescript-eslint does not support 7 yet). Privy server SDK is `@privy-io/node` (`@privy-io/server-auth` is deprecated).
14. **Growth consistency applies to ALIVE only.** A dead tree is not expected to grow and a replanted seedling is a new plant. For PLANTED, DEAD and REPLANTED the attestation score uses tree presence in place of growth. A challenge that was issued but not scored is a reject.
15. **Carbon amounts use 3 decimals on-chain** (1000 units = 1 tCO2e) so pro-rata reservations keep kilogram precision. Platform carbon inventory is held by the CarbonLedger contract itself, and sale proceeds go to the treasury.
