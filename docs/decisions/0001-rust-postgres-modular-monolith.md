---
created_at: "2026-09-20T03:52:44.391028800+00:00"
doc: docs/decisions/0001-rust-postgres-modular-monolith.md
id: "0001"
notes: "This workspace contains no application source, so the implementation starts from a clean baseline. Use a single Rust service with Tokio, Axum, SQLx, PostgreSQL, tracing, Argon2id, UUIDs, and a local filesystem storage adapter. PostgreSQL stores metadata and security state only. STORAGE_ROOT is a separately mounted HDD path and startup must fail safely when its mount is absent. Add a React/Vite TypeScript client after the API foundation, and deploy as a single-server Compose stack with a reverse proxy kept external/configurable."
status: accepted
title: Use a Rust/Axum and PostgreSQL modular monolith
type: decision
updated_at: "2026-09-20T03:52:44.391031300+00:00"
verify: Axum/Tokio serves the API; SQLx owns PostgreSQL access and migrations; file payloads remain on configured local storage outside the webroot.
---

# Use a Rust/Axum and PostgreSQL modular monolith
