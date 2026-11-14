import type {
  ICloudAssetInspection,
  PreparedOriginalAsset,
} from '../../modules/mydrive-media-sync/src';
import type { MyDriveClient } from './apiClient';
import type { SyncLedgerStore } from './syncLedger';
import { type ChunkUploader, uploadPreparedFile } from './uploadWorkflow';
import type { SyncProgressSnapshot, SyncSettings } from '../types/mydrive';

export interface MediaAssetSummary {
  id: string;
  filename: string;
  mediaType: 'photo' | 'video' | 'audio' | 'unknown';
  creationTime: number;
  modificationTime: number;
  width: number;
  height: number;
  duration: number;
}

export interface MediaPageQuery {
  first: number;
  after?: string;
  mediaType: ('photo' | 'video')[];
}

export interface MediaPageResult {
  assets: MediaAssetSummary[];
  hasNextPage: boolean;
  endCursor?: string;
}

export interface NetworkStatusSnapshot {
  isConnected: boolean;
  isWifiOrEthernet: boolean;
}

export interface PhotoSyncPlatformDeps {
  getNetworkStatus(): Promise<NetworkStatusSnapshot>;
  getPermissionStatus(): Promise<'granted' | 'limited' | 'denied' | 'undetermined'>;
  getAssetsPage(query: MediaPageQuery): Promise<MediaPageResult>;
  inspectAssets(assetIds: string[]): Promise<ICloudAssetInspection[]>;
  prepareOriginalAsset(assetId: string, allowNetwork: boolean): Promise<PreparedOriginalAsset>;
  cleanupPreparedFile(tempFilePath: string): Promise<void>;
  subscribeICloudProgress?(
    listener: (event: { assetId: string; progress: number; phase: 'downloading_icloud' | 'hashing' }) => void,
  ): { remove: () => void };
  uploadChunks?: ChunkUploader;
}

export interface SyncRunOptions {
  settings: SyncSettings;
  forceReverify?: boolean;
  maxAssetsPerRun?: number;
  onProgress?: (snapshot: SyncProgressSnapshot) => void;
  signal?: AbortSignal;
}

export function initialSyncSnapshot(): SyncProgressSnapshot {
  return {
    running: false,
    phase: 'idle',
    currentFilename: null,
    currentInICloud: false,
    currentProgress: 0,
    totalDiscovered: 0,
    processedCount: 0,
    uploadedCount: 0,
    dedupedCount: 0,
    skippedCount: 0,
    icloudOriginalsDownloaded: 0,
    icloudWaitingWifiCount: 0,
    failedCount: 0,
    lastRunAt: null,
    lastError: null,
  };
}

function isErrorCode(error: unknown, expectedCode: string): boolean {
  if (!error || typeof error !== 'object') return false;
  const record = error as { code?: unknown; message?: unknown };
  if (record.code === expectedCode) return true;
  return typeof record.message === 'string' && record.message.includes(expectedCode);
}

function errorMessageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export class PhotoSyncEngine {
  constructor(
    private readonly client: MyDriveClient,
    private readonly ledger: SyncLedgerStore,
    private readonly deps: PhotoSyncPlatformDeps,
  ) {}

  async run(options: SyncRunOptions): Promise<SyncProgressSnapshot> {
    const state = initialSyncSnapshot();
    const emit = () => options.onProgress?.({ ...state });
    const serverUrl = this.client.getBaseUrl();

    const permission = await this.deps.getPermissionStatus();
    if (permission !== 'granted' && permission !== 'limited') {
      throw new Error('Photo Library permission is required to sync photos.');
    }

    const net = await this.deps.getNetworkStatus();
    if (!net.isConnected) {
      throw new Error('No internet connection. Connect to Wi-Fi or cellular data to sync.');
    }
    if (options.settings.wifiOnlySync && !net.isWifiOrEthernet) {
      throw new Error('Wi-Fi-only sync is enabled. Connect to Wi-Fi or allow cellular sync in Sync Settings.');
    }

    state.running = true;
    state.phase = 'scanning';
    emit();

    const targetFolderPath = options.settings.destinationFolder.trim() || 'Photos/iPhone';
    const { id: destinationParentId } = await this.client.ensureBackupFolder(targetFolderPath);

    const mediaTypes: ('photo' | 'video')[] = options.settings.includeVideos
      ? ['photo', 'video']
      : ['photo'];

    const maxAssets = options.maxAssetsPerRun ?? Number.POSITIVE_INFINITY;
    const candidates: MediaAssetSummary[] = [];
    let after: string | undefined;
    let hasNext = true;

    while (hasNext && candidates.length < maxAssets) {
      if (options.signal?.aborted) {
        state.running = false;
        state.phase = 'cancelled';
        emit();
        return state;
      }
      const page = await this.deps.getAssetsPage({
        first: Math.min(50, maxAssets - candidates.length),
        after,
        mediaType: mediaTypes,
      });
      for (const asset of page.assets) {
        if (asset.mediaType !== 'photo' && asset.mediaType !== 'video') continue;
        candidates.push(asset);
        if (candidates.length >= maxAssets) break;
      }
      hasNext = page.hasNextPage && Boolean(page.endCursor);
      after = page.endCursor;
    }

    state.totalDiscovered = candidates.length;
    emit();

    const toProcess: MediaAssetSummary[] = [];
    for (const asset of candidates) {
      if (!options.forceReverify) {
        const existing = await this.ledger.get(serverUrl, asset.id);
        const alreadyDone =
          existing &&
          (existing.status === 'synced' || existing.status === 'deduplicated') &&
          Math.round(existing.modification_time_ms) === Math.round(asset.modificationTime);
        if (alreadyDone) {
          state.skippedCount += 1;
          state.processedCount += 1;
          continue;
        }
      }
      toProcess.push(asset);
    }
    emit();

    if (toProcess.length === 0) {
      state.running = false;
      state.phase = 'completed';
      state.lastRunAt = new Date().toISOString();
      emit();
      return state;
    }

    const allowICloudDownload =
      net.isWifiOrEthernet || options.settings.downloadICloudOverCellular;
    const chunkUploader: ChunkUploader =
      this.deps.uploadChunks ??
      (async () => {
        throw new Error('No chunk uploader configured for photo sync run.');
      });

    const BATCH_SIZE = 25;
    for (let i = 0; i < toProcess.length; i += BATCH_SIZE) {
      if (options.signal?.aborted) {
        state.running = false;
        state.phase = 'cancelled';
        emit();
        return state;
      }

      const batch = toProcess.slice(i, i + BATCH_SIZE);
      state.phase = 'inspecting_icloud';
      emit();

      const inspections = await this.deps.inspectAssets(batch.map((a) => a.id));
      const inspectionById = new Map(inspections.map((item) => [item.assetId, item]));

      for (const asset of batch) {
        if (options.signal?.aborted) {
          state.running = false;
          state.phase = 'cancelled';
          emit();
          return state;
        }

        const inspection = inspectionById.get(asset.id);
        const mediaType: 'image' | 'video' =
          asset.mediaType === 'video' ? 'video' : 'image';
        const displayName = inspection?.originalFilename || asset.filename;
        const inICloud = inspection?.inICloud ?? false;

        state.currentFilename = displayName;
        state.currentInICloud = inICloud;
        state.currentProgress = 0;
        emit();

        if (inICloud && !allowICloudDownload) {
          state.icloudWaitingWifiCount += 1;
          state.processedCount += 1;
          await this.ledger.upsert({
            asset_id: asset.id,
            server_url: serverUrl,
            filename: displayName,
            media_type: mediaType,
            size_bytes: 0,
            sha256: null,
            remote_file_id: null,
            modification_time_ms: asset.modificationTime,
            was_in_icloud: true,
            status: 'icloud_waiting_wifi',
            last_error: 'Original photo is in iCloud; awaiting Wi-Fi.',
            synced_at: new Date().toISOString(),
          });
          emit();
          continue;
        }

        let prepared: PreparedOriginalAsset | null = null;
        const progressSub = this.deps.subscribeICloudProgress?.((ev) => {
          if (ev.assetId !== asset.id) return;
          state.phase = ev.phase === 'hashing' ? 'hashing' : 'downloading_icloud';
          state.currentProgress = ev.progress;
          emit();
        });

        try {
          state.phase = inICloud ? 'downloading_icloud' : 'hashing';
          emit();

          prepared = await this.deps.prepareOriginalAsset(asset.id, allowICloudDownload);
          if (prepared.downloadedFromICloud) {
            state.icloudOriginalsDownloaded += 1;
          }

          state.phase = 'uploading';
          state.currentFilename = prepared.filename;
          state.currentProgress = 0;
          emit();

          const modifiedIso =
            prepared.modificationDateIso ??
            (asset.modificationTime > 0
              ? new Date(asset.modificationTime).toISOString()
              : null);

          const result = await uploadPreparedFile({
            client: this.client,
            uploadChunks: chunkUploader,
            parentId: destinationParentId,
            filename: prepared.filename,
            fileUri: prepared.tempFileUri,
            sizeBytes: prepared.sizeBytes,
            sha256: prepared.sha256,
            modifiedAtIso: modifiedIso,
            onProgress: (uploaded, total) => {
              state.currentProgress = total > 0 ? Math.min(1, uploaded / total) : 1;
              emit();
            },
          });

          if (result.mode === 'uploaded') {
            state.uploadedCount += 1;
          } else if (result.mode === 'deduplicated') {
            state.dedupedCount += 1;
          } else {
            state.skippedCount += 1;
          }

          await this.ledger.upsert({
            asset_id: asset.id,
            server_url: serverUrl,
            filename: prepared.filename,
            media_type: mediaType,
            size_bytes: prepared.sizeBytes,
            sha256: prepared.sha256,
            remote_file_id: result.fileId,
            modification_time_ms: asset.modificationTime,
            was_in_icloud: prepared.downloadedFromICloud,
            status: result.mode === 'deduplicated' ? 'deduplicated' : 'synced',
            last_error: null,
            synced_at: new Date().toISOString(),
          });
        } catch (error) {
          if (isErrorCode(error, 'ICLOUD_NETWORK_REQUIRED')) {
            state.icloudWaitingWifiCount += 1;
            await this.ledger.upsert({
              asset_id: asset.id,
              server_url: serverUrl,
              filename: displayName,
              media_type: mediaType,
              size_bytes: 0,
              sha256: null,
              remote_file_id: null,
              modification_time_ms: asset.modificationTime,
              was_in_icloud: true,
              status: 'icloud_waiting_wifi',
              last_error: 'Original asset requires iCloud network download.',
              synced_at: new Date().toISOString(),
            });
          } else {
            state.failedCount += 1;
            const msg = errorMessageOf(error);
            state.lastError = `${displayName}: ${msg}`;
            await this.ledger.upsert({
              asset_id: asset.id,
              server_url: serverUrl,
              filename: displayName,
              media_type: mediaType,
              size_bytes: prepared?.sizeBytes ?? 0,
              sha256: prepared?.sha256 ?? null,
              remote_file_id: null,
              modification_time_ms: asset.modificationTime,
              was_in_icloud: inICloud,
              status: 'error',
              last_error: msg,
              synced_at: new Date().toISOString(),
            });
          }
        } finally {
          progressSub?.remove();
          if (prepared?.tempFilePath) {
            await this.deps.cleanupPreparedFile(prepared.tempFilePath).catch(() => {});
          }
          state.processedCount += 1;
          emit();
        }
      }
    }

    state.running = false;
    state.phase = 'completed';
    state.currentFilename = null;
    state.currentProgress = 1;
    state.lastRunAt = new Date().toISOString();
    emit();
    return state;
  }
}
