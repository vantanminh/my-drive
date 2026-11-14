import assert from 'node:assert/strict';
import test from 'node:test';

import { MyDriveApiError, MyDriveClient } from '../src/services/apiClient.ts';
import { uploadPreparedFile } from '../src/services/uploadWorkflow.ts';

test('login captures csrf token and injects X-Csrf-Token only on mutations', async () => {
  const seenHeaders: Array<{ url: string; method: string; csrf: string | null }> = [];
  let updatedCsrf: string | null = null;

  const client = new MyDriveClient({
    baseUrl: 'https://nas.test:8443/',
    onCsrfUpdate: (token) => {
      updatedCsrf = token;
    },
    fetchImpl: async (input, init) => {
      const headers = new Headers(init?.headers);
      seenHeaders.push({
        url: String(input),
        method: init?.method ?? 'GET',
        csrf: headers.get('X-Csrf-Token'),
      });
      if (String(input).endsWith('/api/auth/login')) {
        return new Response(
          JSON.stringify({
            user: {
              id: 'u1',
              email: 'owner@nas.test',
              role: 'owner',
              must_change_password: false,
            },
            csrf_token: 'csrf_abc123',
          }),
          { status: 200 },
        );
      }
      if (String(input).includes('/api/photos')) {
        return new Response(
          JSON.stringify({ items: [], limit: 60, next_cursor: null }),
          { status: 200 },
        );
      }
      if (String(input).endsWith('/api/folders')) {
        return new Response(
          JSON.stringify({
            id: 'f1',
            parent_id: null,
            kind: 'folder',
            name: 'Camera',
            created_at: '2026-11-15T00:00:00Z',
            updated_at: '2026-11-15T00:00:00Z',
            deleted_at: null,
            size_bytes: null,
            mime_detected: null,
          }),
          { status: 201 },
        );
      }
      return new Response('{}', { status: 404 });
    },
  });

  const login = await client.login(' owner@nas.test ', 'secret');
  assert.equal(login.user.email, 'owner@nas.test');
  assert.equal(updatedCsrf, 'csrf_abc123');

  await client.listPhotos('cur1', 40);
  await client.createFolder('Camera', null);

  assert.equal(seenHeaders[1]?.url, 'https://nas.test:8443/api/photos?cursor=cur1&limit=40');
  assert.equal(seenHeaders[1]?.csrf, null);
  assert.equal(seenHeaders[2]?.method, 'POST');
  assert.equal(seenHeaders[2]?.csrf, 'csrf_abc123');
});

test('uploadPreparedFile handles skip, deduplicated link, and resumable chunk upload flows', async () => {
  let checkAction: 'skip' | 'link' | 'upload' = 'skip';
  const calls: string[] = [];

  const client = new MyDriveClient({
    baseUrl: 'https://nas.test',
    csrfToken: 'csrf_token',
    fetchImpl: async (input, init) => {
      const url = String(input);
      calls.push(`${init?.method ?? 'GET'} ${url}`);
      if (url.endsWith('/api/backup/check')) {
        return new Response(
          JSON.stringify({
            action: checkAction,
            file_id: checkAction === 'skip' ? 'existing-file' : null,
            version_id: null,
            remote_checksum: null,
            reusable: checkAction === 'link',
          }),
          { status: 200 },
        );
      }
      if (url.endsWith('/api/backup/link')) {
        return new Response(
          JSON.stringify({
            file_id: 'linked-file',
            version_id: 'ver-2',
            checksum_sha256: 'a'.repeat(64),
            deduplicated: true,
            unchanged: false,
          }),
          { status: 201 },
        );
      }
      if (url.endsWith('/api/uploads')) {
        return new Response(
          JSON.stringify({ id: 'up-1', offset: 0, length: 1024 }),
          { status: 201 },
        );
      }
      if (url.endsWith('/api/uploads/up-1/finalize')) {
        const headers = new Headers(init?.headers);
        assert.equal(headers.get('X-Content-SHA256'), 'b'.repeat(64));
        return new Response(
          JSON.stringify({ file_id: 'uploaded-file', status: 'completed' }),
          { status: 200 },
        );
      }
      throw new Error(`Unexpected request: ${url}`);
    },
  });

  // 1. Skip
  checkAction = 'skip';
  const skipResult = await uploadPreparedFile({
    client,
    uploadChunks: async () => assert.fail('must not upload chunks on skip'),
    parentId: 'folder-1',
    filename: 'IMG_001.HEIC',
    fileUri: 'file:///tmp/1.heic',
    sizeBytes: 1024,
    sha256: 'a'.repeat(64),
  });
  assert.deepEqual(skipResult, { fileId: 'existing-file', mode: 'skipped' });

  // 2. Link / deduplicate
  checkAction = 'link';
  const linkResult = await uploadPreparedFile({
    client,
    uploadChunks: async () => assert.fail('must not upload chunks on link'),
    parentId: 'folder-1',
    filename: 'IMG_002.HEIC',
    fileUri: 'file:///tmp/2.heic',
    sizeBytes: 1024,
    sha256: 'a'.repeat(64),
  });
  assert.deepEqual(linkResult, { fileId: 'linked-file', mode: 'deduplicated' });

  // 3. Full resumable upload
  checkAction = 'upload';
  let chunkUploaded = false;
  const uploadResult = await uploadPreparedFile({
    client,
    uploadChunks: async (uploadId, offset, size) => {
      assert.equal(uploadId, 'up-1');
      assert.equal(offset, 0);
      assert.equal(size, 1024);
      chunkUploaded = true;
      return 1024;
    },
    parentId: 'folder-1',
    filename: 'IMG_003.HEIC',
    fileUri: 'file:///tmp/3.heic',
    sizeBytes: 1024,
    sha256: 'b'.repeat(64),
  });
  assert.equal(chunkUploaded, true);
  assert.deepEqual(uploadResult, { fileId: 'uploaded-file', mode: 'uploaded' });
});

test('extracts structured API error code, status, and upload offset on 409', async () => {
  let unauthorizedCount = 0;
  const client = new MyDriveClient({
    baseUrl: 'https://nas.test',
    onUnauthorized: () => {
      unauthorizedCount += 1;
    },
    fetchImpl: async (input) => {
      if (String(input).endsWith('/api/uploads/u1')) {
        return new Response(JSON.stringify({ error: 'offset_conflict', offset: 4096 }), {
          status: 409,
          headers: { 'Upload-Offset': '4096' },
        });
      }
      return new Response(JSON.stringify({ error: 'authentication_required' }), { status: 401 });
    },
  });

  await assert.rejects(
    () => client.patchUploadChunk('u1', 0, 'chunk'),
    (err: unknown) => {
      if (!(err instanceof MyDriveApiError)) return false;
      assert.equal(err.status, 409);
      assert.equal(err.code, 'offset_conflict');
      assert.equal(err.offset, 4096);
      return true;
    },
  );

  await assert.rejects(() => client.me(), MyDriveApiError);
  assert.equal(unauthorizedCount, 1);
});
