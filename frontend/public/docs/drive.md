# Drive: folders, files and metadata

[Overview](/docs/index.md) · [Uploads](/docs/uploads.md) · [Shares](/docs/shares.md)

All paths below are relative to `/api/v1`.

| Method | Path | Scope | Input / output |
|---|---|---|---|
| GET | /drive | drive:read | Query: `parent_id`, `limit` (1–200, default 100), `offset`, `sort_by` (`name`, `updated_at`, `created_at`, `size`), `order` (`asc`/`desc`), `include_stats`; response `{entries,limit,next_offset}` |
| POST | /folders | drive:write | `{name,parent_id:null}` → 201 entry |
| GET | /entries/{id} | drive:read | Entry metadata |
| GET | /entries/{id}/details | drive:read | Metadata, breadcrumb path and folder analytics |
| PATCH | /entries/{id}/rename | drive:write | `{name}` |
| POST | /entries/{id}/move | drive:write | `{parent_id:null}`; null moves to root |
| DELETE | /entries/{id} | drive:write | Move file / folder tree to trash |
| POST | /entries/{id}/restore | drive:write | Restore from trash |
| GET | /drive/trash | drive:read | `limit`, `offset`; paginated entries |
| POST | /drive/trash/purge | drive:write | `{ids:[UUID]}`; permanent deletion |
| POST | /drive/batch | drive:write | `{action,ids,parent_id:null}`; actions `move`, `copy`, `trash`; response `{action,count,entry_ids}` |
| GET | /drive/search | drive:read | Paginated `{entries,limit,next_offset}` |
| GET | /storage | drive:read | Account quota and storage usage |

Omit `parent_id` to list root. Follow `next_offset` until null. Folder and file names share a namespace; duplicate names return 409. Names must be 1–255 characters without slash or backslash. The system Photos folder cannot be renamed, moved or trashed.

Entry fields: `id`, `parent_id`, `kind` (`file`/`folder`), `name`, `created_at`, `updated_at`, `deleted_at`, `size_bytes`, `mime_detected`, `category`, `folder_bytes`, `folder_file_count`, `folder_subfolder_count`, `system_role`. Optional metadata may be null while indexing is pending.

Search supports `q`, `category` (`folder`, `image`, `video`, `audio`, `document`, `archive`, `other`), `mime`, `min_size`, `max_size`, `created_from`, `created_to`, `modified_from`, `modified_to`, `folder_id`, `limit` (max 120), `offset`, `sort_by`, `order`. Supply at least one search criterion. Dates accept RFC 3339 or `YYYY-MM-DD`.

```sh
curl -X POST https://YOUR_DOMAIN/api/v1/folders \
  -H "Authorization: Bearer $MYDRIVE_API_KEY" -H 'Content-Type: application/json' \
  -d '{"name":"Lesson 01","parent_id":null}'
```
