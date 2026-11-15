export interface User {
  id: string;
  email: string;
  role: string;
  must_change_password: boolean;
}

export interface LoginResponse {
  user: User;
  csrf_token: string;
  session_token?: string | null;
}

export interface ServerCapabilities {
  product: string;
  apiVersion: string;
  serverVersion: string;
  serverId?: string | null;
  minClientApi?: string;
  maxClientApi?: string;
  features: {
    chunkedUpload: boolean;
    resumableUpload: boolean;
    deduplication: boolean;
    fileVersions: boolean;
    deviceAuthorization: boolean;
    contentHash: string;
  };
  upload?: {
    protocol?: string;
    maxChunkBytes?: number;
  };
}

export type LanConnectionMode = 'lan' | 'remote' | 'checking' | 'offline';

export interface LanConnectionStatus {
  mode: LanConnectionMode;
  isOnLan: boolean;
  activeUrl: string | null;
  primaryUrl: string | null;
  pairedLanUrl: string | null;
  autoSwitchLan: boolean;
  latencyMs: number | null;
  localIp: string | null;
  serverId: string | null;
  lastCheckedAt: string | null;
}

export interface DiscoveredLanServer {
  url: string;
  host: string;
  port: number;
  scheme: 'http' | 'https';
  serverId: string | null;
  serverVersion: string | null;
  latencyMs: number;
  matchedServerId: boolean;
  source: 'probe' | 'subnet';
}

export interface ServerProbeResult {
  normalizedUrl: string;
  isInsecureHttp: boolean;
  liveOk: boolean;
  capabilities: ServerCapabilities | null;
}

export interface Entry {
  id: string;
  parent_id: string | null;
  kind: 'file' | 'folder';
  name: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  size_bytes: number | null;
  mime_detected: string | null;
  category?: string | null;
  folder_bytes?: number | null;
  folder_file_count?: number | null;
  folder_subfolder_count?: number | null;
  system_role?: 'photos' | null;
}

export interface EntryPage {
  entries: Entry[];
  limit: number;
  next_offset: number | null;
}

export interface Breadcrumb {
  id: string;
  name: string;
}

export interface FolderAnalytics {
  total_bytes: number;
  file_count: number;
  subfolder_count: number;
  by_category: Record<string, number>;
}

export interface EntryDetails {
  id: string;
  parent_id: string | null;
  kind: 'file' | 'folder';
  name: string;
  mime_type: string | null;
  category: string;
  size_bytes: number;
  created_at: string;
  updated_at: string;
  location: string;
  breadcrumbs: Breadcrumb[];
  media: {
    width?: number | null;
    height?: number | null;
    taken_at?: string | null;
    duration_seconds?: number | null;
  };
  folder: FolderAnalytics | null;
}

export interface MediaItem {
  id: string;
  name: string;
  mime_type: string | null;
  category: string;
  size_bytes: number;
  created_at: string;
  updated_at: string;
  media: {
    width?: number | null;
    height?: number | null;
    taken_at?: string | null;
    duration_seconds?: number | null;
  };
}

export interface PhotoPage {
  items: MediaItem[];
  limit: number;
  next_cursor: string | null;
}

export interface Album {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
  item_count: number;
  cover_file_id: string | null;
}

export interface AlbumItemPage {
  items: MediaItem[];
  limit: number;
  next_offset: number | null;
}

export interface CategoryUsage {
  category: string;
  file_count: number;
  size_bytes: number;
}

export interface LargestFile {
  id: string;
  name: string;
  size_bytes: number;
  category: string;
  mime_type: string | null;
}

export interface AccountStorage {
  quota_bytes: number | null;
  used_bytes: number;
  reserved_bytes: number;
  available_bytes: number | null;
  percent_used: number | null;
  unlimited: boolean;
  trash_count?: number;
  trash_bytes?: number;
  by_category: CategoryUsage[];
  largest_files?: LargestFile[];
}

export interface VolumeStatus {
  total_bytes: number;
  used_bytes: number;
  free_bytes: number;
  percent_used: number;
}

export interface UserStorage {
  id: string;
  email: string;
  role: string;
  quota_bytes: number | null;
  used_bytes: number;
  percent_of_library: number;
  percent_of_hdd: number | null;
}

export interface ServerStorage {
  ssd: VolumeStatus | null;
  hdd: VolumeStatus | null;
  same_volume: boolean;
  system_used_bytes: number;
  library_bytes: number;
  trash_count?: number;
  trash_bytes?: number;
  by_category: CategoryUsage[];
  largest_files?: LargestFile[];
  users: UserStorage[];
}

