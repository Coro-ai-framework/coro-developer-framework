# ── Stage 1: build API ──────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /build

# Install dependencies first (better layer caching)
COPY package.json package-lock.json* ./
RUN npm ci

# Copy source and compile
COPY tsconfig.json ./
COPY src/ ./src/
COPY cli/ ./cli/

RUN npm run build

# ── Stage 2: build dashboard ───────────────────────────────────────────────
FROM node:20-alpine AS dashboard-builder

WORKDIR /build

COPY dashboard/package.json dashboard/package-lock.json* ./
RUN npm ci

COPY dashboard/ ./
RUN npm run build

# ── Stage 3: production ──────────────────────────────────────────────────────
FROM node:20-alpine AS production

WORKDIR /app

# Install git — required for cloning repos and pulling a5-ai updates
RUN apk add --no-cache git

# Install production dependencies only
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# Copy compiled API output
COPY --from=builder /build/dist ./dist

# Copy compiled dashboard output
COPY --from=dashboard-builder /build/dist ./dashboard/dist

# Runtime config — settings.json is mounted as a volume or secret at runtime,
# not baked into the image
ENV NODE_ENV=production

EXPOSE 3000

CMD ["node", "dist/src/index.js"]
