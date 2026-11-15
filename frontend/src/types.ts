export type User = {
  id: string;
  email: string;
  role: string;
  must_change_password: boolean;
};

export type BrowserSession = {
  id: string;
  created_at: string;
  last_seen_at: string | null;
  expires_at: string;
  is_current: boolean;
};

export type BackupDevice = {
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
};

export type DeviceAuthorizationRequest = {
  user_code: string;
  client_name: string;
  device_name: string;
  operating_system: string;
  client_version: string;
  requested_ip: string | null;
  status: string;
  created_at: string;
  expires_at: string;
};

export type ManagedAccount = {
  id: string;
  email: string;
  quotaBytes: number;
  usedBytes: number;
  reservedBytes: number;
  disabledAt: string | null;
  createdAt: string;
};

export type ManagedAccountPage = {
  accounts: ManagedAccount[];
  nextOffset: number | null;
};

export type FaceCluster = {
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
};

export type FaceClusterPage = {
  clusters: FaceCluster[];
  limit: number;
  nextOffset: number | null;
};

export type CreatedManagedAccount = {
  account: ManagedAccount;
  temporaryPassword: string;
};

export type Entry = {
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
};

export type EntryPage = {
  entries: Entry[];
  limit: number;
  next_offset: number | null;
};

export type ShareSummary = {
  id: string;
  resource_type: 'file' | 'folder' | 'album';
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
};

export type ShareList = {
  shares: ShareSummary[];
  next_offset: number | null;
};

export type PublicEntry = {
  id: string;
  name: string;
  kind: 'file' | 'folder';
  size_bytes: number | null;
  updated_at: string;
};

export type Breadcrumb = {
  id: string;
  name: string;
};

export type PublicShareView = {
  share_id: string;
  resource: PublicEntry;
  current_folder: string | null;
  breadcrumbs: Breadcrumb[];
  entries: PublicEntry[];
  allow_download: boolean;
  expires_at: string | null;
  next_offset: number | null;
};

export type UploadCreated = {
  id: string;
  offset: number;
  length: number;
};

export type CreatedShare = {
  id: string;
  resource_type: 'file' | 'folder' | 'album';
  resource_id: string;
  share_url: string;
  expires_at: string | null;
  password_protected: boolean;
  allow_download: boolean;
  max_downloads: number | null;
};

export type MediaItem = {
  id: string;
  name: string;
  mime_type: string | null;
  category: string;
  size_bytes: number;
  created_at: string;
  updated_at: string;
  media: { width?: number | null; height?: number | null };
};

export type MediaPage = {
  items: MediaItem[];
  limit: number;
  next_cursor?: string | null;
  next_offset?: number | null;
};

export type FolderAnalytics = {
  total_bytes: number;
  file_count: number;
  subfolder_count: number;
  by_category: Record<string, number>;
};

export type EntryDetails = {
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
  media: { width?: number | null; height?: number | null };
  folder: FolderAnalytics | null;
};

export type Album = {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
  item_count: number;
  cover_file_id: string | null;
};

export type CategoryUsage = {
  category: string;
  file_count: number;
  size_bytes: number;
};

export type LargestFile = {
  id: string;
  name: string;
  size_bytes: number;
  category: string;
  mime_type: string | null;
};

export type AccountStorage = {
  quota_bytes: number | null;
  used_bytes: number;
  reserved_bytes: number;
  available_bytes: number | null;
  percent_used: number | null;
  unlimited: boolean;
  by_category: CategoryUsage[];
  largest_files?: LargestFile[];
};

export type VolumeStatus = {
  total_bytes: number;
  used_bytes: number;
  free_bytes: number;
  percent_used: number;
};

export type UserStorage = {
  id: string;
  email: string;
  role: string;
  quota_bytes: number | null;
  used_bytes: number;
  percent_of_library: number;
  percent_of_hdd: number | null;
};

export type ServerStorage = {
  ssd: VolumeStatus | null;
  hdd: VolumeStatus | null;
  same_volume: boolean;
  system_used_bytes: number;
  library_bytes: number;
  by_category: CategoryUsage[];
  largest_files?: LargestFile[];
  users: UserStorage[];
};

