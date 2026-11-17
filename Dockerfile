# OAuth for MCP card game: one container = Rust server + static Next.js front end.

# 1. Front end (static export). API is same-origin in production, so no API base.
FROM oven/bun:1 AS web
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY app ./app
COPY src ./src
COPY next.config.ts tsconfig.json ./
# e.g. /mcp-oauth to serve the site under that prefix (jdetle.com/mcp-oauth)
ARG BASE_PATH=
# telemetry (public IDs; see deploy/telemetry.sh). Unset = off.
ARG RELEASE=dev
ARG S10_INGEST_KEY=
ARG NEXT_PUBLIC_SENTRY_DSN= NEXT_PUBLIC_POSTHOG_KEY= NEXT_PUBLIC_POSTHOG_HOST= NEXT_PUBLIC_GA4_ID= NEXT_PUBLIC_CLARITY_ID= NEXT_PUBLIC_META_PIXEL_ID= NEXT_PUBLIC_PLAUSIBLE_SCRIPT_ID=
RUN NEXT_PUBLIC_S10=$([ -n "$S10_INGEST_KEY" ] && echo 1 || echo 0) NEXT_PUBLIC_RELEASE=$RELEASE \
    NEXT_PUBLIC_API_BASE= NEXT_PUBLIC_BASE_PATH=$BASE_PATH bunx next build

# 2. Server
FROM rust:1-bookworm AS server
WORKDIR /src
COPY server/Cargo.toml server/Cargo.lock ./
# cache dependencies
RUN mkdir src && echo 'fn main() {}' > src/main.rs && cargo build --release && rm -rf src
COPY server/src ./src
RUN touch src/main.rs && cargo build --release

# 3. Runtime
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl && rm -rf /var/lib/apt/lists/* \
  && useradd --system --uid 10001 app
WORKDIR /app
COPY --from=server /src/target/release/oauth-mcp-server /app/oauth-mcp-server
COPY --from=web /app/out /app/out
COPY games /app/games
ARG BASE_PATH=
ARG RELEASE=dev
ARG S10_INGEST_KEY=
ARG S10_INGEST_URL=
ARG NEXT_PUBLIC_SENTRY_DSN=
ENV PORT=8080 STATIC_DIR=/app/out GAMES_DIR=/app/games BASE_PATH=$BASE_PATH \
    RELEASE=$RELEASE S10_INGEST_KEY=$S10_INGEST_KEY S10_INGEST_URL=$S10_INGEST_URL SENTRY_DSN=$NEXT_PUBLIC_SENTRY_DSN
EXPOSE 8080
USER app
HEALTHCHECK --interval=30s --timeout=3s CMD curl -fsS http://localhost:8080/api/health || exit 1
CMD ["/app/oauth-mcp-server"]