export interface ManagedAccount {
  id: string;
  email: string;
  quotaBytes: number;
  usedBytes: number;
  reservedBytes: number;
  disabledAt: string | null;
  createdAt: string;
}

export interface ManagedAccountPage {
  accounts: ManagedAccount[];
  nextOffset: number | null;
}

export type ShareResourceType = 'file' | 'folder' | 'album';

export interface CreateShareInput {
  resource_type: ShareResourceType;
  resource_id: string;
  expires_at: string | null;
  password: string | null;
  allow_download: boolean;
  max_downloads: number | null;
}

export interface UpdateShareInput {
  expires_at?: string | null;
  password?: string | null;
  allow_download?: boolean;
  max_downloads?: number | null;
}

export interface CreatedShare {
  id: string;
  resource_type: ShareResourceType;
  resource_id: string;
  share_url: string;
  expires_at: string | null;
  password_protected: boolean;
  allow_download: boolean;
  max_downloads: number | null;
}

export interface ShareSummary {
  created_by_api_key_id?: string | null;
  id: string;
  resource_type: ShareResourceType;
  resource_id: string;
  resource_name: string;
  expires_at: string | null;
  revoked_at: string | null;
  password_protected: boolean;
  allow_download: boolean;
  max_downloads: number | null;
  download_count: number;
  created_at: string;
  last_accessed_at: string | null;
}

export interface ShareList {
  shares: ShareSummary[];
  next_offset: number | null;
}

export interface FaceCluster {
  id: string;
  label: string | null;
  faceCount: number;
  assetCount: number;
  representativeFileId: string | null;
  representativeBoxLeft: number | null;
  representativeBoxTop: number | null;
  representativeBoxWidth: number | null;
  representativeBoxHeight: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface FaceClusterPage {
  clusters: FaceCluster[];
  limit: number;
  nextOffset: number | null;
}

export interface MediaPage {
  items: MediaItem[];
  limit: number;
  next_cursor?: string | null;
  next_offset?: number | null;
}

export interface BrowserSession {
  id: string;
  created_at: string;
  last_seen_at: string | null;
  expires_at: string;
  is_current: boolean;
}

export interface BackupDevice {
  id: string;
  name: string;
  client_name: string;
  operating_system: string;
  client_version: string;
  permissions: string[];
  created_at: string;
  last_active_at: string | null;
  last_ip: string | null;
  revoked_at: string | null;
}

export interface BackupCheckResponse {
  action: 'skip' | 'link' | 'upload';
  file_id: string | null;
  version_id: string | null;
  remote_checksum: string | null;
  reusable: boolean;
}

export interface BackupLinkResponse {
  file_id: string;
  version_id: string;
  checksum_sha256: string;
  deduplicated: boolean;
  unchanged: boolean;
}

export interface UploadCreated {
  id: string;
  offset: number;
  length: number;
}

export interface UploadFinalized {
  file_id: string;
  status: string;
  version_id?: string | null;
  checksum_sha256?: string | null;
}

export interface SyncSettings {
  autoBackgroundSync: boolean;
  wifiOnlySync: boolean;
  downloadICloudOverCellular: boolean;
  includeVideos: boolean;
  destinationFolder: string;
}

export type SyncLedgerStatus =
  | 'synced'
  | 'deduplicated'
  | 'icloud_waiting_wifi'
  | 'error';

export interface SyncLedgerRecord {
  asset_id: string;
  server_url: string;
  filename: string;
  media_type: 'image' | 'video';
  size_bytes: number;
  sha256: string | null;
  remote_file_id: string | null;
  modification_time_ms: number;
  was_in_icloud: boolean;
  status: SyncLedgerStatus;
  last_error: string | null;
  synced_at: string;
}

export interface SyncProgressSnapshot {
  running: boolean;
  phase:
    | 'idle'
    | 'scanning'
    | 'inspecting_icloud'
    | 'downloading_icloud'
    | 'hashing'
    | 'uploading'
    | 'completed'
    | 'cancelled';
  currentFilename: string | null;
  currentInICloud: boolean;
  currentProgress: number;
  currentBytesUploaded?: number;
  currentTotalBytes?: number;
  bytesPerSecond?: number;
  etaSeconds?: number | null;
  statusDetail?: string | null;
  totalDiscovered: number;
  processedCount: number;
  uploadedCount: number;
  dedupedCount: number;
  skippedCount: number;
  icloudOriginalsDownloaded: number;
  icloudWaitingWifiCount: number;
  failedCount: number;
  lastRunAt: string | null;
  lastError: string | null;
}
