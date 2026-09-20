# ---------------------------------------------------------------------------
# RememberMe — production-oriented image
# Build: docker build -t rememberme .
# Run:   docker compose up -d  (recommended; runs migrations first)
# ---------------------------------------------------------------------------

# ---- build stage ----------------------------------------------------------
FROM oven/bun:1-slim AS builder
WORKDIR /app

# Install dependencies first for better layer caching. Workspace members
# must be on disk for bun to resolve workspace deps (@rememberme/core);
# the Android workspace is not needed for the server image.
COPY package.json bun.lock* ./
COPY packages ./packages
RUN bun install --frozen-lockfile

# Build the Astro + Hono application.
COPY . .
RUN bun run build

# Prune dev dependencies for the runtime image.
RUN bun install --production --frozen-lockfile

# ---- runtime stage --------------------------------------------------------
FROM oven/bun:1-slim AS runtime
WORKDIR /app

# CA certificates for SMTP (STARTTLS/TLS) out of the box.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4321

# Everything the server needs: built output, production node_modules,
# drizzle migrations, and the migrate script.
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/drizzle ./drizzle
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/scripts ./scripts

# Non-root user. The ./data volume must be writable by uid 1000
# (chown -R 1000:1000 data on the host if using a bind mount).
RUN mkdir -p /app/data && chown -R 1000:1000 /app
USER 1000:1000

# No secrets are baked into the image; all configuration comes from the
# environment at runtime (see docker-compose.yml).
EXPOSE 4321
CMD ["bun", "run", "./dist/server/entry.mjs"]
