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
COPY frontend/public/docs ./frontend/public/docs
ARG MY_DRIVE_VERSION=0.1.0
ARG MY_DRIVE_GIT_SHA=
ARG MY_DRIVE_BUILD_TIME=
ENV MY_DRIVE_VERSION=${MY_DRIVE_VERSION} \
    MY_DRIVE_GIT_SHA=${MY_DRIVE_GIT_SHA} \
    MY_DRIVE_BUILD_TIME=${MY_DRIVE_BUILD_TIME}
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

FROM debian:bookworm-slim AS face-model
ARG FACE_MODEL_BUNDLE_URL=https://github.com/deepinsight/insightface/releases/download/v0.7/buffalo_l.zip
ARG FACE_MODEL_BUNDLE_SHA256=80ffe37d8a5940d59a7384c201a2a38d4741f2f3c51eef46ebb28218a7b0ca2f
ARG FACE_DET_MODEL_SHA256=5838f7fe053675b1c7a08b633df49e7af5495cee0493c7dcf6697200b85b5b91
ARG FACE_REC_MODEL_SHA256=4c06341c33c2ca1f86781dab0e829f88ad5b64be9fba56e56bc9ebdefc619e43
ARG ORT_VERSION=1.31.0
ARG ORT_ARCHIVE_URL=https://github.com/microsoft/onnxruntime/releases/download/v1.31.0/onnxruntime-linux-x64-1.31.0.tgz
ARG ORT_ARCHIVE_SHA256=cc5c72baf5ae5c8238a6841f0897227be2d02826b9cf98eaf02fdefaeeb03a57
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl unzip \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /usr/local/share/my-drive/face-models /tmp/ort \
    && curl --fail --silent --show-error --location --retry 3 "$FACE_MODEL_BUNDLE_URL" \
        --output /tmp/buffalo_l.zip \
    && echo "$FACE_MODEL_BUNDLE_SHA256  /tmp/buffalo_l.zip" \
        | sha256sum --check --status \
    && unzip -q -j /tmp/buffalo_l.zip det_10g.onnx w600k_r50.onnx -d /usr/local/share/my-drive/face-models \
    && echo "$FACE_DET_MODEL_SHA256  /usr/local/share/my-drive/face-models/det_10g.onnx" \
        | sha256sum --check --status \
    && echo "$FACE_REC_MODEL_SHA256  /usr/local/share/my-drive/face-models/w600k_r50.onnx" \
        | sha256sum --check --status \
    && rm -f /tmp/buffalo_l.zip \
    && curl --fail --silent --show-error --location --retry 3 "$ORT_ARCHIVE_URL" \
        --output /tmp/ort.tgz \
    && echo "$ORT_ARCHIVE_SHA256  /tmp/ort.tgz" \
        | sha256sum --check --status \
    && tar -xzf /tmp/ort.tgz -C /tmp/ort --strip-components=1 \
    && install -m 0755 "/tmp/ort/lib/libonnxruntime.so.${ORT_VERSION}" "/usr/local/lib/libonnxruntime.so.${ORT_VERSION}" \
    && ln -sf "libonnxruntime.so.${ORT_VERSION}" /usr/local/lib/libonnxruntime.so \
    && rm -rf /tmp/ort /tmp/ort.tgz

FROM debian:bookworm-slim AS runtime
ARG MY_DRIVE_VERSION=0.1.0
ARG MY_DRIVE_GIT_SHA=
ARG MY_DRIVE_BUILD_TIME=
ENV MY_DRIVE_VERSION=${MY_DRIVE_VERSION} \
    MY_DRIVE_GIT_SHA=${MY_DRIVE_GIT_SHA} \
    MY_DRIVE_BUILD_TIME=${MY_DRIVE_BUILD_TIME}
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 --home-dir /nonexistent --shell /usr/sbin/nologin mydrive \
    && mkdir -p /srv/my-drive/smb-view \
    && chown 10001:10001 /srv/my-drive/smb-view
COPY --from=builder /app/target/release/my-drive /usr/local/bin/my-drive
COPY --from=frontend-builder /app/frontend/dist /app/frontend/dist
WORKDIR /app
USER 10001:10001
EXPOSE 3000
ENTRYPOINT ["/usr/local/bin/my-drive"]

FROM debian:bookworm-slim AS document-preview-runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl fonts-liberation2 libreoffice-writer libreoffice-calc libreoffice-impress \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 --home-dir /nonexistent --shell /usr/sbin/nologin mydrive
COPY --from=builder /app/target/release/my-drive-document-preview /usr/local/bin/my-drive-document-preview
WORKDIR /tmp
USER 10001:10001
EXPOSE 3100
ENTRYPOINT ["/usr/local/bin/my-drive-document-preview"]

FROM debian:bookworm-slim AS media-indexer-runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates ffmpeg libstdc++6 libvips42=8.14.1-3+deb12u3 webp=1.2.4-0.2+deb12u1 \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 --home-dir /nonexistent --shell /usr/sbin/nologin mydrive
COPY --from=builder /app/target/release/my-drive-media-indexer /usr/local/bin/my-drive-media-indexer
COPY --from=media-thumbnailer-builder /usr/local/bin/my-drive-vips-thumbnailer /usr/local/bin/my-drive-vips-thumbnailer
COPY --from=face-model /usr/local/share/my-drive/face-models /usr/local/share/my-drive/face-models
COPY --from=face-model /usr/local/lib/libonnxruntime.so* /usr/local/lib/
RUN ldconfig
ENV ORT_DYLIB_PATH=/usr/local/lib/libonnxruntime.so \
    FACE_MODEL_DIR=/usr/local/share/my-drive/face-models
WORKDIR /app
USER 10001:10001
ENTRYPOINT ["/usr/local/bin/my-drive-media-indexer"]

FROM postgres:17-alpine AS media-indexer-db-setup
COPY docker/setup-indexer-role.sh /scripts/setup-indexer-role.sh
ENTRYPOINT ["/bin/sh", "/scripts/setup-indexer-role.sh"]

FROM debian:bookworm-slim AS smb-runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends samba samba-vfs-modules \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system --gid 10001 mydrive \
    && useradd --system --uid 10001 --gid 10001 --home-dir /nonexistent --shell /usr/sbin/nologin mydrive \
    && mkdir -p /srv/view /srv/my-drive/data \
    && chown 10001:10001 /srv/view
COPY docker/smb.conf /etc/samba/smb.conf
COPY docker/smb-entrypoint.sh /usr/local/bin/smb-entrypoint.sh
RUN chmod 0755 /usr/local/bin/smb-entrypoint.sh
EXPOSE 445
ENTRYPOINT ["/usr/local/bin/smb-entrypoint.sh"]
