import type { NativeLocalCacheStats } from '../../modules/mydrive-media-sync/src';
import type {
  CacheAdapters,
  CacheCategoryId,
  CacheCategoryStats,
  CacheCleanupResult,
  CacheSettings,
  CacheSnapshot,
  CacheStatsHistory,
} from './cacheTypes';

const MB = 1024 * 1024;
const GB = 1024 * MB;

export const IMAGE_CACHE_LIMIT_PRESETS = [
  { label: '128 MB', bytes: 128 * MB },
  { label: '256 MB', bytes: 256 * MB },
  { label: '512 MB', bytes: 512 * MB },
  { label: '1 GB', bytes: 1 * GB },
  { label: 'Unlimited', bytes: 0 },
] as const;

export const VIDEO_CACHE_LIMIT_PRESETS = [
  { label: '256 MB', bytes: 256 * MB },
  { label: '512 MB', bytes: 512 * MB },
  { label: '1 GB', bytes: 1 * GB },
  { label: '2 GB', bytes: 2 * GB },
] as const;

export const TEMP_RETENTION_DAY_PRESETS = [3, 7, 14, 30] as const;

export const DEFAULT_CACHE_SETTINGS: CacheSettings = {
  imageMaxDiskSizeBytes: 512 * MB,
  videoMaxCacheSizeBytes: 1 * GB,
  autoCleanExpiredTemp: true,
  tempRetentionDays: 7,
};

export const DEFAULT_CACHE_HISTORY: CacheStatsHistory = {
  lastInspectedAt: null,
  lastClearedAt: null,
  lastClearedBytes: 0,
  totalClearedBytes: 0,
  totalCleanRuns: 0,
};

interface CategoryMeta {
  id: CacheCategoryId;
  title: string;
  subtitle: string;
  color: string;
  icon: string;
}

const CATEGORY_META: Record<CacheCategoryId, CategoryMeta> = {
  images: {
    id: 'images',
    title: 'Images & Thumbnails',
    subtitle: 'Cached photo grid thumbnails & inline image previews',
    color: '#14694f',
    icon: 'images-outline',
  },
  videos: {
    id: 'videos',
    title: 'Video Streaming Cache',
    subtitle: 'Buffered video segments from Photo & File viewer',
    color: '#366899',
    icon: 'videocam-outline',
  },
  downloads: {
    id: 'downloads',
    title: 'Downloaded Previews & Files',
    subtitle: 'PDF, Office, text previews & shared file exports',
    color: '#b86e2e',
    icon: 'document-text-outline',
  },
  staging: {
    id: 'staging',
    title: 'Sync & Upload Temp',
    subtitle: 'Temporary PhotoKit/iCloud staging & Document Picker copies',
    color: '#7b55a3',
    icon: 'cloud-upload-outline',
  },
  network: {
    id: 'network',
    title: 'Network & WebView Cache',
    subtitle: 'HTTP response cache & WebView preview assets',
    color: '#5b6c79',
    icon: 'globe-outline',
  },
  other: {
    id: 'other',
    title: 'Other App Cache',
    subtitle: 'Additional disposable app cache files',
    color: '#8897a4',
    icon: 'folder-open-outline',
  },
};

function sanitizeNonNegativeInt(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return fallback;
  }
  return Math.round(value);
}

export function normalizeCacheSettings(
  raw?: Partial<CacheSettings> | null,
): CacheSettings {
  const imageMax = sanitizeNonNegativeInt(
    raw?.imageMaxDiskSizeBytes,
    DEFAULT_CACHE_SETTINGS.imageMaxDiskSizeBytes,
  );
  const videoMax = Math.max(
    64 * MB,
    sanitizeNonNegativeInt(
      raw?.videoMaxCacheSizeBytes,
      DEFAULT_CACHE_SETTINGS.videoMaxCacheSizeBytes,
    ),
  );
  const retentionDays = Math.max(
    1,
    Math.min(
      365,
      sanitizeNonNegativeInt(
        raw?.tempRetentionDays,
        DEFAULT_CACHE_SETTINGS.tempRetentionDays,
      ),
    ),
  );
  return {
    imageMaxDiskSizeBytes: imageMax,
    videoMaxCacheSizeBytes: videoMax,
    autoCleanExpiredTemp:
      typeof raw?.autoCleanExpiredTemp === 'boolean'
        ? raw.autoCleanExpiredTemp
        : DEFAULT_CACHE_SETTINGS.autoCleanExpiredTemp,
    tempRetentionDays: retentionDays,
  };
}

