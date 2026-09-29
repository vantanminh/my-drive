# MyDrive REST API v1

Automate your own Drive and Photos library. Base URL: `https://YOUR_DOMAIN/api/v1`.
All identifiers are UUIDs. JSON uses snake_case; dates are RFC 3339 UTC timestamps.
This documentation is public and requires no login. Append `.md` to any documentation URL to read its Markdown source.

## Documentation map

- [Authentication and API keys](/docs/authentication.md)
- [Drive: folders, files and metadata](/docs/drive.md)
- [Resumable uploads and downloads](/docs/uploads.md)
- [Photos and albums](/docs/photos.md)
- [Public share links and revocation](/docs/shares.md)
- [Usage, logs and administration](/docs/usage.md)
- [Upload lessons and export links to CSV / Google Sheets](/docs/lesson-sync.md)
- [Windows Backup Client](/docs/backup-client.md)

## First request

Create a key in **Settings → Developer**, then:

```sh
curl https://YOUR_DOMAIN/api/v1/drive \
  -H "Authorization: Bearer $MYDRIVE_API_KEY"
```

Only your own data is accessible, including when your account is an administrator.
Administrator aggregate usage is available through the browser's Developer settings.

## Errors and limits

Errors use HTTP status codes and usually `{"error":"code"}`. Invalid JSON, paths or query values can return Axum validation messages instead.

| Status | Meaning |
|---|---|
| 400 | Invalid fields, UUID, dates, pagination or upload headers |
| 401 | Missing, expired or revoked key; disabled account or password change required |
| 403 | Missing scope |
| 404 | Resource not owned by caller / unavailable endpoint or revoked share |
| 409 | Name conflict, invalid move or upload offset conflict |
| 410 | Upload expired or share exhausted |
| 413 | File or chunk exceeds configured limit |
| 429 | 120 requests per key per minute; retry after `Retry-After` seconds |
| 503 | Database or storage unavailable; retry with backoff |

Respect account quota and server upload limits. Do not retry non-idempotent creates blindly: reconcile by listing the target folder after an ambiguous network failure. Upload chunks support offset reconciliation via HEAD. API keys belong in server-side environment variables, never in shared spreadsheets or browser code.
