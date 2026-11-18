import { EventEmitter, requireOptionalNativeModule } from 'expo-modules-core';

export interface ICloudAssetInspection {
  assetId: string;
  mediaType: 'image' | 'video';
  originalFilename: string;
  uniformTypeIdentifier: string;
  mimeType: string;
  inICloud: boolean;
  originalLocallyAvailable: boolean;
  pixelWidth: number;
  pixelHeight: number;
  durationSeconds: number;
  creationTimestampMs: number | null;
  modificationTimestampMs: number | null;
  hasLivePhotoVideo: boolean;
}

export interface PreparedOriginalAsset {
  assetId: string;
  tempFilePath: string;
  tempFileUri: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  downloadedFromICloud: boolean;
  width: number;
  height: number;
  creationDateIso: string | null;
  modificationDateIso: string | null;
}

export interface UploadChunkedOptions {
  baseUrl: string;
  uploadId: string;
  fileUri: string;
  startOffset?: number;
  chunkSize?: number;
  csrfToken?: string | null;
  authToken?: string | null;
}

export interface LocalDownloadResult {
  localUri: string;
  path: string;
  mimeType: string;
  sizeBytes: number;
}

export interface WifiSubnetInfo {
  interfaceName: string;
  localIp: string;
  netmask: string;
  subnetPrefix: string;
}

export interface NativeDiscoveredLanServer {
  url: string;
  ip: string;
  port: number;
  scheme: 'http' | 'https';
  product: string;
  serverId?: string;
  serverVersion?: string;
  apiVersion?: number;
  latencyMs: number;
}

export interface NativeCacheBucketStats {
  sizeBytes: number;
  fileCount: number;
}

export interface NativeCachedFileItem {
  id: string;
  path: string;
  name: string;
  sizeBytes: number;
  modifiedAtMs: number;
}

export interface NativeLocalCacheStats {
  deviceTotalBytes: number;
  deviceFreeBytes: number;
  imageCache: NativeCacheBucketStats;
  videoCache: NativeCacheBucketStats;
  downloadsCache: NativeCacheBucketStats & { items: NativeCachedFileItem[] };
  stagingCache: NativeCacheBucketStats;
  networkCache: NativeCacheBucketStats & { memoryBytes: number };
  otherCache: NativeCacheBucketStats;
  syncDatabaseBytes: number;
  inspectedAt: string;
}

export interface NativeCacheClearResult {
  deletedBytes: number;
  deletedFiles: number;
}

export type NativeCacheCategory =
  | 'downloads'
  | 'staging'
  | 'network'
  | 'other'
  | 'all_native';

export type ICloudProgressEvent = {
  assetId: string;
  progress: number;
  phase: 'downloading_icloud' | 'hashing';
};

export type UploadProgressEvent = {
  uploadId: string;
  uploadedBytes: number;
  totalBytes: number;
};

interface NativeMyDriveMediaSyncShape {
  inspectAssets(assetIds: string[]): Promise<ICloudAssetInspection[]>;
  prepareOriginalAsset(
    assetId: string,
    allowNetwork: boolean,
  ): Promise<PreparedOriginalAsset>;
  cleanupPreparedFile(tempFilePath: string): Promise<void>;
  hashFileSha256(fileUri: string): Promise<{ sha256: string; sizeBytes: number }>;
  uploadFileChunked(options: UploadChunkedOptions): Promise<number>;
  downloadToLocalFile(
    url: string,
    filename: string,
    authToken: string | null,
  ): Promise<LocalDownloadResult>;
  clearSessionCookies(baseUrl: string): Promise<void>;
  getWifiSubnetInfo(): Promise<WifiSubnetInfo | null>;
  discoverLanServers(ports: number[] | null): Promise<NativeDiscoveredLanServer[]>;
  inspectLocalCaches(): Promise<NativeLocalCacheStats>;
  clearLocalCacheCategory(category: NativeCacheCategory): Promise<NativeCacheClearResult>;
  deleteCachedFile(filePath: string): Promise<NativeCacheClearResult>;
  pruneExpiredTempCache(
    maxAgeSeconds: number,
    includeSyncStaging: boolean,
  ): Promise<NativeCacheClearResult>;
}

type MediaSyncEventsMap = {
  onICloudDownloadProgress: (event: ICloudProgressEvent) => void;
  onUploadProgress: (event: UploadProgressEvent) => void;
};

