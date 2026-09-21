import type {
  CreatedShare,
  Entry,
  EntryPage,
  PublicShareView,
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
  state: string;
  attempts: number;
  currentStage: string | null;
  processedBytes: number;
  totalBytes: number;
  errorCode: string | null;
  createdAt: string;
  updatedAt: string;
};

export type MediaIndexStatus = {
  previewStorageAvailable: boolean;
  paused: boolean;
  counts: {
    queued: number;
    running: number;
    completed: number;
    unsupported: number;
    retryWait: number;
    failed: number;
  };
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
    signal: options.signal
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
  listDrive: (parentId: string | null, signal?: AbortSignal, offset = 0) => {
    const query = new URLSearchParams();
    if (parentId) query.set('parent_id', parentId);
    if (offset) query.set('offset', String(offset));
    return request<EntryPage>('/api/drive' + (query.size ? '?' + query.toString() : ''), { signal });
  },
  search: (term: string, signal?: AbortSignal, offset = 0) => {
    const query = new URLSearchParams({ q: term });
    if (offset) query.set('offset', String(offset));
    return request<EntryPage>('/api/drive/search?' + query.toString(), { signal });
  },
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
    resource_type: 'file' | 'folder';
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

export function publicDownloadUrl(token: string, id: string): string {
  return '/api/public/shares/' + encodeURIComponent(token) + '/download/' + encodeURIComponent(id);
}
