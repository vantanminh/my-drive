import * as SecureStore from 'expo-secure-store';
import * as Device from 'expo-device';

import {
  DEFAULT_CACHE_HISTORY,
  DEFAULT_CACHE_SETTINGS,
  normalizeCacheHistory,
  normalizeCacheSettings,
} from './cacheManager';
import type { CacheSettings, CacheStatsHistory } from './cacheTypes';
import type { SyncSettings } from '../types/mydrive';

const KEYS = {
  serverUrl: 'mydrive_server_url',
  lanUrl: 'mydrive_lan_url',
  autoSwitchLan: 'mydrive_auto_switch_lan',
  serverId: 'mydrive_server_id',
  userEmail: 'mydrive_user_email',
  csrfToken: 'mydrive_csrf_token',
  sessionToken: 'mydrive_session_token',
  allowHttpForUrl: 'mydrive_allow_http_url',
  syncSettings: 'mydrive_sync_settings',
  shareUrls: 'mydrive_share_urls_v1',
  cacheSettings: 'mydrive_cache_settings_v1',
  cacheHistory: 'mydrive_cache_history_v1',
} as const;

interface StoredShareUrlRecord {
  serverUrl: string;
  shareId: string;
  url: string;
  createdAt: string;
}

const MAX_REMEMBERED_SHARE_URLS = 40;

export interface PersistedSession {
  serverUrl: string | null;
  lanUrl: string | null;
  autoSwitchLan: boolean;
  serverId: string | null;
  userEmail: string | null;
  csrfToken: string | null;
  sessionToken: string | null;
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
  const [
    serverUrl,
    lanUrl,
    autoSwitchRaw,
    serverId,
    userEmail,
    csrfToken,
    sessionToken,
    allowHttpForUrl,
  ] = await Promise.all([
    SecureStore.getItemAsync(KEYS.serverUrl),
    SecureStore.getItemAsync(KEYS.lanUrl),
    SecureStore.getItemAsync(KEYS.autoSwitchLan),
    SecureStore.getItemAsync(KEYS.serverId),
    SecureStore.getItemAsync(KEYS.userEmail),
    SecureStore.getItemAsync(KEYS.csrfToken),
    SecureStore.getItemAsync(KEYS.sessionToken),
    SecureStore.getItemAsync(KEYS.allowHttpForUrl),
  ]);
  return {
    serverUrl,
    lanUrl,
    autoSwitchLan: autoSwitchRaw !== 'false',
    serverId,
    userEmail,
    csrfToken,
    sessionToken,
    allowHttpForUrl,
  };
}

export async function saveServerConfig(serverUrl: string, allowHttpUrl: string | null): Promise<void> {
  await SecureStore.setItemAsync(KEYS.serverUrl, serverUrl);
  if (allowHttpUrl) {
    await SecureStore.setItemAsync(KEYS.allowHttpForUrl, allowHttpUrl);
  } else {
    await SecureStore.deleteItemAsync(KEYS.allowHttpForUrl);
  }
}

export async function saveLanConfig(params: {
  lanUrl?: string | null;
  autoSwitchLan?: boolean;
  serverId?: string | null;
}): Promise<void> {
  const ops: Promise<void>[] = [];
  if (params.lanUrl !== undefined) {
    ops.push(
      params.lanUrl
        ? SecureStore.setItemAsync(KEYS.lanUrl, params.lanUrl)
        : SecureStore.deleteItemAsync(KEYS.lanUrl),
    );
  }
  if (params.autoSwitchLan !== undefined) {
    ops.push(
      SecureStore.setItemAsync(KEYS.autoSwitchLan, params.autoSwitchLan ? 'true' : 'false'),
    );
  }
  if (params.serverId !== undefined) {
    ops.push(
      params.serverId
        ? SecureStore.setItemAsync(KEYS.serverId, params.serverId)
        : SecureStore.deleteItemAsync(KEYS.serverId),
    );
  }
  await Promise.all(ops);
}

