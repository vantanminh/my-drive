# Authentication and API keys

[Overview](/docs/index.md)

Every API request must include `Authorization: Bearer mdk_…`. Cookies are not accepted as authentication for `/api/v1`. Keys cannot call browser authentication, account administration or key management endpoints.

Create keys in **Settings → Developer**. The secret is shown only once and is never stored as plaintext. Name keys for their integration; select permissions and an optional expiry. Up to 50 active keys per account.

| Scope | Permission |
|---|---|
| drive:read | List, search, metadata, storage, read upload status, download / preview |
| drive:write | Create folders, modify / trash / restore / purge entries, create / append / finalize / cancel uploads |
| photos:read | Photos timeline and albums |
| photos:write | Create a Photos upload, manage Photos folder and albums |
| shares:read | List your shares |
| shares:write | Create and revoke shares |

A Photos upload uses `photos:write` to create its session and `drive:write` to send chunks and finalize; use `drive:read` for resumable status checks. A lesson synchronizer normally needs `drive:read`, `drive:write`, `shares:read`, `shares:write`.

Revocation takes effect for new API requests. Requests already executing may finish. Share creation revalidates the key inside its transaction so bulk link revocation cannot miss a concurrently created link.

## Independent link lifetime

Revoking a key **keeps links working by default**. The confirmation offers **Also revoke all links created by this key**. Retain the revoked key record so its links can be revoked later with **Revoke its links**, or revoke individual links in **Shared links**. Key expiry also leaves links intact. Links can still expire under their own expiry, password and download restrictions.

## Browser management contract

These endpoints use the signed-in browser session and CSRF protection for mutations; they do not accept API keys.

| Method | Path | Body / response |
|---|---|---|
| GET | /api/developer/keys | Query `offset`; `{keys:[{id,name,prefix,scopes,created_at,expires_at,revoked_at,last_used_at}],next_offset}` |
| POST | /api/developer/keys | `{name,scopes,expires_at:null}` → 201 `{id,key}` |
| POST | /api/developer/keys/{id}/revoke | `{revoke_shares:false}` → `{shares_revoked}` |
| POST | /api/developer/keys/{id}/shares/revoke | No body → `{shares_revoked}`; works for revoked keys |

Keys are retained as revoked records, not physically deleted, to preserve link provenance and usage history.

Key history is paginated in batches of 100. Follow `next_offset` or use **Load older keys** to manage older revoked keys and their links.
