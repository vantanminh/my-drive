import assert from 'node:assert/strict';
import test from 'node:test';

import type { NativeLocalCacheStats } from '../modules/mydrive-media-sync/src/index.ts';
import {
  DEFAULT_CACHE_HISTORY,
  DEFAULT_CACHE_SETTINGS,
  buildCacheSnapshot,
  clearAllAppCaches,
  clearCacheByCategory,
  inspectAllCaches,
  normalizeCacheHistory,
  normalizeCacheSettings,
  pruneExpiredCaches,
  removeSingleCachedFile,
  runAutoCacheMaintenance,
  updateCacheSettings,
} from '../src/services/cacheManager.ts';
import type {
  CacheAdapters,
  CacheSettings,
  CacheStatsHistory,
} from '../src/services/cacheTypes.ts';

function cloneStats(stats: NativeLocalCacheStats): NativeLocalCacheStats {
  return {
    ...stats,
    imageCache: { ...stats.imageCache },
    videoCache: { ...stats.videoCache },
    downloadsCache: {
      ...stats.downloadsCache,
      items: stats.downloadsCache.items.map((item) => ({ ...item })),
    },
    stagingCache: { ...stats.stagingCache },
    networkCache: { ...stats.networkCache },
    otherCache: { ...stats.otherCache },
  };
}

function createMockCacheHarness(initialStats?: Partial<NativeLocalCacheStats>) {
  let stats: NativeLocalCacheStats = {
    deviceTotalBytes: 128 * 1024 * 1024 * 1024,
    deviceFreeBytes: 42 * 1024 * 1024 * 1024,
    imageCache: { sizeBytes: 40 * 1024 * 1024, fileCount: 220 },
    videoCache: { sizeBytes: 60 * 1024 * 1024, fileCount: 12 },
    downloadsCache: {
      sizeBytes: 15 * 1024 * 1024,
      fileCount: 2,
      items: [
        {
          id: '/tmp/mydrive-downloads/1/report.pdf',
          path: '/tmp/mydrive-downloads/1/report.pdf',
          name: 'report.pdf',
          sizeBytes: 5 * 1024 * 1024,
          modifiedAtMs: 1700000100000,
        },
        {
          id: '/tmp/mydrive-downloads/2/deck.pptx',
          path: '/tmp/mydrive-downloads/2/deck.pptx',
          name: 'deck.pptx',
          sizeBytes: 10 * 1024 * 1024,
          modifiedAtMs: 1700000200000,
        },
      ],
    },
    stagingCache: { sizeBytes: 25 * 1024 * 1024, fileCount: 3 },
    networkCache: { sizeBytes: 10 * 1024 * 1024, fileCount: 18, memoryBytes: 512 * 1024 },
    otherCache: { sizeBytes: 0, fileCount: 0 },
    syncDatabaseBytes: 256 * 1024,
    inspectedAt: '2026-11-18T02:00:00.000Z',
    ...initialStats,
  };

  let settings: CacheSettings = { ...DEFAULT_CACHE_SETTINGS };
  let history: CacheStatsHistory = { ...DEFAULT_CACHE_HISTORY };
  let configuredImageLimit: number | null = null;
  let configuredVideoLimit: number | null = null;
  let videoClearError: Error | null = null;
  const pruneCalls: Array<{ maxAgeSeconds: number; includeSyncStaging: boolean }> = [];

  const adapters: CacheAdapters = {
    async inspectNativeCaches() {
      return cloneStats(stats);
    },
    async clearImageCache() {
      stats.imageCache = { sizeBytes: 0, fileCount: 0 };
    },
    async clearVideoCache() {
      if (videoClearError) throw videoClearError;
      stats.videoCache = { sizeBytes: 0, fileCount: 0 };
    },
    async clearNativeCategory(category) {
      let deletedBytes = 0;
      let deletedFiles = 0;
      if (category === 'downloads' || category === 'all_native') {
        deletedBytes += stats.downloadsCache.sizeBytes;
        deletedFiles += stats.downloadsCache.fileCount;
        stats.downloadsCache = { sizeBytes: 0, fileCount: 0, items: [] };
      }
      if (category === 'staging' || category === 'all_native') {
        deletedBytes += stats.stagingCache.sizeBytes;
        deletedFiles += stats.stagingCache.fileCount;
        stats.stagingCache = { sizeBytes: 0, fileCount: 0 };
      }
      if (category === 'network' || category === 'all_native') {
        deletedBytes += stats.networkCache.sizeBytes;
        deletedFiles += stats.networkCache.fileCount;
        stats.networkCache = { sizeBytes: 0, fileCount: 0, memoryBytes: 0 };
      }
      if (category === 'other' || category === 'all_native') {
        deletedBytes += stats.otherCache.sizeBytes;
        deletedFiles += stats.otherCache.fileCount;
        stats.otherCache = { sizeBytes: 0, fileCount: 0 };
      }
      return { deletedBytes, deletedFiles };
    },
    async deleteCachedFile(filePath) {
      const target = stats.downloadsCache.items.find((i) => i.path === filePath);
      if (!target) return { deletedBytes: 0, deletedFiles: 0 };
      stats.downloadsCache.items = stats.downloadsCache.items.filter((i) => i.path !== filePath);
      stats.downloadsCache.sizeBytes = Math.max(
        0,
        stats.downloadsCache.sizeBytes - target.sizeBytes,
      );
      stats.downloadsCache.fileCount = Math.max(0, stats.downloadsCache.fileCount - 1);
      return { deletedBytes: target.sizeBytes, deletedFiles: 1 };
    },
    async pruneExpiredTemp(maxAgeSeconds, includeSyncStaging) {
      pruneCalls.push({ maxAgeSeconds, includeSyncStaging });
      const oldest = stats.downloadsCache.items.find((i) => i.name === 'report.pdf');
      if (!oldest) return { deletedBytes: 0, deletedFiles: 0 };
      stats.downloadsCache.items = stats.downloadsCache.items.filter(
        (i) => i.path !== oldest.path,
      );
      stats.downloadsCache.sizeBytes -= oldest.sizeBytes;
      stats.downloadsCache.fileCount -= 1;
      return { deletedBytes: oldest.sizeBytes, deletedFiles: 1 };
    },
    configureImageCache(maxDiskSizeBytes) {
      configuredImageLimit = maxDiskSizeBytes;
    },
    async configureVideoCacheSize(maxCacheSizeBytes) {
      configuredVideoLimit = maxCacheSizeBytes;
    },
    async loadSettings() {
      return { ...settings };
    },
    async saveSettings(next) {
      settings = { ...next };
    },
    async loadHistory() {
      return { ...history };
    },
    async saveHistory(next) {
      history = { ...next };
    },
  };

  return {
    adapters,
    getState: () => ({
      stats,
      settings,
      history,
      configuredImageLimit,
      configuredVideoLimit,
      pruneCalls,
    }),
    setVideoClearError: (err: Error | null) => {
      videoClearError = err;
    },
  };
}

