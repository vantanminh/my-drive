export type User = {
  id: string;
  email: string;
  role: string;
  must_change_password: boolean;
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

export type AccountStorage = {
  quota_bytes: number | null;
  used_bytes: number;
  reserved_bytes: number;
  available_bytes: number | null;
  percent_used: number | null;
  unlimited: boolean;
  by_category: CategoryUsage[];
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
