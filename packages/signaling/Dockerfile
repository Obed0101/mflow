# Stage 1: install
# Resolves workspace:* references (packages/shared, packages/signaling) via the
# root bun workspaces manifest so node_modules is fully linked before runtime.
FROM oven/bun:1-alpine AS install

WORKDIR /app

# Copy all workspace manifests so bun.lock resolves correctly.
COPY package.json bun.lock ./
COPY packages/shared/package.json ./packages/shared/package.json
COPY packages/signaling/package.json ./packages/signaling/package.json
COPY packages/daemon/package.json ./packages/daemon/package.json
COPY packages/cli/package.json ./packages/cli/package.json

RUN bun install --frozen-lockfile --production

# Stage 2: runtime
FROM oven/bun:1-alpine

WORKDIR /app

# Bring in the resolved workspace node_modules from the install stage.
COPY --from=install /app/node_modules ./node_modules

# Copy source — ordered so shared (dependency) lands before the consumer.
COPY packages/shared/ ./packages/shared/
COPY packages/signaling/ ./packages/signaling/

EXPOSE 8787
ENV PORT=8787

USER bun

CMD ["bun", "run", "packages/signaling/src/index.ts"]
