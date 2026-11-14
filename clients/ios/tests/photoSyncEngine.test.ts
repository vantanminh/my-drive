import assert from 'node:assert/strict';
import test from 'node:test';

import { MyDriveClient } from '../src/services/apiClient.ts';
import {
  PhotoSyncEngine,
  type MediaAssetSummary,
  type PhotoSyncPlatformDeps,
} from '../src/services/photoSyncEngine.ts';
import { InMemorySyncLedgerStore } from '../src/services/syncLedger.ts';
import type { SyncSettings } from '../src/types/mydrive.ts';

const BASE_SETTINGS: SyncSettings = {
  autoBackgroundSync: true,
  wifiOnlySync: true,
  downloadICloudOverCellular: false,
  includeVideos: true,
  destinationFolder: 'Photos/MyPhone',
};

function makeMockAsset(id: string, filename: string, modMs = 1700000000000): MediaAssetSummary {
  return {
    id,
    filename,
    mediaType: filename.endsWith('.MOV') ? 'video' : 'photo',
    creationTime: modMs,
    modificationTime: modMs,
    width: 4032,
    height: 3024,
    duration: 0,
  };
}

function makeMockClient() {
  const existingHashes = new Set<string>(['dedup_hash']);
  const finalizedFiles: Array<{ name: string; sha256: string }> = [];

  const client = new MyDriveClient({
    baseUrl: 'https://nas.local:8080',
    csrfToken: 'csrf_test',
    fetchImpl: async (input, init) => {
      const url = String(input);
      const body = init?.body && typeof init.body === 'string' ? JSON.parse(init.body) : {};
      if (url.endsWith('/api/backup/folders')) {
        return new Response(JSON.stringify({ id: 'folder-photos-id', created: false }), { status: 200 });
      }
      if (url.endsWith('/api/backup/check')) {
        if (existingHashes.has(body.checksum_sha256)) {
          return new Response(
            JSON.stringify({
              action: 'link',
              file_id: null,
              version_id: null,
              remote_checksum: body.checksum_sha256,
              reusable: true,
            }),
            { status: 200 },
          );
        }
        return new Response(
          JSON.stringify({
            action: 'upload',
            file_id: null,
            version_id: null,
            remote_checksum: null,
            reusable: false,
          }),
          { status: 200 },
        );
      }
      if (url.endsWith('/api/backup/link')) {
        finalizedFiles.push({ name: body.name, sha256: body.checksum_sha256 });
        return new Response(
          JSON.stringify({
            file_id: `linked_${body.name}`,
            version_id: 'v1',
            checksum_sha256: body.checksum_sha256,
            deduplicated: true,
            unchanged: false,
          }),
          { status: 201 },
        );
      }
      if (url.endsWith('/api/uploads')) {
        return new Response(
          JSON.stringify({ id: `upload_${body.filename}`, offset: 0, length: body.expected_size }),
          { status: 201 },
        );
      }
      if (url.endsWith('/finalize')) {
        const headers = new Headers(init?.headers);
        const uploadId = url.split('/api/uploads/')[1]?.replace('/finalize', '') ?? 'file';
        finalizedFiles.push({
          name: uploadId,
          sha256: headers.get('X-Content-SHA256') ?? '',
        });
        return new Response(
          JSON.stringify({ file_id: `file_${uploadId}`, status: 'completed' }),
          { status: 200 },
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    },
  });

  return { client, finalizedFiles };
}

test('downloads iCloud originals when Optimize iPhone Storage is active and cleans up temp files', async () => {
  const { client } = makeMockClient();
  const ledger = new InMemorySyncLedgerStore();
  const cleanedPaths: string[] = [];
  const preparedAllowNetworkArgs: Array<{ id: string; allowNetwork: boolean }> = [];

  await ledger.upsert({
    asset_id: 'asset-already-synced',
    server_url: 'https://nas.local:8080',
    filename: 'OLD.HEIC',
    media_type: 'image',
    size_bytes: 500,
    sha256: 'abc',
    remote_file_id: 'f0',
    modification_time_ms: 1700000000000,
    was_in_icloud: false,
    status: 'synced',
    last_error: null,
    synced_at: '2026-11-14T10:00:00Z',
  });

  const assets = [
    makeMockAsset('asset-already-synced', 'OLD.HEIC', 1700000000000),
    makeMockAsset('asset-icloud-original', 'IMG_2048.HEIC', 1700000001000),
    makeMockAsset('asset-local-dedup', 'IMG_2049.HEIC', 1700000002000),
  ];

  let inspectedIds: string[] = [];

  const deps: PhotoSyncPlatformDeps = {
    async getNetworkStatus() {
      return { isConnected: true, isWifiOrEthernet: true };
    },
    async getPermissionStatus() {
      return 'granted';
    },
    async getAssetsPage() {
      return { assets, hasNextPage: false };
    },
    async inspectAssets(ids) {
      inspectedIds = ids;
      return [
        {
          assetId: 'asset-icloud-original',
          mediaType: 'image',
          originalFilename: 'IMG_2048.DNG', // Original ProRAW preserved!
          uniformTypeIdentifier: 'com.adobe.raw-image',
          mimeType: 'image/x-adobe-dng',
          inICloud: true,
          originalLocallyAvailable: false,
          pixelWidth: 8064,
          pixelHeight: 6048,
          durationSeconds: 0,
          creationTimestampMs: 1700000001000,
          modificationTimestampMs: 1700000001000,
          hasLivePhotoVideo: false,
        },
        {
          assetId: 'asset-local-dedup',
          mediaType: 'image',
          originalFilename: 'IMG_2049.HEIC',
          uniformTypeIdentifier: 'public.heic',
          mimeType: 'image/heic',
          inICloud: false,
          originalLocallyAvailable: true,
          pixelWidth: 4032,
          pixelHeight: 3024,
          durationSeconds: 0,
          creationTimestampMs: 1700000002000,
          modificationTimestampMs: 1700000002000,
          hasLivePhotoVideo: false,
        },
      ];
    },
    async prepareOriginalAsset(assetId, allowNetwork) {
      preparedAllowNetworkArgs.push({ id: assetId, allowNetwork });
      if (assetId === 'asset-icloud-original') {
        return {
          assetId,
          tempFilePath: '/tmp/mydrive-sync-staging/IMG_2048.DNG',
          tempFileUri: 'file:///tmp/mydrive-sync-staging/IMG_2048.DNG',
          filename: 'IMG_2048.DNG',
          mimeType: 'image/x-adobe-dng',
          sizeBytes: 42_000_000,
          sha256: '11'.repeat(32),
          downloadedFromICloud: true,
          width: 8064,
          height: 6048,
          creationDateIso: '2026-11-14T12:00:00Z',
          modificationDateIso: '2026-11-14T12:00:00Z',
        };
      }
      return {
        assetId,
        tempFilePath: '/tmp/mydrive-sync-staging/IMG_2049.HEIC',
        tempFileUri: 'file:///tmp/mydrive-sync-staging/IMG_2049.HEIC',
        filename: 'IMG_2049.HEIC',
        mimeType: 'image/heic',
        sizeBytes: 3_500_000,
        sha256: 'dedup_hash',
        downloadedFromICloud: false,
        width: 4032,
        height: 3024,
        creationDateIso: '2026-11-14T12:05:00Z',
        modificationDateIso: '2026-11-14T12:05:00Z',
      };
    },
    async cleanupPreparedFile(path) {
      cleanedPaths.push(path);
    },
    async uploadChunks(_id, _offset, size) {
      return size;
    },
  };

  const engine = new PhotoSyncEngine(client, ledger, deps);
  const result = await engine.run({ settings: BASE_SETTINGS });

  assert.deepEqual(inspectedIds, ['asset-icloud-original', 'asset-local-dedup']);
  assert.deepEqual(preparedAllowNetworkArgs, [
    { id: 'asset-icloud-original', allowNetwork: true },
    { id: 'asset-local-dedup', allowNetwork: true },
  ]);
  assert.equal(result.skippedCount, 1);
  assert.equal(result.uploadedCount, 1);
  assert.equal(result.dedupedCount, 1);
  assert.equal(result.icloudOriginalsDownloaded, 1);
  assert.equal(result.failedCount, 0);
  assert.deepEqual(cleanedPaths, [
    '/tmp/mydrive-sync-staging/IMG_2048.DNG',
    '/tmp/mydrive-sync-staging/IMG_2049.HEIC',
  ]);

  const savedICloud = await ledger.get('https://nas.local:8080', 'asset-icloud-original');
  assert.equal(savedICloud?.was_in_icloud, true);
  assert.equal(savedICloud?.filename, 'IMG_2048.DNG');
  assert.equal(savedICloud?.status, 'synced');
});

test('defers iCloud-only assets on cellular when downloadICloudOverCellular is false while syncing local photos', async () => {
  const { client } = makeMockClient();
  const ledger = new InMemorySyncLedgerStore();
  let uploadedCount = 0;

  const deps: PhotoSyncPlatformDeps = {
    async getNetworkStatus() {
      return { isConnected: true, isWifiOrEthernet: false };
    },
    async getPermissionStatus() {
      return 'granted';
    },
    async getAssetsPage() {
      return {
        assets: [
          makeMockAsset('icloud-only-1', 'CLOUD.HEIC', 1700000010000),
          makeMockAsset('local-only-2', 'LOCAL.HEIC', 1700000020000),
        ],
        hasNextPage: false,
      };
    },
    async inspectAssets() {
      return [
        {
          assetId: 'icloud-only-1',
          mediaType: 'image',
          originalFilename: 'CLOUD.HEIC',
          uniformTypeIdentifier: 'public.heic',
          mimeType: 'image/heic',
          inICloud: true,
          originalLocallyAvailable: false,
          pixelWidth: 4032,
          pixelHeight: 3024,
          durationSeconds: 0,
          creationTimestampMs: 1700000010000,
          modificationTimestampMs: 1700000010000,
          hasLivePhotoVideo: false,
        },
        {
          assetId: 'local-only-2',
          mediaType: 'image',
          originalFilename: 'LOCAL.HEIC',
          uniformTypeIdentifier: 'public.heic',
          mimeType: 'image/heic',
          inICloud: false,
          originalLocallyAvailable: true,
          pixelWidth: 4032,
          pixelHeight: 3024,
          durationSeconds: 0,
          creationTimestampMs: 1700000020000,
          modificationTimestampMs: 1700000020000,
          hasLivePhotoVideo: false,
        },
      ];
    },
    async prepareOriginalAsset(assetId) {
      assert.equal(assetId, 'local-only-2', 'must NOT download iCloud asset on cellular');
      return {
        assetId,
        tempFilePath: '/tmp/mydrive-sync-staging/LOCAL.HEIC',
        tempFileUri: 'file:///tmp/mydrive-sync-staging/LOCAL.HEIC',
        filename: 'LOCAL.HEIC',
        mimeType: 'image/heic',
        sizeBytes: 1_200_000,
        sha256: '22'.repeat(32),
        downloadedFromICloud: false,
        width: 4032,
        height: 3024,
        creationDateIso: null,
        modificationDateIso: null,
      };
    },
    async cleanupPreparedFile() {},
    async uploadChunks(_id, _offset, size) {
      uploadedCount += 1;
      return size;
    },
  };

  const engine = new PhotoSyncEngine(client, ledger, deps);
  const result = await engine.run({
    settings: {
      ...BASE_SETTINGS,
      wifiOnlySync: false,
      downloadICloudOverCellular: false,
    },
  });

  assert.equal(uploadedCount, 1);
  assert.equal(result.icloudWaitingWifiCount, 1);
  assert.equal(result.uploadedCount, 1);
  assert.equal(result.failedCount, 0);

  const cloudRec = await ledger.get('https://nas.local:8080', 'icloud-only-1');
  assert.equal(cloudRec?.status, 'icloud_waiting_wifi');
  assert.equal(cloudRec?.was_in_icloud, true);
});

test('cleans up prepared file even when upload fails and preserves remaining batch', async () => {
  const { client } = makeMockClient();
  const ledger = new InMemorySyncLedgerStore();
  const cleaned: string[] = [];

  const deps: PhotoSyncPlatformDeps = {
    async getNetworkStatus() {
      return { isConnected: true, isWifiOrEthernet: true };
    },
    async getPermissionStatus() {
      return 'granted';
    },
    async getAssetsPage() {
      return {
        assets: [
          makeMockAsset('a1', 'FAIL.HEIC', 1700000001000),
          makeMockAsset('a2', 'PASS.HEIC', 1700000002000),
        ],
        hasNextPage: false,
      };
    },
    async inspectAssets() {
      return [];
    },
    async prepareOriginalAsset(assetId) {
      return {
        assetId,
        tempFilePath: `/tmp/mydrive-sync-staging/${assetId}`,
        tempFileUri: `file:///tmp/mydrive-sync-staging/${assetId}`,
        filename: `${assetId}.HEIC`,
        mimeType: 'image/heic',
        sizeBytes: 1000,
        sha256: assetId === 'a1' ? '33'.repeat(32) : '44'.repeat(32),
        downloadedFromICloud: false,
        width: 100,
        height: 100,
        creationDateIso: null,
        modificationDateIso: null,
      };
    },
    async cleanupPreparedFile(path) {
      cleaned.push(path);
    },
    async uploadChunks(uploadId, _offset, size) {
      if (uploadId === 'upload_a1.HEIC') {
        throw new Error('simulated network drop');
      }
      return size;
    },
  };

  const engine = new PhotoSyncEngine(client, ledger, deps);
  const result = await engine.run({ settings: BASE_SETTINGS });

  assert.equal(result.failedCount, 1);
  assert.equal(result.uploadedCount, 1);
  assert.deepEqual(cleaned, [
    '/tmp/mydrive-sync-staging/a1',
    '/tmp/mydrive-sync-staging/a2',
  ]);
  const failRecord = await ledger.get('https://nas.local:8080', 'a1');
  assert.equal(failRecord?.status, 'error');
  assert.match(failRecord?.last_error ?? '', /simulated network drop/);
});
