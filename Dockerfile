FROM node:22-bookworm-slim AS frontend-builder
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

FROM rust:1-bookworm AS builder
WORKDIR /app
COPY Cargo.toml Cargo.lock ./
COPY migrations ./migrations
COPY src ./src
RUN cargo build --release --locked --bins

FROM debian:bookworm-slim AS media-thumbnailer-builder
RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential pkg-config libvips-dev=8.14.1-3+deb12u3 \
    && rm -rf /var/lib/apt/lists/*
COPY tools/media-thumbnail.c /tmp/media-thumbnail.c
RUN cc -O2 -fPIE -pie -fstack-protector-strong -D_FORTIFY_SOURCE=2 \
    -Wformat -Werror=format-security \
    /tmp/media-thumbnail.c $(pkg-config --cflags --libs vips) \
    -o /usr/local/bin/my-drive-vips-thumbnailer

FROM debian:bookworm-slim AS runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 --home-dir /nonexistent --shell /usr/sbin/nologin mydrive
COPY --from=builder /app/target/release/my-drive /usr/local/bin/my-drive
COPY --from=frontend-builder /app/frontend/dist /app/frontend/dist
WORKDIR /app
USER 10001:10001
EXPOSE 3000
ENTRYPOINT ["/usr/local/bin/my-drive"]

FROM debian:bookworm-slim AS media-indexer-runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates libvips42=8.14.1-3+deb12u3 webp=1.2.4-0.2+deb12u1 \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 --home-dir /nonexistent --shell /usr/sbin/nologin mydrive
COPY --from=builder /app/target/release/my-drive-media-indexer /usr/local/bin/my-drive-media-indexer
COPY --from=media-thumbnailer-builder /usr/local/bin/my-drive-vips-thumbnailer /usr/local/bin/my-drive-vips-thumbnailer
WORKDIR /app
USER 10001:10001
ENTRYPOINT ["/usr/local/bin/my-drive-media-indexer"]

FROM postgres:17-alpine AS media-indexer-db-setup
COPY docker/setup-indexer-role.sh /scripts/setup-indexer-role.sh
ENTRYPOINT ["/bin/sh", "/scripts/setup-indexer-role.sh"]
