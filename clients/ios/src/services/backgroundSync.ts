import * as BackgroundTask from 'expo-background-task';
import * as MediaLibrary from 'expo-media-library';
import * as Network from 'expo-network';
import * as TaskManager from 'expo-task-manager';

import {
  addICloudProgressListener,
  cleanupPreparedFile,
  inspectAssets,
  isNativeMediaSyncAvailable,
  prepareOriginalAsset,
} from '../../modules/mydrive-media-sync/src';
import { MyDriveClient } from './apiClient';
import { createNativeChunkUploader } from './fileUpload';
import { selectActiveEndpoint } from './lanDiscovery';
import {
  PhotoSyncEngine,
  type PhotoSyncPlatformDeps,
} from './photoSyncEngine';
import { loadPersistedSession, loadSyncSettings } from './secureStorage';
import { SqliteSyncLedgerStore } from './syncDatabase';

export const BACKGROUND_PHOTO_SYNC_TASK = 'com.mydrive.ios.photo-sync';

export function createIosPhotoSyncDeps(client: MyDriveClient): PhotoSyncPlatformDeps {
  return {
    async getNetworkStatus() {
      const state = await Network.getNetworkStateAsync();
      const isConnected = Boolean(state.isConnected);
      const isWifiOrEthernet =
        state.type === Network.NetworkStateType.WIFI ||
        state.type === Network.NetworkStateType.ETHERNET;
      return { isConnected, isWifiOrEthernet };
    },
    async getPermissionStatus() {
      const perms = await MediaLibrary.getPermissionsAsync();
      if (perms.granted) {
        return perms.accessPrivileges === 'limited' ? 'limited' : 'granted';
      }
      if (!perms.canAskAgain) return 'denied';
      return 'undetermined';
    },
    async getAssetsPage(query) {
      const offset = query.after ? Number.parseInt(query.after, 10) || 0 : 0;
      const mediaTypes = query.mediaType.map((type) =>
        type === 'video'
          ? MediaLibrary.MediaType.VIDEO
          : MediaLibrary.MediaType.IMAGE,
      );

      let assetQuery = new MediaLibrary.Query()
        .orderBy({ key: MediaLibrary.AssetField.CREATION_TIME, ascending: false })
        .offset(offset)
        .limit(query.first + 1);

      if (mediaTypes.length === 1) {
        assetQuery = assetQuery.eq(
          MediaLibrary.AssetField.MEDIA_TYPE,
          mediaTypes[0],
        );
      } else if (mediaTypes.length > 1) {
        assetQuery = assetQuery.within(
          MediaLibrary.AssetField.MEDIA_TYPE,
          mediaTypes,
        );
      }

      const metadataList = await assetQuery.exeForMetadata();
      const hasNextPage = metadataList.length > query.first;
      const pageItems = hasNextPage
        ? metadataList.slice(0, query.first)
        : metadataList;

      return {
        assets: pageItems.map((asset) => ({
          id: asset.id,
          filename: asset.filename ?? `asset_${asset.id.slice(-8)}`,
          mediaType:
            asset.mediaType === MediaLibrary.MediaType.VIDEO
              ? 'video'
              : asset.mediaType === MediaLibrary.MediaType.IMAGE
                ? 'photo'
                : 'unknown',
          creationTime: asset.creationTime ?? 0,
          modificationTime: asset.modificationTime ?? asset.creationTime ?? 0,
          width: asset.width ?? 0,
          height: asset.height ?? 0,
          duration: asset.duration ? asset.duration / 1000 : 0,
        })),
        hasNextPage,
        endCursor: hasNextPage ? String(offset + pageItems.length) : undefined,
      };
    },
    inspectAssets,
    prepareOriginalAsset,
    cleanupPreparedFile,
    subscribeICloudProgress: addICloudProgressListener,
    uploadChunks: createNativeChunkUploader(client),
  };
}

let taskDefined = false;

export function ensureBackgroundSyncTaskDefined(): void {
  if (taskDefined || !isNativeMediaSyncAvailable()) return;
  taskDefined = true;

  TaskManager.defineTask(BACKGROUND_PHOTO_SYNC_TASK, async () => {
    try {
      const [session, settings] = await Promise.all([
        loadPersistedSession(),
        loadSyncSettings(),
      ]);
      if (!session.serverUrl || !settings.autoBackgroundSync) {
        return BackgroundTask.BackgroundTaskResult.Success;
      }

      const netState = await Network.getNetworkStateAsync();
      const isWifiOrEthernet =
        netState.type === Network.NetworkStateType.WIFI ||
        netState.type === Network.NetworkStateType.ETHERNET;
      const endpoint = await selectActiveEndpoint({
        primaryUrl: session.serverUrl,
        pairedLanUrl: session.lanUrl,
        autoSwitchLan: session.autoSwitchLan,
        expectedServerId: session.serverId,
        isConnected: Boolean(netState.isConnected),
        isWifiOrEthernet,
      });

      const client = new MyDriveClient({
        baseUrl: endpoint.activeUrl,
        csrfToken: session.csrfToken,
        sessionToken: session.sessionToken,
      });

      // Confirm session is still active before scanning Photo Library.
      await client.me();

      const engine = new PhotoSyncEngine(
        client,
        new SqliteSyncLedgerStore(),
        createIosPhotoSyncDeps(client),
      );

      // Process bounded batch per background wakeup so iOS BGTask budget isn't exceeded.
      await engine.run({
        settings,
        ledgerServerUrl: session.serverUrl,
        maxAssetsPerRun: 25,
      });
      return BackgroundTask.BackgroundTaskResult.Success;
    } catch {
      return BackgroundTask.BackgroundTaskResult.Failed;
    }
  });
}

export async function syncBackgroundTaskRegistration(enabled: boolean): Promise<void> {
  if (!isNativeMediaSyncAvailable()) return;
  try {
    ensureBackgroundSyncTaskDefined();
    const isRegistered = await TaskManager.isTaskRegisteredAsync(
      BACKGROUND_PHOTO_SYNC_TASK,
    );
    if (enabled && !isRegistered) {
      await BackgroundTask.registerTaskAsync(BACKGROUND_PHOTO_SYNC_TASK, {
        minimumInterval: 30,
      });
    } else if (!enabled && isRegistered) {
      await BackgroundTask.unregisterTaskAsync(BACKGROUND_PHOTO_SYNC_TASK);
    }
  } catch {
    // Background task APIs may be restricted on simulator or low-power mode.
  }
}
