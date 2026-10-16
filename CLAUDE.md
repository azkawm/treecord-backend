# Treecord: Agent Instructions

Treecord: Every tree, proven. A tree-planting platform and Monitoring and Reporting layer for community carbon in Indonesia.

## Read first
1. `PRODUCT_KNOWLEDGE.md`: product, rules, state machines, locked decisions. Source of truth.
2. `AI_SERVICE_INTERFACE.md`: contract with the AI scoring service (teammate owned).
3. `BACKEND_PROMPTS.md`: the build sequence. Work one prompt at a time.

## Stack
Base Sepolia, Solidity + Foundry + OpenZeppelin v5, pnpm + Turborepo, Next.js App Router (API route handlers), Privy, viem, Supabase (Postgres + Storage), Node worker (indexer + relayer), zod, vitest.

## Non-negotiables
- Chain is the source of truth for money and status. Supabase mirrors it and stores private or large data.
- USDC amounts are bigint base units (6 decimals). No floats for money.
- Exact GPS never goes on-chain. Use the precision-7 geohash.
- The AI service only scores. The backend applies policy and signs EIP-712 attestations.
- Planters never pay gas. Operator and relayer wallets send their transactions.
- Planters receive incentives only, never carbon. Each tonne has exactly one owner.
- Credits are not transferable between users. Only issuance allocation, inventory sale, and retirement.
- Validate every input with zod, check roles on every endpoint, document every endpoint in `docs/api.md`, test every rule.

## Commands
- `pnpm install`, `pnpm build`, `pnpm test`, `pnpm typecheck`, `pnpm lint`
- `cd packages/contracts && forge build && forge test`
- `supabase start`, `supabase db reset`

## Style
- TypeScript strict, no `any`.
- Conventional commits, one prompt per commit group.
- Docs and UI copy: plain sentences, no em dashes as sentence separators.
