# Deploying Treecord

The deployed stack runs on Base Sepolia with these parts:

| Part | Where | Config in the repo |
|---|---|---|
| Contracts | Base Sepolia (chain 84532) | `packages/contracts`, see [contracts.md](contracts.md#base-sepolia) |
| Database and storage | Supabase cloud | `supabase/migrations`, `supabase/seed.sql` |
| Web app and API | Vercel, project root `apps/web` | `apps/web/vercel.json` |
| Worker (indexer, relayer, scheduler) | Railway, Dockerfile | `apps/worker/Dockerfile`, `apps/worker/railway.json` |
| AI scoring service | Railway (placeholder until the teammate's service lands) | `apps/ai/railway.json` |

Deploy in this order: wallets, contracts, Supabase, Vercel, Railway, then run the demo. The web app and the worker read contract addresses from `packages/shared/src/addresses.ts` at build time, so commit the Base Sepolia deployment before building them.

The API runs on Node 24, not Node 20. Node 20 reached end of life in April 2026, and the repo targets Node 24 everywhere (`PRODUCT_KNOWLEDGE.md` section 15, decision 13). `apps/web/package.json` pins `engines.node` to `24.x`, which Vercel follows.

## 1. Wallets

Create one test-only wallet per role. Never reuse them on mainnet.

```sh
cast wallet new   # run once per wallet
```

| Wallet | Env var | Needs Base Sepolia ETH | Role |
|---|---|---|---|
| Deployer | `DEPLOYER_PRIVATE_KEY` | Yes, about 15M gas for the deploy | `DEFAULT_ADMIN_ROLE`. Also funds the demo donors unless `DEMO_FUNDER_PRIVATE_KEY` is set |
| Operator | `OPERATOR_PRIVATE_KEY` | Yes | `OPERATOR_ROLE`, `ISSUER_ROLE`. Sends claims, anchor assignments, flag resolutions, estimates, issuance, prices and scheduled maintenance |
| Attester | `ATTESTER_PRIVATE_KEY` | No | `ATTESTER_ROLE`. Only signs EIP-712 attestations |
| Relayer | `RELAYER_PRIVATE_KEY` | Yes | Submits attestations and pays their gas |
| Treasury | `TREASURY_ADDRESS` (address only) | No | Receives the seedling, verification and fee buckets and sale proceeds |

Get Base Sepolia ETH from one of the faucets listed in the Base docs (network faucets page). Base Sepolia gas is cheap: 0.05 ETH each for the deployer, operator and relayer is plenty for a hackathon.

## 2. Contracts on Base Sepolia

Follow [contracts.md, Base Sepolia](contracts.md#base-sepolia). In short:

```sh
pnpm --filter @treecord/contracts simulate:base-sepolia   # dry run against a fork
pnpm --filter @treecord/contracts deploy:base-sepolia     # writes deployments/84532.json
pnpm --filter @treecord/contracts export-abis             # regenerates packages/shared/src/addresses.ts
git add packages/contracts/deployments/84532.json packages/shared/src/addresses.ts
git commit -m "chore(contracts): Base Sepolia deployment"
```

Then add the addresses to the table in the root `README.md`.

## 3. Supabase cloud

1. Create a project at supabase.com. Pick the Southeast Asia (Singapore) region, next to the Vercel region `sin1`.
2. Link it and push the schema, the storage buckets and the species seed:

   ```sh
   npx supabase login
   npx supabase link --project-ref <project-ref>
   npx supabase db push --include-seed
   ```

3. Check in the dashboard: Storage has the private buckets `evidence` and `keyframes`, and Table Editor shows five rows in `species`.
4. Copy from Project Settings > API: the project URL (`SUPABASE_URL`), the `anon` key (`SUPABASE_ANON_KEY`) and the `service_role` key (`SUPABASE_SERVICE_ROLE_KEY`). The service role key bypasses row level security. It belongs only in Vercel, Railway and your local `.env`.

Later migrations ship the same way: `npx supabase db push`.

## 4. Vercel (web app and API)

1. New Project, import the GitHub repo.
2. Root Directory: `apps/web`. Vercel detects Next.js and pnpm. Keep "Include files outside the root directory in the Build Step" on, because the build compiles `packages/shared` and `packages/pipeline`.
3. `apps/web/vercel.json` sets the install command, the build command (`turbo run build --filter=@treecord/web` from the repo root) and the `sin1` region.
4. Project Settings > Build and Deployment: Node.js version 24.x (it follows `engines` too).
5. Add the env vars from the checklist below (Production and Preview).
6. Deploy. Then set `PUBLIC_APP_URL` to the production URL (for example `https://treecord.vercel.app`) and redeploy, because campaign metadata URIs point there.

The server validates its env at boot (`apps/web/instrumentation.ts`), so a missing variable shows up in the function logs right away.

## 5. Railway (worker)

1. New Project > Deploy from GitHub repo, pick this repo.
2. Service settings:
   - Root Directory: leave empty (the repo root). The Dockerfile needs the whole workspace.
   - Config file path: `apps/worker/railway.json`. It selects the Dockerfile, the `/health` check, restarts on failure and one replica.
3. Add the env vars from the checklist. Railway sets `PORT`.
4. Deploy and open the logs. You should see the indexer catching up from the deploy block. `GET https://<worker-domain>/health` answers once a public domain is generated (Settings > Networking).

Keep one replica. Each worker process manages its own transaction nonces for the operator and relayer wallets. To scale, run a second service with `WORKER_MODE=indexer` and keep exactly one `relayer` (or `all`) process.

## 6. Railway (AI service placeholder)

The AI service is a separate Python app owned by a teammate (`apps/ai/README.md`, `AI_SERVICE_INTERFACE.md`). Until its code is in `apps/ai`, keep the worker on `MOCK_AI=true` and skip this step. When it lands:

1. Add a second service from the same repo with Root Directory `apps/ai` and config file path `apps/ai/railway.json` (a Python build, `uvicorn main:app`, health check on `/v1/health`). Adjust the start command if the teammate's entry point differs.
2. Set `AI_SERVICE_TOKEN` on the AI service and on the worker. On the worker also set `AI_SERVICE_URL` (the AI service's private or public URL) and `MOCK_AI=false`.

## 7. Run the demo on Base Sepolia

The demo scripts run on your machine against the deployed stack. They call the deployed API, read the cloud database with the service role key, and send donor transactions with the demo wallets.

1. On Vercel set `DEMO_WALLET_AUTH=true` and redeploy. This lets the scripts sign in with wallet signatures. Turn it off again when real users arrive (see Security below).
2. In your local `.env`: `CHAIN_ID=84532`, `BASE_SEPOLIA_RPC_URL`, `DEPLOYER_PRIVATE_KEY` (or `DEMO_FUNDER_PRIVATE_KEY`), the cloud `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`, and `DEMO_API_URL=https://<your-vercel-domain>`. Keep `DEMO_TIME_UNIT_SECONDS=180`: one 180 second window leaves room for scoring and relaying on a public chain.
3. Fund the funder wallet with test USDC: open https://faucet.circle.com, pick USDC on Base Sepolia, and request tokens for the funder address. The demo needs about 6 USDC (5 for the campaign, 1 for the carbon purchase). The seed tells you if the balance is short.
4. Run:

   ```sh
   pnpm demo:seed                 # wallets, profiles, campaign, funding, claims, 4 planted trees (about 5 minutes)
   pnpm demo:lifecycle --until 2  # first two milestones, replant, flag, carbon and audit (about 25 minutes)
   pnpm demo:lifecycle            # continue to milestone 5 (36 time units after planting, about 2 hours in all)
   ```

   Every step prints Basescan links. Both scripts can be stopped and run again: finished steps are skipped.
5. When you want a clean slate: `pnpm demo:reset` removes the demo rows from Supabase (the chain keeps its history), then seed again.

With no `DEMO_MNEMONIC`, the seed generates the demo wallets' phrase and keeps it in `scripts/demo/.state/84532.json` (git ignored). Keep that file to reuse the wallets and their leftover test funds.

## Env checklist

W = Vercel (web and API), R = Railway worker, D = local demo scripts, C = contract deploy scripts.

| Variable | W | R | D | C | Notes |
|---|---|---|---|---|---|
| `CHAIN_ID` | ✓ | ✓ | ✓ | | `84532` |
| `BASE_SEPOLIA_RPC_URL` | ✓ | ✓ | ✓ | ✓ | A dedicated RPC (Alchemy, Infura, QuickNode) for the worker. `https://sepolia.base.org` is rate limited |
| `USDC_ADDRESS` | ✓ | | | ✓ | Circle test USDC, `0x036CbD53842c5426634e7929541eC2318f3dCF7e` |
| `TREASURY_ADDRESS` | | | | ✓ | |
| `DEPLOYER_PRIVATE_KEY` | | | ✓ | ✓ | Demo funder unless `DEMO_FUNDER_PRIVATE_KEY` is set |
| `OPERATOR_PRIVATE_KEY` | | ✓ | | ✓ | Deploy scripts read its address for the role grants |
| `ATTESTER_PRIVATE_KEY` | ✓ | ✓ | | ✓ | The API signs operator approvals, the worker signs scored submissions |
| `RELAYER_PRIVATE_KEY` | | ✓ | | | |
| `SUPABASE_URL` | ✓ | ✓ | ✓ | | |
| `SUPABASE_SERVICE_ROLE_KEY` | ✓ | ✓ | ✓ | | Server only |
| `SUPABASE_ANON_KEY` | | | | | Reserved for direct client access in the PWA later |
| `PUBLIC_APP_URL` | ✓ | | ✓ | | The Vercel production URL. Demo scripts fall back to it when `DEMO_API_URL` is empty |
| `PRIVY_APP_ID`, `PRIVY_APP_SECRET` | ✓ | | | | Required unless `DEMO_WALLET_AUTH=true` |
| `DEMO_WALLET_AUTH` | ✓ | | | | `true` only while running the demo scripts |
| `MOCK_AI` | | ✓ | | | `true` until the AI service is deployed |
| `AI_SERVICE_URL`, `AI_SERVICE_TOKEN` | | ✓ | | | Required when `MOCK_AI=false`. The token is also set on the AI service |
| `LOG_LEVEL` | | ✓ | | | `info` |
| `WORKER_MODE` | | ✓ | | | `all` (default), `indexer` or `relayer` |
| `PORT` | | ✓ | | | Set by Railway |
| `INDEXER_*`, `RELAYER_POLL_MS`, `SCHEDULER_INTERVAL_MS` | | ✓ | | | Optional tuning, see [worker.md](worker.md#configuration) |
| `DEMO_API_URL`, `DEMO_TIME_UNIT_SECONDS`, `DEMO_FUNDING_TARGET`, `DEMO_FUNDER_PRIVATE_KEY`, `DEMO_MNEMONIC`, `DEMO_DONOR_ETH`, `DEMO_WAIT_SECONDS` | | | ✓ | | See `.env.example` |

## Smoke test after a deploy

```sh
curl https://<vercel-domain>/api/campaigns               # 200 with a list
curl https://<worker-domain>/health                      # {"ok":true,...} with every loop healthy
curl https://<worker-domain>/metrics                     # indexer lag, job counts
```

Then `pnpm demo:seed` exercises every part: API, database, storage uploads, worker scoring, relaying and indexing.

## Security

- `SUPABASE_SERVICE_ROLE_KEY` and every private key stay server side. None of them is ever a `NEXT_PUBLIC_` variable.
- `DEMO_WALLET_AUTH=true` lets anyone sign in with any wallet they control. That is harmless on a demo deployment, but it skips Privy. Turn it off for real users.
- Each backend wallet holds only what its job needs. The attester never holds ETH, and the operator and relayer only need gas money.
- Rotating a key means granting the role to the new address with the deployer (`TreecordRoles.grantRole`) and revoking the old one.
