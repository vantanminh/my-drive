import { useEffect, useState } from 'react';

export type WorkspaceSection = 'drive' | 'shared' | 'trash';
export type DrivePanel = 'accounts' | 'faces' | 'indexing' | null;

export type DriveRoute = {
  section: WorkspaceSection;
  folderIds: string[];
  panel: DrivePanel;
  query: string;
  fileId: string | null;
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
  if (panel === 'accounts' || panel === 'faces' || panel === 'indexing') return panel;
  return null;
}

export function parseDriveRoute(pathname: string, search = ''): DriveRoute {
  const params = searchParams(search);
  const parts = splitPath(pathname);
  const drive: DriveRoute = {
    section: 'drive',
    folderIds: [],
    panel: null,
    query: '',
    fileId: null
  };

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
    return {
      section: 'drive',
      folderIds,
      panel: panelFromSearch(params),
      query: params.get('q') ?? '',
      fileId: fileIdFromSearch(params)
    };
  }

  if (parts[0] === 'shared' && parts.length === 1) return { ...drive, section: 'shared' };
  if (parts[0] === 'trash' && parts.length === 1) return { ...drive, section: 'trash' };
  if (parts[0] === 'accounts' && parts.length === 1) return { ...drive, panel: 'accounts' };
  if (parts[0] === 'faces' && parts.length === 1) return { ...drive, panel: 'faces' };
  if (parts[0] === 'indexing' && parts.length === 1) return { ...drive, panel: 'indexing' };
  return drive;
}

export function buildDrivePath(route: DriveRoute, folders: NamedEntry[]): string {
  if (route.section === 'shared') return '/shared';
  if (route.section === 'trash') return '/trash';

  const folderPath = folders.map((folder) => segmentFor(folder.name, folder.id));
  const params = new URLSearchParams();
  if (route.panel && (folderPath.length > 0 || route.query || route.fileId)) params.set('panel', route.panel);
  if (route.query) params.set('q', route.query);
  if (route.fileId) params.set('file', route.fileId.toLowerCase());
  const query = params.toString();
  const suffix = query ? '?' + query : '';

  if (folderPath.length === 0 && !query) {
    if (route.panel === 'accounts') return '/accounts';
    if (route.panel === 'faces') return '/faces';
    if (route.panel === 'indexing') return '/indexing';
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