export function normalizeCacheHistory(
  raw?: Partial<CacheStatsHistory> | null,
): CacheStatsHistory {
  return {
    lastInspectedAt:
      typeof raw?.lastInspectedAt === 'string' && raw.lastInspectedAt.trim()
        ? raw.lastInspectedAt
        : null,
    lastClearedAt:
      typeof raw?.lastClearedAt === 'string' && raw.lastClearedAt.trim()
        ? raw.lastClearedAt
        : null,
    lastClearedBytes: sanitizeNonNegativeInt(raw?.lastClearedBytes, 0),
    totalClearedBytes: sanitizeNonNegativeInt(raw?.totalClearedBytes, 0),
    totalCleanRuns: sanitizeNonNegativeInt(raw?.totalCleanRuns, 0),
  };
}

export function buildEmptyNativeCacheStats(nowIso = new Date().toISOString()): NativeLocalCacheStats {
  return {
    deviceTotalBytes: 0,
    deviceFreeBytes: 0,
    imageCache: { sizeBytes: 0, fileCount: 0 },
    videoCache: { sizeBytes: 0, fileCount: 0 },
    downloadsCache: { sizeBytes: 0, fileCount: 0, items: [] },
    stagingCache: { sizeBytes: 0, fileCount: 0 },
    networkCache: { sizeBytes: 0, fileCount: 0, memoryBytes: 0 },
    otherCache: { sizeBytes: 0, fileCount: 0 },
    syncDatabaseBytes: 0,
    inspectedAt: nowIso,
  };
}

export function buildCacheSnapshot(params: {
  nativeStats: NativeLocalCacheStats;
  settings: CacheSettings;
  history: CacheStatsHistory;
  syncRunning?: boolean;
}): CacheSnapshot {
  const { nativeStats, settings, history, syncRunning = false } = params;

  const rawEntries: Array<{
    id: CacheCategoryId;
    sizeBytes: number;
    fileCount: number;
    limitBytes: number | null;
    memoryBytes: number;
    blockedReason: string | null;
  }> = [
    {
      id: 'images',
      sizeBytes: Math.max(0, nativeStats.imageCache.sizeBytes),
      fileCount: Math.max(0, nativeStats.imageCache.fileCount),
      limitBytes: settings.imageMaxDiskSizeBytes > 0 ? settings.imageMaxDiskSizeBytes : null,
      memoryBytes: 0,
      blockedReason: null,
    },
    {
      id: 'videos',
      sizeBytes: Math.max(0, nativeStats.videoCache.sizeBytes),
      fileCount: Math.max(0, nativeStats.videoCache.fileCount),
      limitBytes: settings.videoMaxCacheSizeBytes,
      memoryBytes: 0,
      blockedReason: null,
    },
    {
      id: 'downloads',
      sizeBytes: Math.max(0, nativeStats.downloadsCache.sizeBytes),
      fileCount: Math.max(0, nativeStats.downloadsCache.fileCount),
      limitBytes: null,
      memoryBytes: 0,
      blockedReason: null,
    },
    {
      id: 'staging',
      sizeBytes: Math.max(0, nativeStats.stagingCache.sizeBytes),
      fileCount: Math.max(0, nativeStats.stagingCache.fileCount),
      limitBytes: null,
      memoryBytes: 0,
      blockedReason: syncRunning ? 'Photo backup is currently active' : null,
    },
    {
      id: 'network',
      sizeBytes: Math.max(0, nativeStats.networkCache.sizeBytes),
      fileCount: Math.max(0, nativeStats.networkCache.fileCount),
      limitBytes: null,
      memoryBytes: Math.max(0, nativeStats.networkCache.memoryBytes),
      blockedReason: null,
    },
  ];

  if (nativeStats.otherCache.sizeBytes > 0 || nativeStats.otherCache.fileCount > 0) {
    rawEntries.push({
      id: 'other',
      sizeBytes: Math.max(0, nativeStats.otherCache.sizeBytes),
      fileCount: Math.max(0, nativeStats.otherCache.fileCount),
      limitBytes: null,
      memoryBytes: 0,
      blockedReason: null,
    });
  }

  const totalCacheBytes = rawEntries.reduce((sum, item) => sum + item.sizeBytes, 0);
  const totalFileCount = rawEntries.reduce((sum, item) => sum + item.fileCount, 0);

  const categories: CacheCategoryStats[] = rawEntries.map((item) => {
    const meta = CATEGORY_META[item.id];
    return {
      ...meta,
      sizeBytes: item.sizeBytes,
      fileCount: item.fileCount,
      percentOfCache:
        totalCacheBytes > 0 ? Math.round((item.sizeBytes / totalCacheBytes) * 1000) / 10 : 0,
      limitBytes: item.limitBytes,
      memoryBytes: item.memoryBytes,
      clearable: item.blockedReason == null && (item.sizeBytes > 0 || item.fileCount > 0 || item.id === 'images' || item.id === 'network'),
      blockedReason: item.blockedReason,
    };
  });

  const deviceTotalBytes = Math.max(0, nativeStats.deviceTotalBytes);
  const deviceFreeBytes = Math.max(0, nativeStats.deviceFreeBytes);
  const deviceUsedByCachePercent =
    deviceTotalBytes > 0
      ? Math.min(100, Math.round((totalCacheBytes / deviceTotalBytes) * 10000) / 100)
      : 0;

  return {
    totalCacheBytes,
    totalFileCount,
    deviceTotalBytes,
    deviceFreeBytes,
    deviceUsedByCachePercent,
    categories,
    cachedDownloads: [...nativeStats.downloadsCache.items].sort(
      (a, b) => b.modifiedAtMs - a.modifiedAtMs,
    ),
    syncDatabaseBytes: Math.max(0, nativeStats.syncDatabaseBytes),
    inspectedAt: nativeStats.inspectedAt || new Date().toISOString(),
    history,
    settings,
  };
}

function errorMessageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

async function recordClearOutcome(
  adapters: CacheAdapters,
  prevHistory: CacheStatsHistory,
  freedBytes: number,
  freedFiles: number,
  inspectedAt: string,
): Promise<CacheStatsHistory> {
  const updated: CacheStatsHistory = {
    lastInspectedAt: inspectedAt,
    lastClearedAt: new Date().toISOString(),
    lastClearedBytes: Math.max(0, freedBytes),
    totalClearedBytes: prevHistory.totalClearedBytes + Math.max(0, freedBytes),
    totalCleanRuns:
      freedBytes > 0 || freedFiles > 0
        ? prevHistory.totalCleanRuns + 1
        : prevHistory.totalCleanRuns,
  };
  await adapters.saveHistory(updated);
  return updated;
}

export async function inspectAllCaches(
  adapters: CacheAdapters,
  options: { syncRunning?: boolean } = {},
): Promise<CacheSnapshot> {
  const [nativeStats, settings, prevHistory] = await Promise.all([
    adapters.inspectNativeCaches(),
    adapters.loadSettings(),
    adapters.loadHistory(),
  ]);
  const nextHistory: CacheStatsHistory = {
    ...prevHistory,
    lastInspectedAt: nativeStats.inspectedAt || new Date().toISOString(),
  };
  await adapters.saveHistory(nextHistory).catch(() => {});
  return buildCacheSnapshot({
    nativeStats,
    settings,
    history: nextHistory,
    syncRunning: options.syncRunning,
  });
}

