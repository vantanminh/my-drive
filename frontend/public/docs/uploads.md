# Resumable uploads and downloads

[Overview](/docs/index.md) · [Photos](/docs/photos.md)

All paths are relative to `/api/v1`. Uploads use the same storage validation, quotas and media indexing pipeline as the website.

## Upload protocol

1. `POST /uploads` with `drive:write`, JSON `{"filename":"lesson.mp4","expected_size":123456,"parent_id":"FOLDER_UUID"}`. Omit parent or use null for root. Returns 201 `{"id":"UPLOAD_UUID","offset":0,"length":123456}`.
2. `PATCH /uploads/{id}` with `drive:write`, raw bytes, `Content-Type: application/offset+octet-stream` and `Upload-Offset: 0`. Send chunks up to 64 MiB (8 MiB recommended). Success returns 204 and `Upload-Offset` with the next offset.
3. Repeat chunks using the returned offset. `HEAD /uploads/{id}` with `drive:read` returns `Upload-Offset`, `Upload-Length`, `Upload-Expires`. On a 409 offset conflict, use HEAD to reconcile instead of resending blindly.
4. `POST /uploads/{id}/finalize` with `drive:write` and no body. Returns `{"file_id":"UUID","status":"completed"}`. Store `file_id` for metadata and sharing. Repeating finalize returns the completed result.
5. `DELETE /uploads/{id}` with `drive:write` cancels an unfinished session.

Keep the session ID locally for resume after interruption. Sessions expire according to server configuration. File limit, quota, storage mount and free space checks apply. Zero-byte files can be finalized without PATCH.

```sh
curl -X PATCH https://YOUR_DOMAIN/api/v1/uploads/UPLOAD_UUID \
  -H "Authorization: Bearer $MYDRIVE_API_KEY" \
  -H 'Content-Type: application/offset+octet-stream' -H 'Upload-Offset: 0' \
  --data-binary @chunk.bin
```

## File content

| Methods | Path | Scope |
|---|---|---|
| GET, HEAD | /files/{id}/download | drive:read |
| GET, HEAD | /files/{id}/preview | drive:read |
| GET, HEAD | /files/{id}/thumbnail | drive:read |

Download supports HTTP Range requests. Preview availability depends on detected MIME type, media indexing and configured document preview service. Thumbnails may be unavailable while indexing runs. Uploading images or videos to Drive automatically queues media indexing and makes recognized media discoverable in Photos; do not upload a second copy for Photos.
