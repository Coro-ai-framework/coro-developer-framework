# ── Stage 1: build ──────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /build

# Install dependencies first (better layer caching)
COPY package.json package-lock.json* ./
RUN npm ci

# Copy source and compile
# cli/ is a placeholder directory until Phase 8 — kept empty with .gitkeep
COPY tsconfig.json ./
COPY src/ ./src/
COPY cli/ ./cli/

RUN npm run build

# ── Stage 2: production ──────────────────────────────────────────────────────
FROM node:20-alpine AS production

WORKDIR /app

# Install git — required for cloning repos and pulling a5-ai updates
RUN apk add --no-cache git

# Install production dependencies only
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# Copy compiled output
COPY --from=builder /build/dist ./dist

# Runtime config — settings.json is mounted as a volume or secret at runtime,
# not baked into the image
ENV NODE_ENV=production

EXPOSE 3000

CMD ["node", "dist/src/index.js"]
