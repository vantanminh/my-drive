import type {
  AccountStorage,
  Album,
  BackupDevice,
  BrowserSession,
  DeviceAuthorizationRequest,
  CreatedShare,
  CreatedManagedAccount,
  Entry,
  EntryDetails,
  EntryPage,
  FaceCluster,
  FaceClusterPage,
  HostNetworkStatus,
  HostOverview,
  HostServiceLogs,
  ManagedAccountPage,
  MediaPage,
  PublicShareView,
  SearchFilters,
  ServerStorage,
  ShareList,
  NetworkDriveStatus,
  SystemUpdateSettings,
  SystemUpdatesStatus,
  TeamDetail,
  TeamMemberSummary,
  TeamSummary,
  UploadCreated,
  User
} from './types';

export class ApiError extends Error {
  status: number;
  code: string;
  retryAfter: string | null;
  offset: number | null;

  constructor(
    status: number,
    code: string,
    retryAfter: string | null = null,
    offset: number | null = null
  ) {
    super(code);
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
    this.offset = offset;
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

export type GoogleDriveSettings = {
  available: boolean;
  client_id: string;
  redirect_uri: string;
  secret_saved: boolean;
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
let activeTeamWorkspaceId: string | null = null;

export function setActiveTeamWorkspace(teamId: string | null) {
  activeTeamWorkspaceId = teamId;
}

export function activeTeamWorkspace(): string | null {
  return activeTeamWorkspaceId;
}

function isTeamScopedPath(url: string): boolean {
  return (
    url.startsWith('/api/drive') ||
    url.startsWith('/api/folders') ||
    url.startsWith('/api/entries') ||
    url.startsWith('/api/uploads') ||
    url.startsWith('/api/files') ||
    url === '/api/storage'
  );
}

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

export async function request<T>(url: string, options: RequestOptions = {}): Promise<T> {
  const headers = new Headers(options.headers);
  let body = options.body;
  if (options.json !== undefined) {
    headers.set('Content-Type', 'application/json');
    body = JSON.stringify(options.json);
  }
  if (activeTeamWorkspaceId && isTeamScopedPath(url) && !headers.has('X-MyDrive-Team')) {
    headers.set('X-MyDrive-Team', activeTeamWorkspaceId);
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

const CHUNK_STALL_TIMEOUT_MS = 30_000;

function uploadChunkWithProgress(
  id: string,
  offset: number,
  chunk: Blob,
  onProgress?: (loadedBytes: number, totalBytes: number) => void,
  signal?: AbortSignal
): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let settled = false;
    let stalled = false;
    let stallTimer: number | null = null;
    const clearStallTimer = () => {
      if (stallTimer !== null) {
        window.clearTimeout(stallTimer);
        stallTimer = null;
      }
    };
    const armStallTimer = () => {
      clearStallTimer();
      stallTimer = window.setTimeout(() => {
        stalled = true;
        xhr.abort();
      }, CHUNK_STALL_TIMEOUT_MS);
    };
    const cleanup = () => {
      clearStallTimer();
      signal?.removeEventListener('abort', abort);
    };
    const succeed = (nextOffset: number) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(nextOffset);
    };
    const fail = (cause: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(cause);
    };
    const abort = () => xhr.abort();

    if (signal?.aborted) {
      fail(new DOMException('The upload was aborted.', 'AbortError'));
      return;
    }

    xhr.open('PATCH', '/api/uploads/' + encodeURIComponent(id), true);
    xhr.withCredentials = true;
    xhr.setRequestHeader('Content-Type', 'application/offset+octet-stream');
    xhr.setRequestHeader('Upload-Offset', String(offset));
    xhr.setRequestHeader('Tus-Resumable', '1.0.0');
    if (activeTeamWorkspaceId) {
      xhr.setRequestHeader('X-MyDrive-Team', activeTeamWorkspaceId);
    }
    const token = currentCsrfToken();
    if (token) xhr.setRequestHeader('X-CSRF-Token', token);
    xhr.upload.addEventListener('progress', (event) => {
      armStallTimer();
      onProgress?.(event.loaded, event.lengthComputable ? event.total : chunk.size);
    });
    xhr.upload.addEventListener('loadend', () => {
      // Once request bytes leave TCP buffer, keep a stall guard for the server flush response.
      armStallTimer();
    });
    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        const headerOffset = Number(xhr.getResponseHeader('Upload-Offset'));
        const nextOffset =
          Number.isFinite(headerOffset) && headerOffset >= offset
            ? headerOffset
            : offset + chunk.size;
        succeed(nextOffset);
        return;
      }
      let code = 'request_failed';
      let conflictOffset: number | null = null;
      const headerOffset = xhr.getResponseHeader('Upload-Offset');
      if (headerOffset && /^\d+$/.test(headerOffset)) {
        conflictOffset = Number(headerOffset);
      }
      try {
        const payload = JSON.parse(xhr.responseText) as { error?: string; offset?: number };
        if (payload.error) code = payload.error;
        if (typeof payload.offset === 'number' && Number.isFinite(payload.offset)) {
          conflictOffset = payload.offset;
        }
      } catch {
        code = xhr.statusText || code;
      }
      fail(new ApiError(xhr.status, code, xhr.getResponseHeader('Retry-After'), conflictOffset));
    });
    xhr.addEventListener('error', () => fail(new ApiError(0, 'network_error')));
    xhr.addEventListener('abort', () => {
      if (stalled && !signal?.aborted) {
        fail(new ApiError(0, 'upload_stalled'));
      } else {
        fail(new DOMException('The upload was aborted.', 'AbortError'));
      }
    });
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) {
      abort();
      return;
    }
    try {
      armStallTimer();
      xhr.send(chunk);
    } catch (cause) {
      fail(cause);
    }
  });
}