const nativeModule =
  requireOptionalNativeModule<NativeMyDriveMediaSyncShape>('MyDriveMediaSync');

const emitter = nativeModule
  ? new EventEmitter<MediaSyncEventsMap>(
      nativeModule as unknown as EventEmitter<MediaSyncEventsMap>,
    )
  : null;

function requireNative(): NativeMyDriveMediaSyncShape {
  if (!nativeModule) {
    throw new Error(
      'MyDriveMediaSync native iOS module is unavailable in this runtime. Build the iOS development/release app with `npx expo prebuild --platform ios`.',
    );
  }
  return nativeModule;
}

export function isNativeMediaSyncAvailable(): boolean {
  return nativeModule != null;
}

export async function inspectAssets(
  assetIds: string[],
): Promise<ICloudAssetInspection[]> {
  return requireNative().inspectAssets(assetIds);
}

export async function prepareOriginalAsset(
  assetId: string,
  allowNetwork: boolean,
): Promise<PreparedOriginalAsset> {
  return requireNative().prepareOriginalAsset(assetId, allowNetwork);
}

export async function cleanupPreparedFile(tempFilePath: string): Promise<void> {
  if (!nativeModule) return;
  return nativeModule.cleanupPreparedFile(tempFilePath);
}

export async function hashFileSha256(
  fileUri: string,
): Promise<{ sha256: string; sizeBytes: number }> {
  return requireNative().hashFileSha256(fileUri);
}

export async function uploadFileChunked(
  options: UploadChunkedOptions,
): Promise<number> {
  return requireNative().uploadFileChunked(options);
}

export async function downloadToLocalFile(
  url: string,
  filename: string,
  authToken?: string | null,
): Promise<LocalDownloadResult> {
  return requireNative().downloadToLocalFile(url, filename, authToken ?? null);
}

export async function clearSessionCookies(baseUrl: string): Promise<void> {
  if (!nativeModule) return;
  return nativeModule.clearSessionCookies(baseUrl);
}

export async function getWifiSubnetInfo(): Promise<WifiSubnetInfo | null> {
  if (!nativeModule?.getWifiSubnetInfo) return null;
  return nativeModule.getWifiSubnetInfo();
}

export async function discoverLanServersNative(
  ports?: number[],
): Promise<NativeDiscoveredLanServer[]> {
  if (!nativeModule?.discoverLanServers) return [];
  return nativeModule.discoverLanServers(ports ?? null);
}

export async function inspectLocalCaches(): Promise<NativeLocalCacheStats | null> {
  if (!nativeModule?.inspectLocalCaches) return null;
  return nativeModule.inspectLocalCaches();
}

export async function clearLocalCacheCategory(
  category: NativeCacheCategory,
): Promise<NativeCacheClearResult> {
  if (!nativeModule?.clearLocalCacheCategory) {
    return { deletedBytes: 0, deletedFiles: 0 };
  }
  return nativeModule.clearLocalCacheCategory(category);
}

export async function deleteCachedFile(
  filePath: string,
): Promise<NativeCacheClearResult> {
  if (!nativeModule?.deleteCachedFile) {
    return { deletedBytes: 0, deletedFiles: 0 };
  }
  return nativeModule.deleteCachedFile(filePath);
}

export async function pruneExpiredTempCache(
  maxAgeSeconds: number,
  includeSyncStaging: boolean,
): Promise<NativeCacheClearResult> {
  if (!nativeModule?.pruneExpiredTempCache) {
    return { deletedBytes: 0, deletedFiles: 0 };
  }
  return nativeModule.pruneExpiredTempCache(maxAgeSeconds, includeSyncStaging);
}

export function addICloudProgressListener(
  listener: (event: ICloudProgressEvent) => void,
): { remove: () => void } {
  if (!emitter) {
    return { remove: () => {} };
  }
  return (emitter as unknown as {
    addListener: (
      eventName: string,
      cb: (event: ICloudProgressEvent) => void,
    ) => { remove: () => void };
  }).addListener('onICloudDownloadProgress', listener);
}

export function addUploadProgressListener(
  listener: (event: UploadProgressEvent) => void,
): { remove: () => void } {
  if (!emitter) {
    return { remove: () => {} };
  }
  return (emitter as unknown as {
    addListener: (
      eventName: string,
      cb: (event: UploadProgressEvent) => void,
    ) => { remove: () => void };
  }).addListener('onUploadProgress', listener);
}
