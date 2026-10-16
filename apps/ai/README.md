# Treecord AI scoring service

Owned by a teammate. Python FastAPI service that scores evidence videos.

The contract between this service and the backend is defined in [`AI_SERVICE_INTERFACE.md`](../../AI_SERVICE_INTERFACE.md) at the repo root. Read that first.

Key points:

- `POST /v1/score` returns scores only. The service never signs attestations, never writes to chain, and never decides pass or fail. The backend applies the policy.
- `GET /v1/health` returns `{ "ok": true, "modelVersion": "..." }`.
- Auth is a shared bearer token (`AI_SERVICE_TOKEN`).
- Until this service is deployed, the backend runs with `MOCK_AI=true`.

This folder is not part of the pnpm workspace. It deploys to Railway as its own service.