export const api = {
  me: (signal?: AbortSignal) => request<User>('/api/auth/me', { signal }),
  listSessions: (signal?: AbortSignal) =>
    request<BrowserSession[]>('/api/auth/sessions', { signal, cache: 'no-store' }),
  revokeSession: (id: string) =>
    request<void>('/api/auth/sessions/' + encodeURIComponent(id), {
      method: 'DELETE',
      csrf: true,
      cache: 'no-store'
    }),
  revokeOtherSessions: () =>
    request<void>('/api/auth/sessions/revoke-others', {
      method: 'POST',
      csrf: true,
      cache: 'no-store'
    }),
  listDevices: (signal?: AbortSignal) =>
    request<{ devices: BackupDevice[] }>('/api/devices', { signal, cache: 'no-store' }),
  revokeDevice: (id: string) =>
    request<void>('/api/devices/' + encodeURIComponent(id), {
      method: 'DELETE',
      csrf: true,
      cache: 'no-store'
    }),
  deviceRequest: (userCode: string, signal?: AbortSignal) =>
    request<DeviceAuthorizationRequest>('/api/device/pending?user_code=' + encodeURIComponent(userCode), {
      signal,
      cache: 'no-store'
    }),
  approveDevice: (userCode: string) =>
    request<{ status: string; device_id: string; device_name: string }>('/api/device/authorize', {
      method: 'POST',
      json: { user_code: userCode },
      csrf: true,
      cache: 'no-store'
    }),
  denyDevice: (userCode: string) =>
    request<{ status: string }>('/api/device/deny', {
      method: 'POST',
      json: { user_code: userCode },
      csrf: true,
      cache: 'no-store'
    }),
  changePassword: (currentPassword: string, newPassword: string) =>
    request<void>('/api/auth/password', {
      method: 'POST',
      json: { current_password: currentPassword, new_password: newPassword },
      csrf: true,
      cache: 'no-store'
    }),
  managedAccounts: (
    offset = 0,
    signal?: AbortSignal,
    options?: { q?: string; role?: string; status?: string }
  ) => {
    const query = new URLSearchParams({ limit: '50' });
    if (offset) query.set('offset', String(offset));
    if (options?.q?.trim()) query.set('q', options.q.trim());
    if (options?.role && options.role !== 'all') query.set('role', options.role);
    if (options?.status && options.status !== 'all') query.set('status', options.status);
    return request<ManagedAccountPage>('/api/admin/accounts?' + query.toString(), {
      signal,
      cache: 'no-store'
    });
  },
  createManagedAccount: (email: string, quotaBytes: number, role: 'member' | 'admin' = 'member') =>
    request<CreatedManagedAccount>('/api/admin/accounts', {
      method: 'POST',
      json: { email, quotaBytes, role },
      csrf: true,
      cache: 'no-store'
    }),
  updateManagedAccount: (
    id: string,
    update: { quotaBytes?: number; disabled?: boolean; role?: 'member' | 'admin' }
  ) =>
    request<void>('/api/admin/accounts/' + encodeURIComponent(id), {
      method: 'PATCH',
      json: update,
      csrf: true,
      cache: 'no-store'
    }),
  deleteManagedAccount: (id: string) =>
    request<void>('/api/admin/accounts/' + encodeURIComponent(id), {
      method: 'DELETE',
      csrf: true,
      cache: 'no-store'
    }),
  listTeams: (signal?: AbortSignal) =>
    request<{ teams: TeamSummary[] }>('/api/teams', {
      signal,
      cache: 'no-store'
    }),
  createTeam: (input: { name: string; description?: string; quotaBytes?: number }) =>
    request<TeamSummary>('/api/teams', {
      method: 'POST',
      json: input,
      csrf: true,
      cache: 'no-store'
    }),
  getTeam: (id: string, signal?: AbortSignal) =>
    request<TeamDetail>('/api/teams/' + encodeURIComponent(id), {
      signal,
      cache: 'no-store'
    }),
  updateTeam: (id: string, input: { name?: string; description?: string; quotaBytes?: number }) =>
    request<TeamSummary>('/api/teams/' + encodeURIComponent(id), {
      method: 'PATCH',
      json: input,
      csrf: true,
      cache: 'no-store'
    }),
  deleteTeam: (id: string) =>
    request<void>('/api/teams/' + encodeURIComponent(id), {
      method: 'DELETE',
      csrf: true,
      cache: 'no-store'
    }),
  addTeamMember: (teamId: string, input: { email: string; role?: 'admin' | 'member' }) =>
    request<TeamMemberSummary>('/api/teams/' + encodeURIComponent(teamId) + '/members', {
      method: 'POST',
      json: input,
      csrf: true,
      cache: 'no-store'
    }),
  updateTeamMember: (teamId: string, userId: string, role: 'admin' | 'member') =>
    request<TeamMemberSummary>(
      '/api/teams/' + encodeURIComponent(teamId) + '/members/' + encodeURIComponent(userId),
      {
        method: 'PATCH',
        json: { role },
        csrf: true,
        cache: 'no-store'
      }
    ),
  removeTeamMember: (teamId: string, userId: string) =>
    request<void>(
      '/api/teams/' + encodeURIComponent(teamId) + '/members/' + encodeURIComponent(userId),
      {
        method: 'DELETE',
        csrf: true,
        cache: 'no-store'
      }
    ),
  faceClusters: (offset = 0, signal?: AbortSignal, filter?: { q?: string; named?: boolean }) => {
    const query = new URLSearchParams({ limit: '60' });
    if (offset) query.set('offset', String(offset));
    if (filter?.q) query.set('q', filter.q);
    if (filter?.named != null) query.set('named', filter.named ? 'true' : 'false');
    return request<FaceClusterPage>('/api/faces?' + query.toString(), { signal, cache: 'no-store' });
  },
  getFaceCluster: (id: string, signal?: AbortSignal) =>
    request<FaceCluster>('/api/faces/' + encodeURIComponent(id), { signal, cache: 'no-store' }),
  renameFaceCluster: (id: string, label: string | null) =>
    request<{ id: string; label: string | null }>('/api/faces/' + encodeURIComponent(id), {
      method: 'PATCH',
      json: { label },
      csrf: true,
      cache: 'no-store'
    }),
  reclusterFaces: () =>
    request<{ facesReclustered: number; clusters: number; preservedClusters: number }>(
      '/api/faces/recluster',
      { method: 'POST', csrf: true, cache: 'no-store' }
    ),
  mergeFaceClusters: (targetId: string, sourceIds: string[]) =>
    request<{ targetId: string; mergedClusters: number; movedFaces: number }>('/api/faces/merge', {
      method: 'POST',
      json: { targetId, sourceIds },
      csrf: true,
      cache: 'no-store'
    }),
  separateFace: (clusterId: string, fileIds: string[]) =>
    request<{ clusterId: string; movedFaces: number }>(
      '/api/faces/' + encodeURIComponent(clusterId) + '/separate',
      { method: 'POST', json: { fileIds }, csrf: true, cache: 'no-store' }
    ),
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
  googleDriveSettings: (signal?: AbortSignal) =>
    request<GoogleDriveSettings>('/api/google-drive/settings', { signal, cache: 'no-store' }),
  googleDriveSaveSettings: (settings: { client_id: string; client_secret: string; redirect_uri: string }) =>
    request<void>('/api/google-drive/settings', {
      method: 'POST', csrf: true, cache: 'no-store', json: settings
    }),
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
  batchEntries: (payload: { action: 'move' | 'copy' | 'trash'; ids: string[]; parent_id?: string | null }) =>
    request<{ action: string; count: number; entry_ids: string[] }>('/api/drive/batch', {
      method: 'POST',
      json: payload,
      csrf: true
    }),
  ensurePhotosFolder: () =>
    request<{ id: string; name: string; system_role: 'photos' }>('/api/library/photos-folder', {
      method: 'POST',
      csrf: true
    }),
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
    const headers = new Headers();
    if (activeTeamWorkspaceId) headers.set('X-MyDrive-Team', activeTeamWorkspaceId);
    const response = await fetch('/api/uploads/' + encodeURIComponent(id), {
      method: 'HEAD',
      headers,
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
  uploadChunk: (
    id: string,
    offset: number,
    chunk: Blob,
    onProgress?: (loadedBytes: number, totalBytes: number) => void,
    signal?: AbortSignal
  ) => uploadChunkWithProgress(id, offset, chunk, onProgress, signal),
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
    }),
  networkDriveStatus: (signal?: AbortSignal) =>
    request<NetworkDriveStatus>('/api/network-drive', { signal, cache: 'no-store' }),
  setNetworkDrive: (patch: { enabled?: boolean; smbEnabled?: boolean }) =>
    request<NetworkDriveStatus>('/api/network-drive', {
      method: 'PATCH',
      json: patch,
      csrf: true,
      cache: 'no-store'
    }),
  setSmbPassword: (password: string) =>
    request<NetworkDriveStatus>('/api/network-drive/smb-password', {
      method: 'PUT',
      json: { password },
      csrf: true,
      cache: 'no-store'
    }),
  updatesStatus: (signal?: AbortSignal) =>
    request<SystemUpdatesStatus>('/api/admin/updates', { signal, cache: 'no-store' }),
  updateUpdateSettings: (settings: SystemUpdateSettings) =>
    request<SystemUpdatesStatus>('/api/admin/updates/settings', {
      method: 'PATCH',
      json: settings,
      csrf: true,
      cache: 'no-store'
    }),
  checkForUpdates: () =>
    request<SystemUpdatesStatus>('/api/admin/updates/check', {
      method: 'POST',
      csrf: true,
      cache: 'no-store'
    }),
  applySystemUpdate: (targetTag?: string | null) =>
    request<SystemUpdatesStatus>('/api/admin/updates/apply', {
      method: 'POST',
      json: { targetTag: targetTag ?? null },
      csrf: true,
      cache: 'no-store'
    }),
  hostOverview: (signal?: AbortSignal) =>
    request<HostOverview>('/api/admin/host/overview', { signal, cache: 'no-store' }),
  restartHostService: (service: string) =>
    request<{ ok: boolean; service: string; message: string }>('/api/admin/host/services/restart', {
      method: 'POST',
      json: { service },
      csrf: true,
      cache: 'no-store'
    }),
  hostServiceLogs: (service = 'all', tail = 120, signal?: AbortSignal) =>
    request<HostServiceLogs>(
      '/api/admin/host/services/logs?service=' + encodeURIComponent(service) + '&tail=' + encodeURIComponent(String(tail)),
      { signal, cache: 'no-store' }
    ),
  hostNetwork: (signal?: AbortSignal) =>
    request<HostNetworkStatus>('/api/admin/host/network', { signal, cache: 'no-store' }),
  updateHostLan: (payload: { enabled: boolean; port: number; bind: string; configureUfw: boolean }) =>
    request<HostNetworkStatus>('/api/admin/host/network/lan', {
      method: 'POST',
      json: payload,
      csrf: true,
      cache: 'no-store'
    }),
  updateHostLanTls: (payload: {
    mode: 'off' | 'letsencrypt_cloudflare' | 'internal_ca';
    host: string;
    ip: string;
    port: number;
    bind: string;
    cloudflareToken?: string;
    configureUfw: boolean;
  }) =>
    request<HostNetworkStatus>('/api/admin/host/network/lan-tls', {
      method: 'POST',
      json: payload,
      csrf: true,
      cache: 'no-store'
    }),
  renewHostLanTls: () =>
    request<HostNetworkStatus>('/api/admin/host/network/lan-tls/renew', {
      method: 'POST',
      csrf: true,
      cache: 'no-store'
    }),
  hostLanTlsCaUrl: () => '/api/admin/host/network/lan-tls/ca.crt',
  applyHostNetplan: (payload: {
    interface: string;
    mode: 'dhcp' | 'static';
    addressCidr?: string;
    gateway?: string;
    dns?: string[];
    confirmTimeoutSeconds?: number;
  }) =>
    request<HostNetworkStatus>('/api/admin/host/network/netplan', {
      method: 'POST',
      json: payload,
      csrf: true,
      cache: 'no-store'
    }),
  confirmHostNetplan: () =>
    request<HostNetworkStatus>('/api/admin/host/network/confirm', {
      method: 'POST',
      csrf: true,
      cache: 'no-store'
    }),
  rollbackHostNetplan: () =>
    request<HostNetworkStatus>('/api/admin/host/network/rollback', {
      method: 'POST',
      csrf: true,
      cache: 'no-store'
    })
};

function withTeamQuery(path: string): string {
  if (!activeTeamWorkspaceId) return path;
  return path + (path.includes('?') ? '&' : '?') + 'team_id=' + encodeURIComponent(activeTeamWorkspaceId);
}

export function downloadUrl(id: string): string {
  return withTeamQuery('/api/files/' + encodeURIComponent(id) + '/download');
}

export function previewUrl(id: string): string {
  return withTeamQuery('/api/files/' + encodeURIComponent(id) + '/preview');
}

export function thumbnailUrl(id: string): string {
  return withTeamQuery('/api/files/' + encodeURIComponent(id) + '/thumbnail');
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