export async function saveAuthCredentials(
  userEmail: string,
  csrfToken: string | null,
  sessionToken?: string | null,
): Promise<void> {
  await SecureStore.setItemAsync(KEYS.userEmail, userEmail);
  if (csrfToken) {
    await SecureStore.setItemAsync(KEYS.csrfToken, csrfToken);
  } else {
    await SecureStore.deleteItemAsync(KEYS.csrfToken);
  }
  if (sessionToken !== undefined) {
    if (sessionToken) {
      await SecureStore.setItemAsync(KEYS.sessionToken, sessionToken);
    } else {
      await SecureStore.deleteItemAsync(KEYS.sessionToken);
    }
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
    SecureStore.deleteItemAsync(KEYS.sessionToken),
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

async function readAllShareUrlRecords(): Promise<StoredShareUrlRecord[]> {
  try {
    const raw = await SecureStore.getItemAsync(KEYS.shareUrls);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is StoredShareUrlRecord =>
        Boolean(item) &&
        typeof item.serverUrl === 'string' &&
        typeof item.shareId === 'string' &&
        typeof item.url === 'string' &&
        typeof item.createdAt === 'string',
    );
  } catch {
    return [];
  }
}

export async function loadRememberedShareUrls(
  serverUrl: string,
): Promise<Record<string, string>> {
  const normalized = serverUrl.replace(/\/+$/, '');
  const records = await readAllShareUrlRecords();
  const map: Record<string, string> = {};
  for (const record of records) {
    if (record.serverUrl === normalized) {
      map[record.shareId] = record.url;
    }
  }
  return map;
}

export async function rememberShareUrl(
  serverUrl: string,
  shareId: string,
  url: string,
): Promise<void> {
  const normalized = serverUrl.replace(/\/+$/, '');
  const existing = await readAllShareUrlRecords();
  const filtered = existing.filter(
    (item) => !(item.serverUrl === normalized && item.shareId === shareId),
  );
  const next: StoredShareUrlRecord[] = [
    {
      serverUrl: normalized,
      shareId,
      url,
      createdAt: new Date().toISOString(),
    },
    ...filtered,
  ].slice(0, MAX_REMEMBERED_SHARE_URLS);
  try {
    await SecureStore.setItemAsync(KEYS.shareUrls, JSON.stringify(next));
  } catch {
    // Keychain storage errors must not block sharing flows.
  }
}

export async function forgetRememberedShareUrls(
  serverUrl: string,
  shareIds: string[],
): Promise<void> {
  if (shareIds.length === 0) return;
  const normalized = serverUrl.replace(/\/+$/, '');
  const drop = new Set(shareIds);
  const existing = await readAllShareUrlRecords();
  const next = existing.filter(
    (item) => !(item.serverUrl === normalized && drop.has(item.shareId)),
  );
  if (next.length === existing.length) return;
  try {
    await SecureStore.setItemAsync(KEYS.shareUrls, JSON.stringify(next));
  } catch {
    // Ignore non-critical cleanup failure.
  }
}

export async function loadCacheSettings(): Promise<CacheSettings> {
  try {
    const raw = await SecureStore.getItemAsync(KEYS.cacheSettings);
    if (!raw) return { ...DEFAULT_CACHE_SETTINGS };
    return normalizeCacheSettings(JSON.parse(raw) as Partial<CacheSettings>);
  } catch {
    return { ...DEFAULT_CACHE_SETTINGS };
  }
}

export async function saveCacheSettings(settings: CacheSettings): Promise<void> {
  const normalized = normalizeCacheSettings(settings);
  await SecureStore.setItemAsync(KEYS.cacheSettings, JSON.stringify(normalized));
}

export async function loadCacheHistory(): Promise<CacheStatsHistory> {
  try {
    const raw = await SecureStore.getItemAsync(KEYS.cacheHistory);
    if (!raw) return { ...DEFAULT_CACHE_HISTORY };
    return normalizeCacheHistory(JSON.parse(raw) as Partial<CacheStatsHistory>);
  } catch {
    return { ...DEFAULT_CACHE_HISTORY };
  }
}

export async function saveCacheHistory(history: CacheStatsHistory): Promise<void> {
  const normalized = normalizeCacheHistory(history);
  try {
    await SecureStore.setItemAsync(KEYS.cacheHistory, JSON.stringify(normalized));
  } catch {
    // Non-critical stats persistence failure must not block cache clearing.
  }
}
