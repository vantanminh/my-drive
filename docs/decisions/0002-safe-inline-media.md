---
created_at: "2026-09-21T16:18:16.462452500+00:00"
doc: docs/decisions/0002-safe-inline-media.md
id: "0002"
links:
  - US-010
notes: "Treat uploaded bytes as untrusted. Keep generic downloads as attachments. Inline preview MIME must come from a bounded signature detector, not user-controlled names or upload headers; exclude SVG and unknown formats. Preserve owner scoping, byte ranges, nosniff, and a restrictive sandbox policy for inline media."
status: proposed
title: Serve only sniffed safe media formats inline
type: decision
updated_at: "2026-09-21T16:18:16.462454400+00:00"
verify: "Inline responses use bounded content signature detection and an explicit safe MIME allowlist, retain owner authorization and range semantics, and exclude active or unsupported formats."
---

# Serve only sniffed safe media formats inline
