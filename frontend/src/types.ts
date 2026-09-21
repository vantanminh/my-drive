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
};

export type EntryPage = {
  entries: Entry[];
  limit: number;
  next_offset: number | null;
};

export type ShareSummary = {
  id: string;
  resource_type: 'file' | 'folder';
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
  resource_type: 'file' | 'folder';
  resource_id: string;
  share_url: string;
  expires_at: string | null;
  password_protected: boolean;
  allow_download: boolean;
  max_downloads: number | null;
};