test('normalizes cache settings and cumulative history bounds cleanly', () => {
  const settings = normalizeCacheSettings({
    imageMaxDiskSizeBytes: -50,
    videoMaxCacheSizeBytes: 1024,
    autoCleanExpiredTemp: false,
    tempRetentionDays: 999,
  });
  assert.equal(settings.imageMaxDiskSizeBytes, DEFAULT_CACHE_SETTINGS.imageMaxDiskSizeBytes);
  assert.equal(settings.videoMaxCacheSizeBytes, 64 * 1024 * 1024);
  assert.equal(settings.autoCleanExpiredTemp, false);
  assert.equal(settings.tempRetentionDays, 365);

  const history = normalizeCacheHistory({
    lastInspectedAt: '  ',
    lastClearedAt: '2026-11-18T01:00:00Z',
    lastClearedBytes: -10,
    totalClearedBytes: 4096.6,
    totalCleanRuns: 3,
  });
  assert.equal(history.lastInspectedAt, null);
  assert.equal(history.lastClearedAt, '2026-11-18T01:00:00Z');
  assert.equal(history.lastClearedBytes, 0);
  assert.equal(history.totalClearedBytes, 4097);
  assert.equal(history.totalCleanRuns, 3);
});

test('buildCacheSnapshot computes category percentages, sorted downloads, and active sync guard', () => {
  const harness = createMockCacheHarness();
  const { stats, settings, history } = harness.getState();

  const idleSnap = buildCacheSnapshot({
    nativeStats: stats,
    settings,
    history,
    syncRunning: false,
  });
  assert.equal(idleSnap.totalCacheBytes, 150 * 1024 * 1024);
  assert.equal(idleSnap.totalFileCount, 255);
  assert.equal(idleSnap.categories.length, 5);
  assert.equal(idleSnap.cachedDownloads[0]?.name, 'deck.pptx');
  assert.equal(idleSnap.cachedDownloads[1]?.name, 'report.pdf');
  const videoCat = idleSnap.categories.find((c) => c.id === 'videos');
  assert.equal(videoCat?.percentOfCache, 40);
  assert.equal(videoCat?.limitBytes, DEFAULT_CACHE_SETTINGS.videoMaxCacheSizeBytes);
  const stagingIdle = idleSnap.categories.find((c) => c.id === 'staging');
  assert.equal(stagingIdle?.clearable, true);
  assert.equal(stagingIdle?.blockedReason, null);

  const syncingSnap = buildCacheSnapshot({
    nativeStats: stats,
    settings,
    history,
    syncRunning: true,
  });
  const stagingBusy = syncingSnap.categories.find((c) => c.id === 'staging');
  assert.equal(stagingBusy?.clearable, false);
  assert.match(stagingBusy?.blockedReason ?? '', /active/i);
});

