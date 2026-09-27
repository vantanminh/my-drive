# Public share links and revocation

[Overview](/docs/index.md) · [Key lifecycle](/docs/authentication.md)

All paths below are relative to `/api/v1`.

## Create a link

`POST /shares` with `shares:write`:

```json
{"resource_type":"folder","resource_id":"FOLDER_UUID","expires_at":null,"password":null,"allow_download":true,"max_downloads":null}
```

`resource_type` is `file`, `folder` or `album`. You must own the resource. Optional expiry must be in the future, password must be 8–128 bytes, max downloads must be positive.

Returns 201:

```json
{"id":"SHARE_UUID","resource_type":"folder","resource_id":"FOLDER_UUID","share_url":"/s/SECRET_TOKEN","expires_at":null,"password_protected":false,"allow_download":true,"max_downloads":null}
```

Resolve `share_url` against your MyDrive origin, e.g. `https://YOUR_DOMAIN/s/SECRET_TOKEN`. Store this full URL in Excel or Google Sheets. Folder links let recipients browse and preview video/PDF lessons using the existing public viewer. The recipient needs no API key or MyDrive account. Password-protected links require the share password.

The link secret is returned once. Save it at creation; listing shares does not reveal or reconstruct it. Treat it as a capability: anyone receiving an unprotected URL can access that share.

## List and revoke

- `GET /shares` (`shares:read`), query `limit` (max 100), `offset`; response `{shares,next_offset}`. Records include `created_by_api_key_id` (null for browser-created links), resource metadata, expiry, revoked status, download counts and last access.
- `POST /shares/{id}/revoke` (`shares:write`), no body. Revocation also removes password-unlock grants. You can also revoke it in the website's **Shared links** page.

A revoked or expired API key does **not** disable its links. The website's key revocation confirmation defaults to preserving links, with an explicit option to revoke all links created by that key. Even after key revocation, **Revoke its links** remains available. Bulk revocation affects only that key's links; it does not affect links created by other keys or from the website.

Link expiry, link revocation, exhausted download limits, resource deletion or account disablement may independently prevent access.
