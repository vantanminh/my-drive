import * as SecureStore from 'expo-secure-store';
import * as Device from 'expo-device';

import type { SyncSettings } from '../types/mydrive';

const KEYS = {
  serverUrl: 'mydrive_server_url',
  userEmail: 'mydrive_user_email',
  csrfToken: 'mydrive_csrf_token',
  allowHttpForUrl: 'mydrive_allow_http_url',
  syncSettings: 'mydrive_sync_settings',
} as const;

export interface PersistedSession {
  serverUrl: string | null;
  userEmail: string | null;
  csrfToken: string | null;
  allowHttpForUrl: string | null;
}

export function defaultBackupFolderName(): string {
  const rawName = Device.deviceName?.trim() || 'iPhone';
  const safeName = rawName.replace(/[/\\:*?"<>|]/g, '-').replace(/\s+/g, ' ').trim();
  return `Photos/${safeName || 'iPhone'}`;
}

export function defaultSyncSettings(): SyncSettings {
  return {
    autoBackgroundSync: true,
    wifiOnlySync: true,
    downloadICloudOverCellular: false,
    includeVideos: true,
    destinationFolder: defaultBackupFolderName(),
  };
}

export async function loadPersistedSession(): Promise<PersistedSession> {
  const [serverUrl, userEmail, csrfToken, allowHttpForUrl] = await Promise.all([
    SecureStore.getItemAsync(KEYS.serverUrl),
    SecureStore.getItemAsync(KEYS.userEmail),
    SecureStore.getItemAsync(KEYS.csrfToken),
    SecureStore.getItemAsync(KEYS.allowHttpForUrl),
  ]);
  return { serverUrl, userEmail, csrfToken, allowHttpForUrl };
}

export async function saveServerConfig(serverUrl: string, allowHttpUrl: string | null): Promise<void> {
  await SecureStore.setItemAsync(KEYS.serverUrl, serverUrl);
  if (allowHttpUrl) {
    await SecureStore.setItemAsync(KEYS.allowHttpForUrl, allowHttpUrl);
  } else {
    await SecureStore.deleteItemAsync(KEYS.allowHttpForUrl);
  }
}

export async function saveAuthCredentials(userEmail: string, csrfToken: string | null): Promise<void> {
  await SecureStore.setItemAsync(KEYS.userEmail, userEmail);
  if (csrfToken) {
    await SecureStore.setItemAsync(KEYS.csrfToken, csrfToken);
  } else {
    await SecureStore.deleteItemAsync(KEYS.csrfToken);
  }
}

export async function saveCsrfToken(csrfToken: string | null): Promise<void> {
  if (csrfToken) {
    await SecureStore.setItemAsync(KEYS.csrfToken, csrfToken);
  } else {
    await SecureStore.deleteItemAsync(KEYS.csrfToken);
  }
}

export async function clearAuthCredentials(): Promise<void> {
  await Promise.all([
    SecureStore.deleteItemAsync(KEYS.csrfToken),
  ]);
}

export async function loadSyncSettings(): Promise<SyncSettings> {
  const raw = await SecureStore.getItemAsync(KEYS.syncSettings);
  const fallback = defaultSyncSettings();
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw) as Partial<SyncSettings>;
    return {
      autoBackgroundSync:
        typeof parsed.autoBackgroundSync === 'boolean'
          ? parsed.autoBackgroundSync
          : fallback.autoBackgroundSync,
      wifiOnlySync:
        typeof parsed.wifiOnlySync === 'boolean'
          ? parsed.wifiOnlySync
          : fallback.wifiOnlySync,
      downloadICloudOverCellular:
        typeof parsed.downloadICloudOverCellular === 'boolean'
          ? parsed.downloadICloudOverCellular
          : fallback.downloadICloudOverCellular,
      includeVideos:
        typeof parsed.includeVideos === 'boolean'
          ? parsed.includeVideos
          : fallback.includeVideos,
      destinationFolder:
        typeof parsed.destinationFolder === 'string' && parsed.destinationFolder.trim()
          ? parsed.destinationFolder.trim()
          : fallback.destinationFolder,
    };
  } catch {
    return fallback;
  }
}

export async function saveSyncSettings(settings: SyncSettings): Promise<void> {
  await SecureStore.setItemAsync(KEYS.syncSettings, JSON.stringify(settings));
}
