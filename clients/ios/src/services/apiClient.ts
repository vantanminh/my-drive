import type {
  AccountStorage,
  Album,
  AlbumItemPage,
  BackupCheckResponse,
  BackupLinkResponse,
  Entry,
  EntryDetails,
  EntryPage,
  LoginResponse,
  PhotoPage,
  ServerCapabilities,
  UploadCreated,
  UploadFinalized,
  User,
} from '../types/mydrive';
import type { FetchLike } from './serverUrl';

export class MyDriveApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly offset?: number;

  constructor(status: number, code: string, message?: string, offset?: number) {
    super(message ?? code);
    this.name = 'MyDriveApiError';
    this.status = status;
    this.code = code;
    this.offset = offset;
  }
}

export interface MyDriveClientConfig {
  baseUrl: string;
  csrfToken?: string | null;
  fetchImpl?: FetchLike;
  onCsrfUpdate?: (token: string | null) => void;
  onUnauthorized?: () => void;
}

export interface SearchDriveParams {
  q?: string;
  category?: string;
  folder_id?: string;
  limit?: number;
  offset?: number;
  sort_by?: 'name' | 'size' | 'created_at' | 'updated_at';
  order?: 'asc' | 'desc';
}

export interface ListFolderParams {
  parentId?: string | null;
  offset?: number;
  limit?: number;
  sortBy?: 'name' | 'size' | 'updated_at';
  order?: 'asc' | 'desc';
  includeStats?: boolean;
}

const MUTATING_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

function buildQuery(params: Record<string, string | number | boolean | null | undefined>): string {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') {
      qs.set(key, String(value));
    }
  }
  const encoded = qs.toString();
  return encoded ? `?${encoded}` : '';
}

export class MyDriveClient {
  private baseUrl: string;
  private csrfToken: string | null;
  private readonly fetchImpl: FetchLike;
  private readonly onCsrfUpdate?: (token: string | null) => void;
  private readonly onUnauthorized?: () => void;

