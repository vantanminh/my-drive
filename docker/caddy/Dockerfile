# Quick Connect certificates use ACME DNS-01. The stock Caddy image has no DNS provider.
FROM caddy:2.11.4-builder AS builder
RUN xcaddy build v2.11.4 --with github.com/caddy-dns/cloudflare@v0.2.4

FROM caddy:2.11.4-alpine
COPY --from=builder /usr/bin/caddy /usr/bin/caddy
