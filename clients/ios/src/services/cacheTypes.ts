import type { NativeCachedFileItem, NativeLocalCacheStats } from '../../modules/mydrive-media-sync/src';

export type CacheCategoryId =
  | 'images'
  | 'videos'
  | 'downloads'
  | 'staging'
  | 'network'
  | 'other';

export interface CacheSettings {
  imageMaxDiskSizeBytes: number;
  videoMaxCacheSizeBytes: number;
  autoCleanExpiredTemp: boolean;
  tempRetentionDays: number;
}

export interface CacheStatsHistory {
  lastInspectedAt: string | null;
  lastClearedAt: string | null;
  lastClearedBytes: number;
  totalClearedBytes: number;
  totalCleanRuns: number;
}

export interface CacheCategoryStats {
  id: CacheCategoryId;
  title: string;
  subtitle: string;
  color: string;
  icon: string;
  sizeBytes: number;
  fileCount: number;
  percentOfCache: number;
  limitBytes: number | null;
  memoryBytes: number;
  clearable: boolean;
  blockedReason: string | null;
}

export type CachedFileEntry = NativeCachedFileItem;

export interface CacheSnapshot {
  totalCacheBytes: number;
  totalFileCount: number;
  deviceTotalBytes: number;
  deviceFreeBytes: number;
  deviceUsedByCachePercent: number;
  categories: CacheCategoryStats[];
  cachedDownloads: CachedFileEntry[];
  syncDatabaseBytes: number;
  inspectedAt: string;
  history: CacheStatsHistory;
  settings: CacheSettings;
}

export interface CacheCleanupResult {
  freedBytes: number;
  freedFiles: number;
  warnings: string[];
  snapshot: CacheSnapshot;
}

export interface CacheAdapters {
  inspectNativeCaches(): Promise<NativeLocalCacheStats>;
  clearImageCache(): Promise<void>;
  clearVideoCache(): Promise<void>;
  clearNativeCategory(
    category: 'downloads' | 'staging' | 'network' | 'other' | 'all_native',
  ): Promise<{ deletedBytes: number; deletedFiles: number }>;
  deleteCachedFile(filePath: string): Promise<{ deletedBytes: number; deletedFiles: number }>;
  pruneExpiredTemp(
    maxAgeSeconds: number,
    includeSyncStaging: boolean,
  ): Promise<{ deletedBytes: number; deletedFiles: number }>;
  configureImageCache(maxDiskSizeBytes: number): void;
  configureVideoCacheSize(maxCacheSizeBytes: number): Promise<void>;
  loadSettings(): Promise<CacheSettings>;
  saveSettings(settings: CacheSettings): Promise<void>;
  loadHistory(): Promise<CacheStatsHistory>;
  saveHistory(history: CacheStatsHistory): Promise<void>;
}