export async function clearCacheByCategory(
  categoryId: CacheCategoryId,
  adapters: CacheAdapters,
  options: { syncRunning?: boolean } = {},
): Promise<CacheCleanupResult> {
  if (categoryId === 'staging' && options.syncRunning) {
    throw new Error('Cannot clear sync staging files while photo backup is running.');
  }

  const before = await inspectAllCaches(adapters, options);
  const targetBefore = before.categories.find((c) => c.id === categoryId);
  const beforeBytes = targetBefore?.sizeBytes ?? 0;
  const beforeFiles = targetBefore?.fileCount ?? 0;

  let reportedBytes = 0;
  let reportedFiles = 0;

  if (categoryId === 'images') {
    await adapters.clearImageCache();
  } else if (categoryId === 'videos') {
    await adapters.clearVideoCache();
  } else {
    const res = await adapters.clearNativeCategory(categoryId);
    reportedBytes = res.deletedBytes;
    reportedFiles = res.deletedFiles;
  }

  const afterNative = await adapters.inspectNativeCaches();
  const afterTempSnap = buildCacheSnapshot({
    nativeStats: afterNative,
    settings: before.settings,
    history: before.history,
    syncRunning: options.syncRunning,
  });
  const targetAfter = afterTempSnap.categories.find((c) => c.id === categoryId);
  const freedBytes = Math.max(
    reportedBytes,
    Math.max(0, beforeBytes - (targetAfter?.sizeBytes ?? 0)),
  );
  const freedFiles = Math.max(
    reportedFiles,
    Math.max(0, beforeFiles - (targetAfter?.fileCount ?? 0)),
  );

  const history = await recordClearOutcome(
    adapters,
    before.history,
    freedBytes,
    freedFiles,
    afterNative.inspectedAt,
  );

  return {
    freedBytes,
    freedFiles,
    warnings: [],
    snapshot: buildCacheSnapshot({
      nativeStats: afterNative,
      settings: before.settings,
      history,
      syncRunning: options.syncRunning,
    }),
  };
}

export async function clearAllAppCaches(
  adapters: CacheAdapters,
  options: { syncRunning?: boolean } = {},
): Promise<CacheCleanupResult> {
  const before = await inspectAllCaches(adapters, options);
  const warnings: string[] = [];
  let nativeDeletedBytes = 0;
  let nativeDeletedFiles = 0;

  try {
    await adapters.clearImageCache();
  } catch (err) {
    warnings.push(`Image cache: ${errorMessageOf(err)}`);
  }

  try {
    await adapters.clearVideoCache();
  } catch (err) {
    warnings.push(`Video cache: ${errorMessageOf(err)}`);
  }

  if (options.syncRunning) {
    warnings.push('Skipped sync staging files because photo backup is currently active.');
    for (const nativeCat of ['downloads', 'network', 'other'] as const) {
      const res = await adapters.clearNativeCategory(nativeCat);
      nativeDeletedBytes += res.deletedBytes;
      nativeDeletedFiles += res.deletedFiles;
    }
  } else {
    const res = await adapters.clearNativeCategory('all_native');
    nativeDeletedBytes += res.deletedBytes;
    nativeDeletedFiles += res.deletedFiles;
  }

  const afterNative = await adapters.inspectNativeCaches();
  const afterTempSnap = buildCacheSnapshot({
    nativeStats: afterNative,
    settings: before.settings,
    history: before.history,
    syncRunning: options.syncRunning,
  });

  const freedBytes = Math.max(
    nativeDeletedBytes,
    Math.max(0, before.totalCacheBytes - afterTempSnap.totalCacheBytes),
  );
  const freedFiles = Math.max(
    nativeDeletedFiles,
    Math.max(0, before.totalFileCount - afterTempSnap.totalFileCount),
  );

  const history = await recordClearOutcome(
    adapters,
    before.history,
    freedBytes,
    freedFiles,
    afterNative.inspectedAt,
  );

  return {
    freedBytes,
    freedFiles,
    warnings,
    snapshot: buildCacheSnapshot({
      nativeStats: afterNative,
      settings: before.settings,
      history,
      syncRunning: options.syncRunning,
    }),
  };
}

export async function removeSingleCachedFile(
  filePath: string,
  adapters: CacheAdapters,
  options: { syncRunning?: boolean } = {},
): Promise<CacheCleanupResult> {
  const before = await inspectAllCaches(adapters, options);
  const res = await adapters.deleteCachedFile(filePath);
  const afterNative = await adapters.inspectNativeCaches();
  const afterTempSnap = buildCacheSnapshot({
    nativeStats: afterNative,
    settings: before.settings,
    history: before.history,
    syncRunning: options.syncRunning,
  });

  const freedBytes = Math.max(
    res.deletedBytes,
    Math.max(0, before.totalCacheBytes - afterTempSnap.totalCacheBytes),
  );
  const freedFiles = Math.max(
    res.deletedFiles,
    Math.max(0, before.totalFileCount - afterTempSnap.totalFileCount),
  );

  const history = await recordClearOutcome(
    adapters,
    before.history,
    freedBytes,
    freedFiles,
    afterNative.inspectedAt,
  );

  return {
    freedBytes,
    freedFiles,
    warnings: [],
    snapshot: buildCacheSnapshot({
      nativeStats: afterNative,
      settings: before.settings,
      history,
      syncRunning: options.syncRunning,
    }),
  };
}

