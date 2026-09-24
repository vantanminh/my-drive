import { useEffect, useState } from 'react';

export type WorkspaceSection = 'drive' | 'shared' | 'trash' | 'photos' | 'storage';
export type DrivePanel = 'accounts' | 'faces' | 'indexing' | 'google-drive' | null;
export type PhotosTab = 'timeline' | 'people' | 'albums';
export type DriveSort = 'name' | 'updated_at' | 'created_at' | 'size';
export type DriveOrder = 'asc' | 'desc';

export type DriveFilters = {
  category: string;
  minSize: string;
  maxSize: string;
  createdFrom: string;
  createdTo: string;
  modifiedFrom: string;
  modifiedTo: string;
  mime: string;
  inFolder: boolean;
};

export type DriveRoute = {
  section: WorkspaceSection;
  folderIds: string[];
  panel: DrivePanel;
  query: string;
  fileId: string | null;
  albumId: string | null;
  personId: string | null;
  photosTab: PhotosTab;
  sort: DriveSort;
  order: DriveOrder;
  filters: DriveFilters;
};

export type NamedEntry = {
  id: string;
  name: string;
};

export type PublicRoute = {
  token: string;
  folderIds: string[];
  fileId: string | null;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const emptyFilters = (): DriveFilters => ({
  category: '',
  minSize: '',
  maxSize: '',
  createdFrom: '',
  createdTo: '',
  modifiedFrom: '',
  modifiedTo: '',
  mime: '',
  inFolder: false
});

export function hasActiveFilters(filters: DriveFilters): boolean {
  return Boolean(
    filters.category || filters.minSize || filters.maxSize || filters.createdFrom || filters.createdTo
    || filters.modifiedFrom || filters.modifiedTo || filters.mime || filters.inFolder
  );
}

function blankRoute(partial: Partial<DriveRoute> = {}): DriveRoute {
  return {
    section: 'drive',
    folderIds: [],
    panel: null,
    query: '',
    fileId: null,
    albumId: null,
    personId: null,
    photosTab: 'timeline',
    sort: 'name',
    order: 'asc',
    filters: emptyFilters(),
    ...partial
  };
}

export function slugifyName(name: string): string {
  const slug = name
    .normalize('NFC')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'item';
}

export function segmentFor(name: string, id: string): string {
  return slugifyName(name) + '--' + id.toLowerCase();
}

export function idFromSegment(segment: string): string | null {
  const separator = segment.lastIndexOf('--');
  if (separator < 0) return null;
  const id = segment.slice(separator + 2);
  return UUID_RE.test(id) ? id.toLowerCase() : null;
}

function splitPath(pathname: string): string[] {
  return pathname.split('/').filter(Boolean).map((part) => {
    try {
      return decodeURIComponent(part);
    } catch {
      return part;
    }
  });
}

function searchParams(search: string): URLSearchParams {
  const value = search.startsWith('?') ? search.slice(1) : search;
  return new URLSearchParams(value);
}

function fileIdFromSearch(params: URLSearchParams): string | null {
  const fileId = params.get('file');
  return fileId && UUID_RE.test(fileId) ? fileId.toLowerCase() : null;
}

function panelFromSearch(params: URLSearchParams): DrivePanel {
  const panel = params.get('panel');
  if (panel === 'accounts' || panel === 'faces' || panel === 'indexing' || panel === 'google-drive') return panel;
  return null;
}

function sortFromSearch(params: URLSearchParams): DriveSort {
  const sort = params.get('sort');
  if (sort === 'name' || sort === 'updated_at' || sort === 'created_at' || sort === 'size') return sort;
  return 'name';
}

function orderFromSearch(params: URLSearchParams): DriveOrder {
  return params.get('order') === 'desc' ? 'desc' : 'asc';
}

function filtersFromSearch(params: URLSearchParams): DriveFilters {
  return {
    category: params.get('type') ?? '',
    minSize: params.get('min') ?? '',
    maxSize: params.get('max') ?? '',
    createdFrom: params.get('created_from') ?? '',
    createdTo: params.get('created_to') ?? '',
    modifiedFrom: params.get('modified_from') ?? '',
    modifiedTo: params.get('modified_to') ?? '',
    mime: params.get('mime') ?? '',
    inFolder: params.get('in') === 'folder'
  };
}

function writeFilters(params: URLSearchParams, filters: DriveFilters) {
  if (filters.category) params.set('type', filters.category);
  if (filters.minSize) params.set('min', filters.minSize);
  if (filters.maxSize) params.set('max', filters.maxSize);
  if (filters.createdFrom) params.set('created_from', filters.createdFrom);
  if (filters.createdTo) params.set('created_to', filters.createdTo);
  if (filters.modifiedFrom) params.set('modified_from', filters.modifiedFrom);
  if (filters.modifiedTo) params.set('modified_to', filters.modifiedTo);
  if (filters.mime) params.set('mime', filters.mime);
  if (filters.inFolder) params.set('in', 'folder');
}

export function parseDriveRoute(pathname: string, search = ''): DriveRoute {
  const params = searchParams(search);
  const parts = splitPath(pathname);
  const drive = blankRoute();

  if (parts[0] === 'photos') {
    const photos = blankRoute({ section: 'photos', fileId: fileIdFromSearch(params) });
    if (parts[1] === 'people') {
      photos.photosTab = 'people';
      if (parts[2] && UUID_RE.test(parts[2])) photos.personId = parts[2].toLowerCase();
      return photos;
    }
    if (parts[1] === 'albums') {
      photos.photosTab = 'albums';
      if (parts[2] && UUID_RE.test(parts[2])) photos.albumId = parts[2].toLowerCase();
      return photos;
    }
    return photos;
  }
  if (parts[0] === 'storage' && parts.length === 1) return blankRoute({ section: 'storage' });

  if (parts.length === 0 || parts[0] === 'drive') {
    const folderIds: string[] = [];
    let valid = true;
    for (const part of parts.slice(parts[0] === 'drive' ? 1 : 0)) {
      const id = idFromSegment(part);
      if (!id) {
        valid = false;
        break;
      }
      folderIds.push(id);
    }
    if (!valid) return drive;
    return blankRoute({
      section: 'drive',
      folderIds,
      panel: panelFromSearch(params),
      query: params.get('q') ?? '',
      fileId: fileIdFromSearch(params),
      sort: sortFromSearch(params),
      order: orderFromSearch(params),
      filters: filtersFromSearch(params)
    });
  }

  if (parts[0] === 'shared' && parts.length === 1) return blankRoute({ section: 'shared' });
  if (parts[0] === 'trash' && parts.length === 1) return blankRoute({ section: 'trash' });
  if (parts[0] === 'accounts' && parts.length === 1) return blankRoute({ panel: 'accounts' });
  if (parts[0] === 'faces' && parts.length === 1) return blankRoute({ panel: 'faces' });
  if (parts[0] === 'indexing' && parts.length === 1) return blankRoute({ panel: 'indexing' });
  if (parts[0] === 'google-drive' && parts.length === 1) return blankRoute({ panel: 'google-drive' });
  return drive;
}

export function buildDrivePath(route: DriveRoute, folders: NamedEntry[]): string {
  if (route.section === 'shared') return '/shared';
  if (route.section === 'trash') return '/trash';
  if (route.section === 'storage') return '/storage';
  if (route.section === 'photos') {
    const parts = ['photos'];
    if (route.photosTab === 'people') {
      parts.push('people');
      if (route.personId) parts.push(route.personId);
    } else if (route.photosTab === 'albums') {
      parts.push('albums');
      if (route.albumId) parts.push(route.albumId);
    }
    const params = new URLSearchParams();
    if (route.fileId) params.set('file', route.fileId.toLowerCase());
    const query = params.toString();
    return '/' + parts.map((part) => encodeURIComponent(part)).join('/') + (query ? '?' + query : '');
  }

  const folderPath = folders.map((folder) => segmentFor(folder.name, folder.id));
  const params = new URLSearchParams();
  if (route.panel && (folderPath.length > 0 || route.query || route.fileId || hasActiveFilters(route.filters))) {
    params.set('panel', route.panel);
  }
  if (route.query) params.set('q', route.query);
  if (route.fileId) params.set('file', route.fileId.toLowerCase());
  if (route.sort !== 'name') params.set('sort', route.sort);
  if (route.order !== 'asc') params.set('order', route.order);
  writeFilters(params, route.filters);
  const query = params.toString();
  const suffix = query ? '?' + query : '';

  if (folderPath.length === 0 && !query) {
    if (route.panel === 'accounts') return '/accounts';
    if (route.panel === 'faces') return '/faces';
    if (route.panel === 'indexing') return '/indexing';
    if (route.panel === 'google-drive') return '/google-drive';
    return '/drive';
  }

  return '/' + ['drive', ...folderPath].map((part) => encodeURIComponent(part)).join('/') + suffix;
}

export function parsePublicRoute(pathname: string, search = ''): PublicRoute | null {
  const parts = splitPath(pathname);
  if (parts[0] !== 's' || !parts[1]) return null;
  const folderIds: string[] = [];
  for (const part of parts.slice(2)) {
    const id = idFromSegment(part);
    if (!id) return { token: parts[1], folderIds: [], fileId: null };
    folderIds.push(id);
  }
  return {
    token: parts[1],
    folderIds,
    fileId: fileIdFromSearch(searchParams(search))
  };
}

export function buildPublicPath(token: string, folders: NamedEntry[], fileId: string | null): string {
  const parts = ['s', token, ...folders.map((folder) => segmentFor(folder.name, folder.id))];
  const params = new URLSearchParams();
  if (fileId) params.set('file', fileId.toLowerCase());
  const query = params.toString();
  return '/' + parts.map((part) => encodeURIComponent(part)).join('/') + (query ? '?' + query : '');
}

export function currentHref(): string {
  return window.location.pathname + window.location.search;
}

function hrefOf(path: string): string {
  const url = new URL(path, 'http://localhost');
  return url.pathname + url.search;
}

export function clearSearchParam(name: string, mode: 'push' | 'replace' = 'replace') {
  const params = new URLSearchParams(window.location.search);
  params.delete(name);
  const search = params.toString();
  navigateTo(window.location.pathname + (search ? '?' + search : ''), mode);
}

export function navigateTo(path: string, mode: 'push' | 'replace' = 'push') {
  const next = hrefOf(path);
  if (currentHref() === next) return;
  const method = mode === 'push' ? 'pushState' : 'replaceState';
  window.history[method](null, '', next);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

export function useBrowserHref(): string {
  const [href, setHref] = useState(currentHref);
  useEffect(() => {
    const sync = () => setHref(currentHref());
    window.addEventListener('popstate', sync);
    return () => window.removeEventListener('popstate', sync);
  }, []);
  return href;
}