test('clearCacheByCategory clears individual buckets and protects staging during active sync', async () => {
  const harness = createMockCacheHarness();

  await assert.rejects(
    () => clearCacheByCategory('staging', harness.adapters, { syncRunning: true }),
    /photo backup is running/i,
  );

  const imgResult = await clearCacheByCategory('images', harness.adapters);
  assert.equal(imgResult.freedBytes, 40 * 1024 * 1024);
  assert.equal(imgResult.freedFiles, 220);
  assert.equal(imgResult.snapshot.totalCacheBytes, 110 * 1024 * 1024);
  assert.equal(imgResult.snapshot.history.totalCleanRuns, 1);
  assert.equal(imgResult.snapshot.history.totalClearedBytes, 40 * 1024 * 1024);

  const dlResult = await clearCacheByCategory('downloads', harness.adapters);
  assert.equal(dlResult.freedBytes, 15 * 1024 * 1024);
  assert.equal(dlResult.freedFiles, 2);
  assert.equal(dlResult.snapshot.cachedDownloads.length, 0);
  assert.equal(dlResult.snapshot.history.totalCleanRuns, 2);
});

test('clearAllAppCaches preserves staging during active sync and collects partial video error warnings', async () => {
  const harness = createMockCacheHarness({
    otherCache: { sizeBytes: 2 * 1024 * 1024, fileCount: 4 },
  });
  harness.setVideoClearError(new Error('Cannot clear cache while there are active players'));

  const res = await clearAllAppCaches(harness.adapters, { syncRunning: true });
  assert.equal(res.warnings.length, 2);
  assert.match(res.warnings[0] ?? '', /active players/i);
  assert.match(res.warnings[1] ?? '', /active/i);
  // Images (40M) + Downloads (15M) + Network (10M) + Other (2M) = 67M freed; Video (60M) + Staging (25M) kept
  assert.equal(res.freedBytes, 67 * 1024 * 1024);
  assert.equal(res.snapshot.totalCacheBytes, 85 * 1024 * 1024);

  // Now clear when idle and video player closed
  harness.setVideoClearError(null);
  const fullRes = await clearAllAppCaches(harness.adapters, { syncRunning: false });
  assert.equal(fullRes.warnings.length, 0);
  assert.equal(fullRes.freedBytes, 85 * 1024 * 1024);
  assert.equal(fullRes.snapshot.totalCacheBytes, 0);
  assert.equal(fullRes.snapshot.history.totalClearedBytes, 152 * 1024 * 1024);
  assert.equal(fullRes.snapshot.history.totalCleanRuns, 2);
});

test('removeSingleCachedFile, pruneExpiredCaches, policy updates, and startup maintenance work together', async () => {
  const harness = createMockCacheHarness();

  const inspected = await inspectAllCaches(harness.adapters);
  assert.ok(inspected.history.lastInspectedAt);

  const removedOne = await removeSingleCachedFile(
    '/tmp/mydrive-downloads/2/deck.pptx',
    harness.adapters,
  );
  assert.equal(removedOne.freedBytes, 10 * 1024 * 1024);
  assert.equal(removedOne.snapshot.cachedDownloads.length, 1);

  const policyUpdate = await updateCacheSettings(
    {
      imageMaxDiskSizeBytes: 256 * 1024 * 1024,
      videoMaxCacheSizeBytes: 512 * 1024 * 1024,
      tempRetentionDays: 14,
    },
    harness.adapters,
  );
  assert.equal(policyUpdate.warnings.length, 0);
  assert.equal(harness.getState().configuredImageLimit, 256 * 1024 * 1024);
  assert.equal(harness.getState().configuredVideoLimit, 512 * 1024 * 1024);

  const maintenance = await runAutoCacheMaintenance(harness.adapters, {
    syncRunning: true,
  });
  assert.equal(maintenance.prunedBytes, 5 * 1024 * 1024);
  assert.equal(maintenance.prunedFiles, 1);
  assert.equal(harness.getState().pruneCalls[0]?.maxAgeSeconds, 14 * 24 * 60 * 60);
  assert.equal(harness.getState().pruneCalls[0]?.includeSyncStaging, false);

  // Turning off autoClean skips pruning while still configuring image cache limit.
  await updateCacheSettings({ autoCleanExpiredTemp: false }, harness.adapters);
  const disabledMaint = await runAutoCacheMaintenance(harness.adapters);
  assert.equal(disabledMaint.prunedBytes, 0);
  assert.equal(harness.getState().pruneCalls.length, 1);

  // Manual prune still works regardless of autoClean toggle.
  const manualPrune = await pruneExpiredCaches(harness.adapters, { retentionDays: 3 });
  assert.equal(manualPrune.freedBytes, 0);
  assert.equal(harness.getState().pruneCalls.length, 2);
});
