import type {
  AccountStorage,
  Album,
  CreatedShare,
  CreatedManagedAccount,
  Entry,
  EntryDetails,
  EntryPage,
  FaceClusterPage,
  ManagedAccountPage,
  MediaPage,
  PublicShareView,
  SearchFilters,
  ServerStorage,
  ShareList,
  UploadCreated,
  User
} from './types';

export class ApiError extends Error {
  status: number;
  code: string;
  retryAfter: string | null;

  constructor(status: number, code: string, retryAfter: string | null = null) {
    super(code);
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

export type MediaIndexJob = {
  id: number;
  fileId: string;
  fileName: string;
  task: 'image_preview' | 'video_thumbnail' | 'video_preview' | 'face_index' | string;
  state: string;
  attempts: number;
  currentStage: string | null;
  processedBytes: number;
  totalBytes: number;
  errorCode: string | null;
  createdAt: string;
  updatedAt: string;
};

export type MediaIndexCounts = {
  queued: number;
  running: number;
  completed: number;
  unsupported: number;
  retryWait: number;
  failed: number;
};

export type GoogleDriveRun = {
  state: string;
  discovered_files: number;
  discovered_folders: number;
  discovered_bytes: number;
  downloaded_files: number;
  downloaded_bytes: number;
  skipped_files: number;
  failed_files: number;
  pending_files: number;
  current_name: string | null;
  current_bytes: number;
  current_total_bytes: number | null;
  throttle_reason: string | null;
  error_code: string | null;
};

export type GoogleDriveSource = {
  id: string;
  google_folder_id: string;
  google_folder_name: string;
  local_folder_id: string | null;
  run: GoogleDriveRun | null;
};

export type GoogleDriveStatus = {
  configured: boolean;
  connected: boolean;
  email: string | null;
  paused: boolean;
  reauth_required: boolean;
  local_root_id: string | null;
  images_indexed: number;
  images_waiting: number;
  videos_indexed: number;
  videos_waiting: number;
  sources: GoogleDriveSource[];
};

export type GoogleDriveFolderPage = {
  parent_id: string;
  folders: Array<{ id: string; name: string }>;
};

export type MediaIndexStatus = {
  previewStorageAvailable: boolean;
  paused: boolean;
  counts: MediaIndexCounts;
  taskMetrics: Array<{
    task: string;
    counts: MediaIndexCounts;
    pendingBytes: number;
    processedBytes: number;
  }>;
  pendingBytes: number;
  processedBytes: number;
  jobs: MediaIndexJob[];
  nextBeforeId: number | null;
};

let csrfToken: string | null = null;

export function rememberCsrf(token: string | null) {
  csrfToken = token;
}

function readCookie(name: string): string | null {
  const cookie = document.cookie.split('; ').find((part) => part.startsWith(name + '='));
  return cookie ? decodeURIComponent(cookie.slice(name.length + 1)) : null;
}

function currentCsrfToken(): string | null {
  return csrfToken || readCookie('__Host-my_drive_csrf') || readCookie('my_drive_csrf');
}

type RequestOptions = {
  method?: string;
  body?: BodyInit | null;
  json?: unknown;
  headers?: HeadersInit;
  csrf?: boolean;
  signal?: AbortSignal;
  cache?: RequestCache;
};

async function request<T>(url: string, options: RequestOptions = {}): Promise<T> {
  const headers = new Headers(options.headers);
  let body = options.body;
  if (options.json !== undefined) {
    headers.set('Content-Type', 'application/json');
    body = JSON.stringify(options.json);
  }
  if (options.csrf) {
    const token = currentCsrfToken();
    if (token) headers.set('X-CSRF-Token', token);
  }
  const response = await fetch(url, {
    method: options.method || 'GET',
    body,
    headers,
    credentials: 'same-origin',
    signal: options.signal,
    cache: options.cache
  });
  if (!response.ok) {
    let code = 'request_failed';
    try {
      const payload = (await response.json()) as { error?: string };
      if (payload.error) code = payload.error;
    } catch {
      code = response.statusText || code;
    }
    throw new ApiError(response.status, code, response.headers.get('Retry-After'));
  }
  if (response.status === 204) return undefined as T;
  const contentType = response.headers.get('Content-Type') || '';
  if (contentType.includes('application/json')) return (await response.json()) as T;
  return undefined as T;
}

export const api = {
  me: (signal?: AbortSignal) => request<User>('/api/auth/me', { signal }),
  changePassword: (currentPassword: string, newPassword: string) =>
    request<void>('/api/auth/password', {
      method: 'POST',
      json: { current_password: currentPassword, new_password: newPassword },
      csrf: true,
      cache: 'no-store'
    }),
  managedAccounts: (offset = 0, signal?: AbortSignal) => {
    const query = new URLSearchParams({ limit: '50' });
    if (offset) query.set('offset', String(offset));
    return request<ManagedAccountPage>('/api/admin/accounts?' + query.toString(), {
      signal,
      cache: 'no-store'
    });
  },
  createManagedAccount: (email: string, quotaBytes: number) =>
    request<CreatedManagedAccount>('/api/admin/accounts', {
      method: 'POST',
      json: { email, quotaBytes },
      csrf: true,
      cache: 'no-store'
    }),
  updateManagedAccount: (id: string, update: { quotaBytes?: number; disabled?: boolean }) =>
    request<void>('/api/admin/accounts/' + encodeURIComponent(id), {
      method: 'PATCH',
      json: update,
      csrf: true,
      cache: 'no-store'
    }),
  faceClusters: (offset = 0, signal?: AbortSignal) => {
    const query = new URLSearchParams({ limit: '50' });
    if (offset) query.set('offset', String(offset));
    return request<FaceClusterPage>('/api/faces?' + query.toString(), { signal, cache: 'no-store' });
  },
  renameFaceCluster: (id: string, label: string | null) =>
    request<{ id: string; label: string | null }>('/api/faces/' + encodeURIComponent(id), {
      method: 'PATCH',
      json: { label },
      csrf: true,
      cache: 'no-store'
    }),
  mergeFaceClusters: (targetId: string, sourceIds: string[]) =>
    request<{ targetId: string; mergedClusters: number; movedFaces: number }>('/api/faces/merge', {
      method: 'POST',
      json: { targetId, sourceIds },
      csrf: true,
      cache: 'no-store'
    }),
  resetManagedAccountPassword: (id: string) =>
    request<{ temporaryPassword: string }>(
      '/api/admin/accounts/' + encodeURIComponent(id) + '/reset-password',
      { method: 'POST', csrf: true, cache: 'no-store' }
    ),
  mediaIndexStatus: (signal?: AbortSignal, beforeId?: number | null) => {
    const query = new URLSearchParams({ limit: '100' });
    if (beforeId != null) query.set('beforeId', String(beforeId));
    return request<MediaIndexStatus>('/api/admin/media-index?' + query.toString(), { signal });
  },
  setMediaIndexPaused: (paused: boolean, signal?: AbortSignal) =>
    request<{ paused: boolean }>('/api/admin/media-index/pause', {
      method: 'POST',
      json: { paused },
      csrf: true,
      signal
    }),
  retryMediaIndex: (jobId?: number, signal?: AbortSignal) =>
    request<{ retried: number }>('/api/admin/media-index/retry', {
      method: 'POST',
      json: jobId == null ? {} : { jobId },
      csrf: true,
      signal
    }),
  googleDriveStatus: (signal?: AbortSignal) =>
    request<GoogleDriveStatus>('/api/google-drive', { signal, cache: 'no-store' }),
  googleDriveConnect: () =>
    request<{ authorize_url: string }>('/api/google-drive/connect', {
      method: 'POST',
      csrf: true,
      cache: 'no-store'
    }),
  googleDriveDisconnect: () =>
    request<void>('/api/google-drive/disconnect', { method: 'POST', csrf: true, cache: 'no-store' }),
  googleDrivePause: (paused: boolean) =>
    request<{ paused: boolean }>('/api/google-drive/pause', {
      method: 'POST',
      json: { paused },
      csrf: true,
      cache: 'no-store'
    }),
  googleDriveFolders: (parentId: string, signal?: AbortSignal) =>
    request<GoogleDriveFolderPage>(
      '/api/google-drive/folders?parent_id=' + encodeURIComponent(parentId),
      { signal, cache: 'no-store' }
    ),
  googleDriveSelect: (googleFolderId: string) =>
    request<{ id: string; local_folder_id: string }>('/api/google-drive/sources', {
      method: 'POST',
      json: { google_folder_id: googleFolderId },
      csrf: true,
      cache: 'no-store'
    }),
  googleDriveRemove: (id: string) =>
    request<void>('/api/google-drive/sources/' + encodeURIComponent(id), {
      method: 'DELETE',
      csrf: true,
      cache: 'no-store'
    }),
  googleDriveSync: (id: string) =>
    request<{ started: boolean }>('/api/google-drive/sources/' + encodeURIComponent(id) + '/sync', {
      method: 'POST',
      csrf: true,
      cache: 'no-store'
    }),
  login: async (email: string, password: string) => {
    const result = await request<{ user: User; csrf_token: string }>('/api/auth/login', {
      method: 'POST',
      json: { email, password }
    });
    rememberCsrf(result.csrf_token);
    return result.user;
  },
  logout: async () => {
    await request<void>('/api/auth/logout', { method: 'POST', csrf: true });
    rememberCsrf(null);
  },
  listDrive: (
    parentId: string | null,
    signal?: AbortSignal,
    offset = 0,
    options?: { sort_by?: string; order?: string; include_stats?: boolean }
  ) => {
    const query = new URLSearchParams();
    if (parentId) query.set('parent_id', parentId);
    if (offset) query.set('offset', String(offset));
    if (options?.sort_by) query.set('sort_by', options.sort_by);
    if (options?.order) query.set('order', options.order);
    if (options?.include_stats) query.set('include_stats', 'true');
    return request<EntryPage>('/api/drive' + (query.size ? '?' + query.toString() : ''), { signal });
  },
  search: (term: string, signal?: AbortSignal, offset = 0, filters?: SearchFilters) => {
    const query = new URLSearchParams();
    const merged: SearchFilters = { ...filters, q: filters?.q ?? term };
    if (merged.q) query.set('q', merged.q);
    if (merged.category) query.set('category', merged.category);
    if (merged.mime) query.set('mime', merged.mime);
    if (merged.min_size != null) query.set('min_size', String(merged.min_size));
    if (merged.max_size != null) query.set('max_size', String(merged.max_size));
    if (merged.created_from) query.set('created_from', merged.created_from);
    if (merged.created_to) query.set('created_to', merged.created_to);
    if (merged.modified_from) query.set('modified_from', merged.modified_from);
    if (merged.modified_to) query.set('modified_to', merged.modified_to);
    if (merged.folder_id) query.set('folder_id', merged.folder_id);
    if (merged.sort_by) query.set('sort_by', merged.sort_by);
    if (merged.order) query.set('order', merged.order);
    const pageOffset = offset || merged.offset || 0;
    if (pageOffset) query.set('offset', String(pageOffset));
    return request<EntryPage>('/api/drive/search?' + query.toString(), { signal });
  },
  entryDetails: (id: string, signal?: AbortSignal) =>
    request<EntryDetails>('/api/entries/' + encodeURIComponent(id) + '/details', { signal }),
  listPhotos: (cursor?: string | null, signal?: AbortSignal) => {
    const query = new URLSearchParams({ limit: '80' });
    if (cursor) query.set('cursor', cursor);
    return request<MediaPage>('/api/photos?' + query.toString(), { signal });
  },
  faceMedia: (id: string, offset = 0, signal?: AbortSignal) => {
    const query = new URLSearchParams({ limit: '80' });
    if (offset) query.set('offset', String(offset));
    return request<MediaPage>('/api/faces/' + encodeURIComponent(id) + '/media?' + query.toString(), { signal });
  },
  listAlbums: (signal?: AbortSignal) => request<{ albums: Album[] }>('/api/albums', { signal }),
  createAlbum: (name: string) =>
    request<Album>('/api/albums', { method: 'POST', json: { name }, csrf: true }),
  renameAlbum: (id: string, name: string) =>
    request<Album>('/api/albums/' + encodeURIComponent(id), {
      method: 'PATCH',
      json: { name },
      csrf: true
    }),
  deleteAlbum: (id: string) =>
    request<void>('/api/albums/' + encodeURIComponent(id), { method: 'DELETE', csrf: true }),
  albumItems: (id: string, offset = 0, signal?: AbortSignal) => {
    const query = new URLSearchParams({ limit: '80' });
    if (offset) query.set('offset', String(offset));
    return request<MediaPage>('/api/albums/' + encodeURIComponent(id) + '/items?' + query.toString(), { signal });
  },
  addAlbumItems: (id: string, fileIds: string[]) =>
    request<{ album_id: string; count: number }>('/api/albums/' + encodeURIComponent(id) + '/items', {
      method: 'POST',
      json: { file_ids: fileIds },
      csrf: true
    }),
  removeAlbumItems: (id: string, fileIds: string[]) =>
    request<{ album_id: string; count: number }>(
      '/api/albums/' + encodeURIComponent(id) + '/items/remove',
      { method: 'POST', json: { file_ids: fileIds }, csrf: true }
    ),
  accountStorage: (signal?: AbortSignal) =>
    request<AccountStorage>('/api/storage', { signal, cache: 'no-store' }),
  serverStorage: (signal?: AbortSignal) =>
    request<ServerStorage>('/api/admin/storage', { signal, cache: 'no-store' }),
  purgeTrash: (payload: { ids?: string[]; all?: boolean }) =>
    request<{ roots: number; entries: number }>('/api/drive/trash/purge', {
      method: 'POST',
      json: payload,
      csrf: true
    }),
  listTrash: (signal?: AbortSignal, offset = 0) =>
    request<EntryPage>('/api/drive/trash' + (offset ? '?offset=' + offset : ''), { signal }),
  createFolder: (name: string, parentId: string | null) =>
    request<Entry>('/api/folders', {
      method: 'POST',
      json: { name, parent_id: parentId },
      csrf: true
    }),
  renameEntry: (id: string, name: string) =>
    request<Entry>('/api/entries/' + encodeURIComponent(id) + '/rename', {
      method: 'PATCH',
      json: { name },
      csrf: true
    }),
  moveEntry: (id: string, parentId: string | null) =>
    request<Entry>('/api/entries/' + encodeURIComponent(id) + '/move', {
      method: 'POST',
      json: { parent_id: parentId },
      csrf: true
    }),
  trashEntry: (id: string) =>
    request<void>('/api/entries/' + encodeURIComponent(id), { method: 'DELETE', csrf: true }),
  restoreEntry: (id: string) =>
    request<Entry>('/api/entries/' + encodeURIComponent(id) + '/restore', {
      method: 'POST',
      csrf: true
    }),
  getEntry: (id: string) => request<Entry>('/api/entries/' + encodeURIComponent(id)),
  listShares: (offset = 0) => request<ShareList>('/api/shares' + (offset ? '?offset=' + offset : '')),
  createShare: (payload: {
    resource_type: 'file' | 'folder' | 'album';
    resource_id: string;
    expires_at: string | null;
    password: string | null;
    allow_download: boolean;
    max_downloads: number | null;
  }) =>
    request<CreatedShare>('/api/shares', { method: 'POST', json: payload, csrf: true }),
  revokeShare: (id: string) =>
    request<void>('/api/shares/' + encodeURIComponent(id) + '/revoke', {
      method: 'POST',
      csrf: true
    }),
  createUpload: (filename: string, size: number, parentId: string | null) =>
    request<UploadCreated>('/api/uploads', {
      method: 'POST',
      json: { filename, expected_size: size, parent_id: parentId },
      csrf: true
    }),
  uploadHead: async (id: string) => {
    const response = await fetch('/api/uploads/' + encodeURIComponent(id), {
      method: 'HEAD',
      credentials: 'same-origin'
    });
    if (!response.ok) {
      let code = 'request_failed';
      try {
        const payload = (await response.json()) as { error?: string };
        if (payload.error) code = payload.error;
      } catch {
        code = response.statusText || code;
      }
      throw new ApiError(response.status, code, response.headers.get('Retry-After'));
    }
    return {
      offset: Number(response.headers.get('Upload-Offset') || 0),
      length: Number(response.headers.get('Upload-Length') || 0)
    };
  },
  uploadChunk: (id: string, offset: number, chunk: Blob) =>
    request<void>('/api/uploads/' + encodeURIComponent(id), {
      method: 'PATCH',
      body: chunk,
      headers: {
        'Content-Type': 'application/offset+octet-stream',
        'Upload-Offset': String(offset)
      },
      csrf: true
    }),
  finalizeUpload: (id: string) =>
    request<{ file_id: string; status: string }>('/api/uploads/' + encodeURIComponent(id) + '/finalize', {
      method: 'POST',
      csrf: true
    }),
  cancelUpload: (id: string) =>
    request<void>('/api/uploads/' + encodeURIComponent(id), { method: 'DELETE', csrf: true }),
  publicShare: (token: string, folderId?: string) => {
    const query = folderId ? '?folder_id=' + encodeURIComponent(folderId) : '';
    return request<PublicShareView>(
      '/api/public/shares/' + encodeURIComponent(token) + query
    );
  },
  unlockShare: (token: string, password: string) =>
    request<void>('/api/public/shares/' + encodeURIComponent(token) + '/unlock', {
      method: 'POST',
      json: { password }
    })
};

export function downloadUrl(id: string): string {
  return '/api/files/' + encodeURIComponent(id) + '/download';
}

export function previewUrl(id: string): string {
  return '/api/files/' + encodeURIComponent(id) + '/preview';
}

export function thumbnailUrl(id: string): string {
  return '/api/files/' + encodeURIComponent(id) + '/thumbnail';
}

export function publicDownloadUrl(token: string, id: string): string {
  return '/api/public/shares/' + encodeURIComponent(token) + '/download/' + encodeURIComponent(id);
}

export function publicPreviewUrl(token: string, id: string): string {
  return '/api/public/shares/' + encodeURIComponent(token) + '/preview/' + encodeURIComponent(id);
}

export function publicThumbnailUrl(token: string, id: string): string {
  return '/api/public/shares/' + encodeURIComponent(token) + '/thumbnail/' + encodeURIComponent(id);
}
