# syntax=docker/dockerfile:1.6
#
# Coro Runner — production image (legacy monolith mode).
#
# Build context MUST be the workspace root (../..) so we can copy the pnpm
# lockfile and the dashboard package alongside the runner. Compose files in
# this directory already set the context correctly.
#
#   docker build -f packages/runner/Dockerfile -t coro-runner .

# ── Stage 1: workspace skeleton + dependency install ────────────────────────
FROM node:20-alpine AS deps

WORKDIR /workspace

RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

# Workspace-level files needed by pnpm to resolve the workspace graph
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./

# Per-package manifests (only the manifests so we can install before copying source)
COPY packages/runner/package.json packages/runner/
COPY packages/dashboard/package.json packages/dashboard/

RUN pnpm install --frozen-lockfile

# ── Stage 2: build runner ───────────────────────────────────────────────────
FROM deps AS runner-builder

COPY tsconfig.base.json ./
COPY packages/runner/tsconfig.json packages/runner/
COPY packages/runner/src/ packages/runner/src/
COPY packages/runner/cli/ packages/runner/cli/

RUN pnpm --filter @coro/runner build

# ── Stage 3: build dashboard ────────────────────────────────────────────────
FROM deps AS dashboard-builder

COPY tsconfig.base.json ./
COPY packages/dashboard/ packages/dashboard/

RUN pnpm --filter @coro/dashboard build

# ── Stage 4: production runtime ─────────────────────────────────────────────
FROM node:20-alpine AS production

WORKDIR /app

# git is required for cloning repos and pulling intelligence updates
RUN apk add --no-cache git

RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

# Reinstall production-only deps from the same lockfile, hoisted into /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc /workspace/
COPY packages/runner/package.json /workspace/packages/runner/
COPY packages/dashboard/package.json /workspace/packages/dashboard/

RUN cd /workspace && pnpm install --frozen-lockfile --prod --filter @coro/runner

# Built JS for the runner
COPY --from=runner-builder /workspace/packages/runner/dist /app/dist
# Hoisted node_modules — node will resolve dependencies from here
RUN cp -R /workspace/node_modules /app/node_modules \
 && cp -R /workspace/packages/runner/node_modules /app/dist/node_modules 2>/dev/null || true

# Built dashboard assets, served by the runner's HTTP server
COPY --from=dashboard-builder /workspace/packages/dashboard/dist /app/dashboard/dist

# Runtime config — settings.json is mounted as a volume or secret at runtime,
# not baked into the image
ENV NODE_ENV=production

EXPOSE 3000

CMD ["node", "dist/src/index.js"]
