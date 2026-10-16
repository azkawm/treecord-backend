# Treecord

Every tree, proven.

Treecord pays communities in Indonesia to plant trees and keep them alive, and makes every tree provable with signed video evidence, AI checks, and on-chain records. See `PRODUCT_KNOWLEDGE.md` for the full product and rules.

> This README is a stub. The full version (architecture, local setup, demo, deployed addresses) arrives in prompt 11 of `BACKEND_PROMPTS.md`.

## Layout

| Path | What it is |
|---|---|
| `apps/web` | Next.js app. API route handlers under `app/api`, PWA UI later |
| `apps/worker` | Node service: chain event indexer and transaction relayer |
| `apps/ai` | AI scoring service (Python, owned by a teammate) |
| `packages/contracts` | Foundry project: Solidity contracts, tests, deploy scripts |
| `packages/shared` | Shared TypeScript: ABIs, addresses, EIP-712, evidence payload, constants, zod schemas |
| `supabase` | Database migrations and seed data |

## Requirements

- Node 24 (see `.nvmrc`) and pnpm 10
- Foundry (`forge`, `anvil`, `cast`)
- Supabase CLI (from prompt 6)

## Commands

```sh
pnpm install
pnpm build
pnpm typecheck
pnpm lint
pnpm test
cd packages/contracts && forge build
```

Copy `.env.example` to `.env` and fill it in before running `apps/web` or `apps/worker`.
