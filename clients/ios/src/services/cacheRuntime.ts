import { Paths } from 'expo-file-system';
import { Image } from 'expo-image';
import {
  clearVideoCacheAsync,
  getCurrentVideoCacheSize,
  setVideoCacheSizeAsync,
} from 'expo-video';

import {
  clearLocalCacheCategory,
  deleteCachedFile,
  inspectLocalCaches,
  pruneExpiredTempCache,
  type NativeLocalCacheStats,
} from '../../modules/mydrive-media-sync/src';
import {
  buildEmptyNativeCacheStats,
  clearAllAppCaches,
  clearCacheByCategory,
  inspectAllCaches,
  pruneExpiredCaches,
  removeSingleCachedFile,
  runAutoCacheMaintenance,
  updateCacheSettings,
} from './cacheManager';
import type {
  CacheAdapters,
  CacheCategoryId,
  CacheCleanupResult,
  CacheSettings,
  CacheSnapshot,
} from './cacheTypes';
import {
  loadCacheHistory,
  loadCacheSettings,
  saveCacheHistory,
  saveCacheSettings,
} from './secureStorage';

function safeDeviceCapacity(): { total: number; free: number } {
  try {
    return {
      total: Math.max(0, Number(Paths.totalDiskSpace ?? 0)),
      free: Math.max(0, Number(Paths.availableDiskSpace ?? 0)),
    };
  } catch {
    return { total: 0, free: 0 };
  }
}

function safeVideoCacheBytes(): number {
  try {
    return Math.max(0, Number(getCurrentVideoCacheSize() ?? 0));
  } catch {
    return 0;
  }
}

export const iosCacheAdapters: CacheAdapters = {
  async inspectNativeCaches(): Promise<NativeLocalCacheStats> {
    const [nativeStats, videoSize, fallbackDisk] = await Promise.all([
      inspectLocalCaches().catch(() => null),
      Promise.resolve(safeVideoCacheBytes()),
      Promise.resolve(safeDeviceCapacity()),
    ]);
    const base = nativeStats ?? buildEmptyNativeCacheStats();
    return {
      ...base,
      deviceTotalBytes: base.deviceTotalBytes > 0 ? base.deviceTotalBytes : fallbackDisk.total,
      deviceFreeBytes: base.deviceFreeBytes > 0 ? base.deviceFreeBytes : fallbackDisk.free,
      videoCache: {
        ...base.videoCache,
        sizeBytes: Math.max(base.videoCache.sizeBytes, videoSize),
        fileCount:
          base.videoCache.fileCount > 0 || videoSize === 0 ? base.videoCache.fileCount : 1,
      },
    };
  },
  async clearImageCache(): Promise<void> {
    await Promise.all([
      Image.clearMemoryCache().catch(() => false),
      Image.clearDiskCache().catch(() => false),
    ]);
  },
  async clearVideoCache(): Promise<void> {
    await clearVideoCacheAsync();
  },
  async clearNativeCategory(category) {
    return clearLocalCacheCategory(category);
  },
  async deleteCachedFile(filePath: string) {
    return deleteCachedFile(filePath);
  },
  async pruneExpiredTemp(maxAgeSeconds: number, includeSyncStaging: boolean) {
    return pruneExpiredTempCache(maxAgeSeconds, includeSyncStaging);
  },
  configureImageCache(maxDiskSizeBytes: number): void {
    Image.configureCache({ maxDiskSize: maxDiskSizeBytes });
  },
  async configureVideoCacheSize(maxCacheSizeBytes: number): Promise<void> {
    await setVideoCacheSizeAsync(maxCacheSizeBytes);
  },
  loadSettings: loadCacheSettings,
  saveSettings: saveCacheSettings,
  loadHistory: loadCacheHistory,
  saveHistory: saveCacheHistory,
};

export async function fetchCacheSnapshot(options?: {
  syncRunning?: boolean;
}): Promise<CacheSnapshot> {
  return inspectAllCaches(iosCacheAdapters, options);
}

export async function clearCategoryCache(
  categoryId: CacheCategoryId,
  options?: { syncRunning?: boolean },
): Promise<CacheCleanupResult> {
  return clearCacheByCategory(categoryId, iosCacheAdapters, options);
}

export async function clearAllCaches(options?: {
  syncRunning?: boolean;
}): Promise<CacheCleanupResult> {
  return clearAllAppCaches(iosCacheAdapters, options);
}

export async function removeCachedDownloadItem(
  filePath: string,
  options?: { syncRunning?: boolean },
): Promise<CacheCleanupResult> {
  return removeSingleCachedFile(filePath, iosCacheAdapters, options);
}

export async function pruneExpiredCacheNow(options?: {
  syncRunning?: boolean;
  retentionDays?: number;
}): Promise<CacheCleanupResult> {
  return pruneExpiredCaches(iosCacheAdapters, options);
}

export async function updateCachePolicy(
  patch: Partial<CacheSettings>,
): Promise<{ settings: CacheSettings; warnings: string[] }> {
  return updateCacheSettings(patch, iosCacheAdapters);
}

export async function runStartupCacheMaintenance(options?: {
  syncRunning?: boolean;
}): Promise<{ prunedBytes: number; prunedFiles: number }> {
  return runAutoCacheMaintenance(iosCacheAdapters, options);
}
