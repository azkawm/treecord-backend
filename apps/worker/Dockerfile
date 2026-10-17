# Treecord worker (indexer, relayer, scheduled maintenance).
# Build from the repo root so the workspace packages are in the context:
#   docker build -f apps/worker/Dockerfile -t treecord-worker .
# Railway: keep the service root at the repo root and set the Dockerfile path to apps/worker/Dockerfile.

FROM node:24-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV CI=true
RUN corepack enable
WORKDIR /repo

# Compile the worker and the workspace packages it uses (shared, pipeline).
FROM base AS build
COPY . .
RUN pnpm install --frozen-lockfile --filter "@treecord/worker..."
RUN pnpm --filter "@treecord/worker..." build

# Production dependencies only, installed from the manifests alone so no dev tooling ends up in the image.
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY packages/contracts/package.json packages/contracts/
COPY packages/pipeline/package.json packages/pipeline/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile --prod --filter "@treecord/worker..."

FROM node:24-slim
ENV NODE_ENV=production
WORKDIR /repo
COPY --from=deps --chown=node:node /repo ./
COPY --from=build --chown=node:node /repo/packages/shared/dist ./packages/shared/dist
COPY --from=build --chown=node:node /repo/packages/pipeline/dist ./packages/pipeline/dist
COPY --from=build --chown=node:node /repo/apps/worker/dist ./apps/worker/dist
WORKDIR /repo/apps/worker
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
