# Photos and albums

[Overview](/docs/index.md) · [Uploads](/docs/uploads.md)

Drive and Photos have separate entry points. Photos uploads are stored in the user's protected system Photos folder. Recognized images and videos uploaded anywhere in Drive are also visible in Photos after indexing. The timeline is a view over your media, so it does not duplicate file storage.

All paths are relative to `/api/v1`.

| Method | Path | Scope | Input / output |
|---|---|---|---|
| POST | /photos/uploads | photos:write | `{filename,expected_size}`; no parent; returns an upload session |
| POST | /library/photos-folder | photos:write | No body; ensures the system Photos folder |
| GET | /photos | photos:read | `limit` (max 120), `cursor`; response `{items,limit,next_cursor}` |
| GET | /albums | photos:read | `{albums:[…]}` |
| POST | /albums | photos:write | `{name}` |
| GET | /albums/{id} | photos:read | Album metadata |
| PATCH | /albums/{id} | photos:write | `{name}` |
| DELETE | /albums/{id} | photos:write | Delete album, retain underlying files |
| GET | /albums/{id}/items | photos:read | `limit`, `cursor`; paginated media |
| POST | /albums/{id}/items | photos:write | `{file_ids:[UUID]}`, at most 100 |
| POST | /albums/{id}/items/remove | photos:write | `{file_ids:[UUID]}`, at most 100 |

Use the normal `/uploads/{id}` PATCH / HEAD / finalize / DELETE protocol after creating a Photos session. That protocol requires `drive:write` (and `drive:read` for HEAD). Supported upload filename extensions include JPEG, PNG, GIF, WebP, AVIF, BMP, TIFF, HEIC, HEIF, MP4, MOV, WebM, MKV, AVI, M4V, MPEG, 3GP, MTS and M2TS. Actual media recognition uses detected file content during finalization/indexing; a filename alone does not guarantee Photos inclusion.

Follow `next_cursor` as an opaque value until null. Album links can be created using the [Shares API](/docs/shares.md) with `resource_type:"album"`.