  constructor(config: MyDriveClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.csrfToken = config.csrfToken ?? null;
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.onCsrfUpdate = config.onCsrfUpdate;
    this.onUnauthorized = config.onUnauthorized;
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  getCsrfToken(): string | null {
    return this.csrfToken;
  }

  setCsrfToken(token: string | null): void {
    this.csrfToken = token;
    this.onCsrfUpdate?.(token);
  }

  thumbnailUrl(fileId: string): string {
    return `${this.baseUrl}/api/files/${encodeURIComponent(fileId)}/thumbnail`;
  }

  previewUrl(fileId: string): string {
    return `${this.baseUrl}/api/files/${encodeURIComponent(fileId)}/preview`;
  }

  downloadUrl(fileId: string): string {
    return `${this.baseUrl}/api/files/${encodeURIComponent(fileId)}/download`;
  }

  private async requestRaw(
    method: string,
    path: string,
    options?: {
      body?: BodyInit | null;
      headers?: Record<string, string>;
      skipUnauthorizedHook?: boolean;
    },
  ): Promise<Response> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      ...(options?.headers ?? {}),
    };
    if (MUTATING_METHODS.has(method.toUpperCase()) && this.csrfToken) {
      headers['X-Csrf-Token'] = this.csrfToken;
    }

    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: options?.body ?? undefined,
      credentials: 'include',
    });

    if (response.status === 401 && !options?.skipUnauthorizedHook) {
      this.onUnauthorized?.();
    }

    if (!response.ok) {
      await this.throwApiError(response);
    }
    return response;
  }

  private async throwApiError(response: Response): Promise<never> {
    let code = `http_${response.status}`;
    let offset: number | undefined;

    const headerOffset = response.headers.get('upload-offset');
    if (headerOffset != null && /^\d+$/.test(headerOffset)) {
      offset = Number(headerOffset);
    }

    try {
      const text = await response.text();
      if (text) {
        const parsed = JSON.parse(text) as { error?: string; offset?: number };
        if (parsed.error) code = parsed.error;
        if (typeof parsed.offset === 'number') offset = parsed.offset;
      }
    } catch {
      // Non-JSON error body
    }

    throw new MyDriveApiError(response.status, code, code, offset);
  }

  private async requestJson<T>(
    method: string,
    path: string,
    jsonBody?: unknown,
    extraHeaders?: Record<string, string>,
    skipUnauthorizedHook = false,
  ): Promise<T> {
    const headers: Record<string, string> = { ...(extraHeaders ?? {}) };
    let body: string | undefined;
    if (jsonBody !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(jsonBody);
    }
    const response = await this.requestRaw(method, path, {
      body,
      headers,
      skipUnauthorizedHook,
    });
    if (response.status === 204) {
      return undefined as T;
    }
    return (await response.json()) as T;
  }

  async getCapabilities(): Promise<ServerCapabilities> {
    return this.requestJson<ServerCapabilities>('GET', '/.well-known/cloud-client', undefined, undefined, true);
  }

  async login(email: string, password: string): Promise<LoginResponse> {
    const result = await this.requestJson<LoginResponse>(
      'POST',
      '/api/auth/login',
      { email: email.trim(), password },
      undefined,
      true,
    );
    this.setCsrfToken(result.csrf_token);
    return result;
  }

  async me(): Promise<User> {
    return this.requestJson<User>('GET', '/api/auth/me');
  }

  async changePassword(currentPassword: string, newPassword: string): Promise<void> {
    await this.requestJson<void>('POST', '/api/auth/password', {
      current_password: currentPassword,
      new_password: newPassword,
    });
  }

  async logout(): Promise<void> {
    try {
      await this.requestJson<void>('POST', '/api/auth/logout');
    } finally {
      this.setCsrfToken(null);
    }
  }

  async getStorage(): Promise<AccountStorage> {
    return this.requestJson<AccountStorage>('GET', '/api/storage');
  }

  async listPhotos(cursor?: string | null, limit = 60): Promise<PhotoPage> {
    const query = buildQuery({ cursor: cursor ?? undefined, limit });
    return this.requestJson<PhotoPage>('GET', `/api/photos${query}`);
  }

  async listAlbums(): Promise<Album[]> {
    const result = await this.requestJson<{ albums: Album[] }>('GET', '/api/albums');
    return result.albums;
  }

  async createAlbum(name: string): Promise<Album> {
    return this.requestJson<Album>('POST', '/api/albums', { name: name.trim() });
  }

  async listAlbumItems(albumId: string, offset = 0, limit = 60): Promise<AlbumItemPage> {
    const query = buildQuery({ offset, limit });
    return this.requestJson<AlbumItemPage>('GET', `/api/albums/${encodeURIComponent(albumId)}/items${query}`);
  }

  async addAlbumItems(albumId: string, fileIds: string[]): Promise<void> {
    await this.requestJson<void>('POST', `/api/albums/${encodeURIComponent(albumId)}/items`, {
      file_ids: fileIds,
    });
  }

  async listFolder(params: ListFolderParams = {}): Promise<EntryPage> {
    const query = buildQuery({
      parent_id: params.parentId ?? undefined,
      offset: params.offset,
      limit: params.limit ?? 100,
      sort_by: params.sortBy,
      order: params.order,
      include_stats: params.includeStats,
    });
    return this.requestJson<EntryPage>('GET', `/api/drive${query}`);
  }

  async searchDrive(params: SearchDriveParams): Promise<EntryPage> {
    const query = buildQuery({ ...params });
    return this.requestJson<EntryPage>('GET', `/api/drive/search${query}`);
  }

  async getEntryDetails(entryId: string): Promise<EntryDetails> {
    return this.requestJson<EntryDetails>('GET', `/api/entries/${encodeURIComponent(entryId)}/details`);
  }

  async createFolder(name: string, parentId: string | null = null): Promise<Entry> {
    return this.requestJson<Entry>('POST', '/api/folders', {
      name: name.trim(),
      parent_id: parentId,
    });
  }

  async renameEntry(entryId: string, name: string): Promise<Entry> {
    return this.requestJson<Entry>('PATCH', `/api/entries/${encodeURIComponent(entryId)}/rename`, {
      name: name.trim(),
    });
  }

  async moveEntry(entryId: string, parentId: string | null): Promise<Entry> {
    return this.requestJson<Entry>('POST', `/api/entries/${encodeURIComponent(entryId)}/move`, {
      parent_id: parentId,
    });
  }

  async trashEntry(entryId: string): Promise<void> {
    await this.requestJson<void>('DELETE', `/api/entries/${encodeURIComponent(entryId)}`);
  }

  async restoreEntry(entryId: string): Promise<Entry> {
    return this.requestJson<Entry>('POST', `/api/entries/${encodeURIComponent(entryId)}/restore`);
  }

  async listTrash(offset = 0, limit = 100): Promise<EntryPage> {
    const query = buildQuery({ offset, limit });
    return this.requestJson<EntryPage>('GET', `/api/drive/trash${query}`);
  }

  async ensureBackupFolder(path: string): Promise<{ id: string; created: boolean }> {
    return this.requestJson<{ id: string; created: boolean }>('POST', '/api/backup/folders', {
      path,
    });
  }

  async checkBackupContent(params: {
    parent_id: string | null;
    name: string;
    size_bytes: number;
    checksum_sha256: string;
  }): Promise<BackupCheckResponse> {
    return this.requestJson<BackupCheckResponse>('POST', '/api/backup/check', params);
  }

  async linkBackupContent(params: {
    parent_id: string | null;
    name: string;
    size_bytes: number;
    checksum_sha256: string;
    modified_at?: string | null;
  }): Promise<BackupLinkResponse> {
    return this.requestJson<BackupLinkResponse>('POST', '/api/backup/link', {
      parent_id: params.parent_id,
      name: params.name,
      size_bytes: params.size_bytes,
      checksum_sha256: params.checksum_sha256,
      ...(params.modified_at ? { modified_at: params.modified_at } : {}),
    });
  }

  async createUpload(params: {
    filename: string;
    expected_size: number;
    parent_id?: string | null;
    file_id?: string | null;
    original_modified_at?: string | null;
  }): Promise<UploadCreated> {
    return this.requestJson<UploadCreated>('POST', '/api/uploads', {
      filename: params.filename,
      expected_size: params.expected_size,
      parent_id: params.parent_id ?? null,
      ...(params.file_id ? { file_id: params.file_id } : {}),
      ...(params.original_modified_at ? { original_modified_at: params.original_modified_at } : {}),
    });
  }

  async headUploadOffset(uploadId: string): Promise<number> {
    const response = await this.requestRaw('HEAD', `/api/uploads/${encodeURIComponent(uploadId)}`);
    const raw = response.headers.get('upload-offset');
    return raw && /^\d+$/.test(raw) ? Number(raw) : 0;
  }

  async patchUploadChunk(uploadId: string, offset: number, chunk: BodyInit): Promise<number> {
    const response = await this.requestRaw('PATCH', `/api/uploads/${encodeURIComponent(uploadId)}`, {
      body: chunk,
      headers: {
        'Content-Type': 'application/offset+octet-stream',
        'Upload-Offset': String(offset),
        'Tus-Resumable': '1.0.0',
      },
    });
    const nextRaw = response.headers.get('upload-offset');
    return nextRaw && /^\d+$/.test(nextRaw) ? Number(nextRaw) : offset;
  }

  async finalizeUpload(uploadId: string, sha256: string): Promise<UploadFinalized> {
    return this.requestJson<UploadFinalized>(
      'POST',
      `/api/uploads/${encodeURIComponent(uploadId)}/finalize`,
      undefined,
      {
        'X-Content-SHA256': sha256,
      },
    );
  }
}
