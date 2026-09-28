---
created_at: "2026-09-28T15:42:48.681685037+00:00"
doc: docs/decisions/0007-quick-connect-split-dns.md
id: "0007"
links:
  - US-031
notes: "One public hostname stays the origin for cookies, OAuth, and WebSockets. Home resolvers override that name to the server LAN address; public DNS can point at a Cloudflare Tunnel when the origin is not port-forwarded. Certificates come from ACME DNS-01 through a zone-scoped Cloudflare token, so TCP 80/443 need not be reachable from the Internet. A second local hostname or a browser fetch to a LAN address is rejected: it splits browser state and can trigger Local Network Access checks. Stock Caddy cannot solve DNS-01; the installer builds or pulls a Caddy image with github.com/caddy-dns/cloudflare. Tokens stay in root-only env/state and are passed by Compose environment references."
status: accepted
title: Quick Connect uses split DNS and ACME DNS-01
type: decision
updated_at: "2026-09-28T15:42:48.681685537+00:00"
verify: null
---

# Quick Connect uses split DNS and ACME DNS-01
