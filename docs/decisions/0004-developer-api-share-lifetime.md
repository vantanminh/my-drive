---
created_at: "2026-09-27T14:02:37.428473600+00:00"
doc: docs/decisions/0004-developer-api-share-lifetime.md
id: "0004"
links:
  - US-026
notes: "Use /api/v1 with scoped high-entropy bearer keys stored as SHA-256 digests; browser sessions plus CSRF manage keys. Share records retain creating key provenance. Key expiry or revocation preserves links by default; explicit opt-in bulk link revocation and later independent revocation remain available. Reuse ownership checks and upload/media pipeline. Per-user logs and admin aggregate usage exclude credentials, bodies and query strings. Publish linked HTML and Markdown documentation."
status: accepted
title: Versioned personal API keys and independent public share lifetime
type: decision
updated_at: "2026-09-27T14:02:37.428480800+00:00"
verify: null
---

# Versioned personal API keys and independent public share lifetime