export async function pruneExpiredCaches(
  adapters: CacheAdapters,
  options: { syncRunning?: boolean; retentionDays?: number } = {},
): Promise<CacheCleanupResult> {
  const before = await inspectAllCaches(adapters, options);
  const days = options.retentionDays ?? before.settings.tempRetentionDays;
  const maxAgeSeconds = Math.max(1, days) * 24 * 60 * 60;
  const res = await adapters.pruneExpiredTemp(maxAgeSeconds, !options.syncRunning);

  const afterNative = await adapters.inspectNativeCaches();
  const afterTempSnap = buildCacheSnapshot({
    nativeStats: afterNative,
    settings: before.settings,
    history: before.history,
    syncRunning: options.syncRunning,
  });

  const freedBytes = Math.max(
    res.deletedBytes,
    Math.max(0, before.totalCacheBytes - afterTempSnap.totalCacheBytes),
  );
  const freedFiles = Math.max(
    res.deletedFiles,
    Math.max(0, before.totalFileCount - afterTempSnap.totalFileCount),
  );

  const history =
    freedBytes > 0 || freedFiles > 0
      ? await recordClearOutcome(
          adapters,
          before.history,
          freedBytes,
          freedFiles,
          afterNative.inspectedAt,
        )
      : before.history;

  return {
    freedBytes,
    freedFiles,
    warnings: [],
    snapshot: buildCacheSnapshot({
      nativeStats: afterNative,
      settings: before.settings,
      history,
      syncRunning: options.syncRunning,
    }),
  };
}

export async function updateCacheSettings(
  patch: Partial<CacheSettings>,
  adapters: CacheAdapters,
): Promise<{ settings: CacheSettings; warnings: string[] }> {
  const current = await adapters.loadSettings();
  const next = normalizeCacheSettings({ ...current, ...patch });
  await adapters.saveSettings(next);

  const warnings: string[] = [];
  try {
    adapters.configureImageCache(next.imageMaxDiskSizeBytes);
  } catch (err) {
    warnings.push(`Image cache limit: ${errorMessageOf(err)}`);
  }

  if (patch.videoMaxCacheSizeBytes !== undefined) {
    try {
      await adapters.configureVideoCacheSize(next.videoMaxCacheSizeBytes);
    } catch (err) {
      warnings.push(`Video cache limit: ${errorMessageOf(err)}`);
    }
  }

  return { settings: next, warnings };
}

export async function runAutoCacheMaintenance(
  adapters: CacheAdapters,
  options: { syncRunning?: boolean } = {},
): Promise<{ prunedBytes: number; prunedFiles: number }> {
  const settings = await adapters.loadSettings();
  try {
    adapters.configureImageCache(settings.imageMaxDiskSizeBytes);
  } catch {
    // Non-fatal in non-native runtimes.
  }

  if (!settings.autoCleanExpiredTemp) {
    return { prunedBytes: 0, prunedFiles: 0 };
  }

  const maxAgeSeconds = Math.max(1, settings.tempRetentionDays) * 24 * 60 * 60;
  const res = await adapters
    .pruneExpiredTemp(maxAgeSeconds, !options.syncRunning)
    .catch(() => ({ deletedBytes: 0, deletedFiles: 0 }));

  if (res.deletedBytes > 0 || res.deletedFiles > 0) {
    const prevHistory = await adapters.loadHistory();
    await recordClearOutcome(
      adapters,
      prevHistory,
      res.deletedBytes,
      res.deletedFiles,
      new Date().toISOString(),
    ).catch(() => {});
  }

  return {
    prunedBytes: res.deletedBytes,
    prunedFiles: res.deletedFiles,
  };
}