export type SearchFilters = {
  q?: string;
  category?: string;
  mime?: string;
  min_size?: number;
  max_size?: number;
  created_from?: string;
  created_to?: string;
  modified_from?: string;
  modified_to?: string;
  folder_id?: string;
  sort_by?: string;
  order?: string;
  offset?: number;
};

export type SystemUpdateCurrent = {
  version: string;
  commitSha: string | null;
  buildTime: string | null;
  image: string | null;
};

export type SystemUpdateSettings = {
  autoCheckEnabled: boolean;
  autoUpdateEnabled: boolean;
  checkIntervalMinutes: number;
};

export type SystemUpdateLatest = {
  tag: string | null;
  commitSha: string | null;
  publishedAt: string | null;
  url: string | null;
  notes: string | null;
  updateAvailable: boolean;
};

export type SystemUpdateCheck = {
  lastCheckedAt: string | null;
  status: string | null;
  error: string | null;
};

export type HostUpdaterStatus = {
  connected: boolean;
  status: string;
  phase: string | null;
  message: string | null;
  targetTag: string | null;
  imageTrack: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string | null;
};

export type SystemUpdatesStatus = {
  current: SystemUpdateCurrent;
  githubRepo: string;
  settings: SystemUpdateSettings;
  latest: SystemUpdateLatest;
  check: SystemUpdateCheck;
  hostUpdater: HostUpdaterStatus;
  lastTriggeredAt: string | null;
  lastTriggeredTag: string | null;
};

export type HostMemoryStats = {
  totalBytes: number;
  availableBytes?: number | null;
  freeBytes?: number | null;
  usedBytes: number;
};

export type HostDiskStat = {
  label: string;
  path: string;
  totalBytes: number;
  usedBytes: number;
  freeBytes: number;
  percentUsed: number;
};

export type HostCoreSummary = {
  installDir: string;
  tlsMode: string | null;
  host: string | null;
  lanEnabled: boolean;
  lanPort: number;
  lanBind: string;
  myDriveService: string;
  updaterService: string;
  imageTrack: string | null;
};

export type HostServiceStatus = {
  name: string;
  service: string;
  state: string;
  health: string | null;
  status: string;
  image: string;
  runningFor: string | null;
};

export type HostOverview = {
  connected: boolean;
  hostname: string;
  osName: string;
  kernel: string;
  arch: string;
  uptimeSeconds: number | null;
  loadAverage: number[];
  cpuCores: number;
  cpuUsagePercent: number | null;
  memory: HostMemoryStats;
  swap: HostMemoryStats;
  disks: HostDiskStat[];
  core: HostCoreSummary;
  services: HostServiceStatus[];
};

export type HostServiceLogs = {
  service: string;
  tail: number;
  lines: string[];
};

export type HostNetworkInterface = {
  name: string;
  state: string;
  mac: string | null;
  ipv4: string[];
  gateway: string | null;
  dhcp: boolean;
};

export type HostUfwStatus = {
  installed: boolean;
  active: boolean;
  rules: string[];
};

export type HostLanConfig = {
  enabled: boolean;
  port: number;
  bind: string;
  tlsMode: string | null;
  host: string | null;
};

export type PendingNetplanRollback = {
  interface: string;
  mode: string;
  addressCidr: string | null;
  gateway: string | null;
  dns: string[];
  appliedAt: string;
  expiresAt: string;
  timeoutSeconds: number;
  remainingSeconds: number | null;
};

export type HostNetworkStatus = {
  connected: boolean;
  netplanAvailable: boolean;
  interfaces: HostNetworkInterface[];
  dnsServers: string[];
  ufw: HostUfwStatus;
  lan: HostLanConfig;
  pendingRollback: PendingNetplanRollback | null;
};

export type NetworkDriveStatus = {
  enabled: boolean;
  path: string;
  lanOnly: boolean;
  readOnly: boolean;
  canManage: boolean;
  smbEnabled: boolean;
  smbAvailable: boolean;
  smbUsername: string | null;
};
