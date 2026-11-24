import { useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent, type MouseEvent } from 'react';
import {
  ArrowUpCircle, Check, ChevronDown, ChevronRight, CircleUserRound, ClipboardPaste, Cloud, CloudUpload, Copy, Download, Eye, File, FileImage, Film,
  FileSpreadsheet, FileText, Folder, FolderInput, FolderPlus, Gauge, HardDrive, Images, Info, LayoutGrid, List, LockKeyhole, LogOut, MoreHorizontal,
  Pause, Play, Presentation, RotateCcw, Scissors, Search, Settings, Share2, SlidersHorizontal, Trash2, Upload, Users, X
} from 'lucide-react';
import { ApiError, api, downloadUrl, thumbnailUrl } from '../api';
import { formatDate, formatSize, friendlyError } from '../format';
import {
  ThroughputTracker,
  finalizeUploadWithRetry,
  uploadFileChunksResilient,
} from '../uploadEngine';
import { buildDrivePath, clearSearchParam, emptyFilters, hasActiveFilters, navigateTo, parseDriveRoute, useBrowserHref, type DriveFilters, type DriveOrder, type DrivePanel, type DriveSort } from '../route';
import { nextSelection, selectionGesture } from '../selection';
import { useI18n, type MessageKey } from '../i18n';
import type { Entry, EntryDetails, EntryPage, ShareSummary, User } from '../types';
import ShareDialog from './ShareDialog';
import { AnchoredMenu, ContextMenu, type MenuItem } from './ContextMenu';
import DestinationDialog from './DestinationDialog';
import FilePreviewer from './FilePreviewer';
import { isFilePreviewable, mediaKindFor } from './MediaViewer';
import PhotosPage from './PhotosPage';
import StoragePage, { QuotaCard } from './StoragePage';
import SettingsPage from './SettingsPage';
import { setActiveTeamWorkspace } from '../api';
import type { TeamSummary } from '../types';

type Props = {
  user: User;
  onLoggedOut: () => void;
};

type Section = 'drive' | 'shared' | 'trash' | 'photos' | 'storage';
type Breadcrumb = { id: string; name: string };
type Modal =
  | { kind: 'new-folder' }
  | { kind: 'rename'; entry: Entry }
  | { kind: 'destination'; action: 'move' | 'copy'; ids: string[] }
  | null;

type ShareSubject = { id: string; kind: 'file' | 'folder' | 'album'; name: string };
type DriveClipboard = { mode: 'copy' | 'cut'; ids: string[] };

type SavedUpload = {
  schema: 1;
  id: string;
  name: string;
  size: number;
  lastModified: number;
  parentId: string | null;
  createdAt: number;
  uploadedBytes?: number;
};

type UploadStatus = 'queued' | 'uploading' | 'retrying' | 'paused' | 'done' | 'error';
type UploadJob = {
  key: string;
  uploadId: string | null;
  name: string;
  size: number;
  uploadedBytes: number;
  progress: number;
  speed: number;
  status: UploadStatus;
  detail: string;
  saved?: SavedUpload;
};

type UploadTask = {
  key: string;
  file: File | null;
  parentId: string | null;
  session: SavedUpload | null;
  action: 'pause' | 'cancel' | null;
  controller: AbortController | null;
  finalizing: boolean;
  uploadedBytes: number;
  speed: number;
  tracker: ThroughputTracker;
};

const RESUME_KEY = 'my-drive.upload-sessions.v1';
const MAX_CONCURRENT_UPLOADS = 2;

function formatUploadEta(seconds: number | null): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return '—';
  const total = Math.ceil(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remainingSeconds = total % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${remainingSeconds}s`;
  return `${remainingSeconds}s`;
}

function readSavedUploads(): SavedUpload[] {
  try {
    const value = JSON.parse(localStorage.getItem(RESUME_KEY) || '[]') as unknown;
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is SavedUpload =>
      !!item && typeof item === 'object' && (item as SavedUpload).schema === 1 &&
      typeof (item as SavedUpload).id === 'string' && typeof (item as SavedUpload).name === 'string'
    );
  } catch {
    return [];
  }
}

function writeSavedUploads(uploads: SavedUpload[]) {
  localStorage.setItem(RESUME_KEY, JSON.stringify(uploads));
}

function fileMatches(file: File, saved: SavedUpload, parentId: string | null): boolean {
  return file.name === saved.name && file.size === saved.size &&
    file.lastModified === saved.lastModified && parentId === saved.parentId;
}

function extensionIcon(entry: { kind: string; name: string }) {
  if (entry.kind === 'folder') return <Folder size={20} strokeWidth={1.8} className="file-icon folder-icon" />;
  if (entry.kind === 'album') return <Images size={20} strokeWidth={1.8} className="file-icon image-icon" />;
  const name = entry.name.toLowerCase();
  if (/\.(png|jpe?g|gif|webp|avif|bmp|ico|svg|tiff?|heic|heif)$/.test(name)) return <FileImage size={20} strokeWidth={1.8} className="file-icon image-icon" />;
  if (/\.(mp4|m4v|webm|mov|qt|mkv|mk3d|avi|ogv|ogg|mpg|mpeg|mpe|ts|mts|m2ts|flv|wmv|asf|3gp|3g2)$/.test(name)) return <Film size={20} strokeWidth={1.8} className="file-icon video-icon" />;
  if (/\.(pptx?)$/.test(name)) return <Presentation size={20} strokeWidth={1.8} className="file-icon document-icon" />;
  if (/\.(pdf|docx?|txt|md|markdown|json|rtf)$/.test(name)) return <FileText size={20} strokeWidth={1.8} className="file-icon document-icon" />;
  if (/\.(xlsx?|csv|numbers)$/.test(name)) return <FileSpreadsheet size={20} strokeWidth={1.8} className="file-icon sheet-icon" />;
  return <File size={20} strokeWidth={1.8} className="file-icon" />;
}

const INDEXED_THUMBNAIL_MIMES = new Set([
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif', 'image/bmp', 'image/x-icon', 'image/tiff', 'image/heic', 'image/heif',
  'video/mp4', 'video/webm', 'video/quicktime', 'video/x-matroska', 'video/x-msvideo',
  'video/ogg', 'video/mpeg', 'video/mp2t', 'video/x-flv', 'video/x-ms-wmv', 'video/3gpp'
]);

function hasIndexedCardPreview(entry: Entry): boolean {
  if (entry.mime_detected) return INDEXED_THUMBNAIL_MIMES.has(entry.mime_detected);
  return /\.(jpe?g|png|gif|webp|avif|bmp|ico|tiff?|heic|heif|mp4|m4v|webm|mov|qt|mkv|mk3d|avi|ogv|ogg|mpg|mpeg|mpe|ts|mts|m2ts|flv|wmv|asf|3gp|3g2)$/i.test(entry.name);
}

function EntryVisual({ entry, showThumbnail }: { entry: Entry; showThumbnail: boolean }) {
  const [attempt, setAttempt] = useState(0);
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const canPreview = entry.kind === 'file' && showThumbnail && hasIndexedCardPreview(entry);

  useEffect(() => {
    if (!failed || attempt >= 2) return;
    const timer = window.setTimeout(() => {
      setFailed(false);
      setLoaded(false);
      setAttempt((current) => current + 1);
    }, 5000 * (attempt + 1));
    return () => window.clearTimeout(timer);
  }, [attempt, failed]);

  return (
    <span className="entry-visual" aria-hidden="true">
      {!canPreview || !loaded ? extensionIcon(entry) : null}
      {canPreview && !failed ? (
        <img
          key={attempt}
          className={'entry-thumbnail' + (loaded ? ' is-ready' : '')}
          src={thumbnailUrl(entry.id) + '?retry=' + attempt}
          alt=""
          loading="lazy"
          decoding="async"
          onLoad={() => setLoaded(true)}
          onError={() => setFailed(true)}
        />
      ) : null}
    </span>
  );
}

function searchFilters(filters: DriveFilters, folderId: string | null, sort: DriveSort, order: DriveOrder) {
  return {
    category: filters.category || undefined,
    min_size: megabytesToBytes(filters.minSize),
    max_size: megabytesToBytes(filters.maxSize),
    created_from: filters.createdFrom || undefined,
    created_to: filters.createdTo || undefined,
    modified_from: filters.modifiedFrom || undefined,
    modified_to: filters.modifiedTo || undefined,
    folder_id: filters.inFolder && folderId ? folderId : undefined,
    mime: mimePrefix(filters.mime),
    sort_by: sort,
    order
  };
}

function megabytesToBytes(input: string): number | undefined {
  const trimmed = input.trim().replace(/\.$/, '');
  if (!trimmed) return undefined;
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value < 0) return undefined;
  return Math.round(value * 1024 * 1024);
}

function mimePrefix(input: string): string | undefined {
  const value = input.trim().toLowerCase();
  if (!/^[a-z0-9.+-]+\/[a-z0-9.+*-]*$/.test(value)) return undefined;
  return value;
}

function filtersReady(filters: DriveFilters, folderId: string | null): boolean {
  const compiled = searchFilters(filters, folderId, 'name', 'asc');
  return Boolean(
    compiled.category || compiled.mime || compiled.min_size != null || compiled.max_size != null
    || compiled.created_from || compiled.created_to || compiled.modified_from || compiled.modified_to
    || compiled.folder_id
  );
}

function entrySize(entry: Entry): string {
  if (entry.kind === 'folder') return entry.folder_bytes == null ? '—' : formatSize(entry.folder_bytes);
  return formatSize(entry.size_bytes);
}

async function folderChain(leafId: string): Promise<Breadcrumb[]> {
  const chain: Breadcrumb[] = [];
  const seen = new Set<string>();
  let current = await api.getEntry(leafId);
  while (true) {
    if (current.deleted_at || current.kind !== 'folder' || seen.has(current.id)) {
      throw new ApiError(404, 'not_found');
    }
    seen.add(current.id);
    chain.unshift({ id: current.id, name: current.name });
    if (!current.parent_id) return chain;
    current = await api.getEntry(current.parent_id);
  }
}

function displayShareStatus(share: ShareSummary): { label: MessageKey; className: string } {
  if (share.revoked_at) return { label: 'status.revoked', className: 'status-neutral' };
  if (share.expires_at && new Date(share.expires_at).getTime() <= Date.now()) {
    return { label: 'status.expired', className: 'status-neutral' };
  }
  if (share.max_downloads != null && share.download_count >= share.max_downloads) {
    return { label: 'status.limit', className: 'status-warning' };
  }
  return { label: 'status.active', className: 'status-active' };
}


function EntryMenu({ label, items }: { label: string; items: MenuItem[] }) {
  return (
    <AnchoredMenu label={label} items={items}>
      <MoreHorizontal size={18} />
    </AnchoredMenu>
  );
}

function isSystemFolder(entry: Entry): boolean {
  return entry.kind === 'folder' && entry.system_role === 'photos';
}

function downloadFiles(ids: string[]) {
  ids.forEach((id, index) => {
    window.setTimeout(() => {
      const link = document.createElement('a');
      link.href = downloadUrl(id);
      link.rel = 'noopener';
      document.body.appendChild(link);
      link.click();
      link.remove();
    }, index * 220);
  });
}

export default function DriveApp({ user, onLoggedOut }: Props) {
  const { t } = useI18n();
  const href = useBrowserHref();
  const route = useMemo(() => {
    const search = href.includes('?') ? href.slice(href.indexOf('?')) : '';
    const pathname = href.includes('?') ? href.slice(0, href.indexOf('?')) : href;
    return parseDriveRoute(pathname, search);
  }, [href]);
  const section = route.section;
  const panel: DrivePanel = section === 'settings' ? route.panel : null;
  const query = section === 'drive' ? route.query : '';
  const [breadcrumbs, setBreadcrumbs] = useState<Breadcrumb[]>([]);
  const breadcrumbsRef = useRef<Breadcrumb[]>([]);
  const locationExtras = useRef({ panel, query, fileId: route.fileId });
  locationExtras.current = { panel, query, fileId: route.fileId };
  const folderKey = route.folderIds.join('/');
  const pathReady = section !== 'drive' || route.folderIds.length === 0 || breadcrumbs.map((crumb) => crumb.id).join('/') === folderKey;
  const currentFolderId = section !== 'drive'
    ? null
    : pathReady
      ? (breadcrumbs.at(-1)?.id ?? null)
      : (route.folderIds.at(-1) ?? null);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [shares, setShares] = useState<ShareSummary[]>([]);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [modal, setModal] = useState<Modal>(null);
  const [shareTargets, setShareTargets] = useState<ShareSubject[] | null>(null);
  const [viewer, setViewer] = useState<Entry | null>(null);
  const teamsOpen = section === 'settings' && panel === 'teams';
  const [activeTeam, setActiveTeam] = useState<TeamSummary | null>(null);
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [latestUpdateTag, setLatestUpdateTag] = useState<string | null>(null);
  useEffect(() => {
    if (user.role !== 'owner') return;
    const controller = new AbortController();
    api.updatesStatus(controller.signal)
      .then((snapshot) => {
        setUpdateAvailable(snapshot.latest.updateAvailable);
        setLatestUpdateTag(snapshot.latest.tag);
      })
      .catch(() => {
        // Ignore transient startup/network errors for passive badge checks.
      });
    return () => controller.abort();
  }, [user.role]);
  const [shareRefresh, setShareRefresh] = useState(0);
  const [jobs, setJobs] = useState<UploadJob[]>(() =>
    readSavedUploads().map((saved) => ({
      key: saved.id,
      uploadId: saved.id,
      name: saved.name,
      size: saved.size,
      uploadedBytes: Math.min(saved.size, Math.max(0, saved.uploadedBytes || 0)),
      progress: saved.size ? (Math.min(saved.size, Math.max(0, saved.uploadedBytes || 0)) / saved.size) * 100 : 100,
      speed: 0,
      status: 'paused',
      detail: t('upload.detail.resume'),
      saved
    }))
  );
  const uploadQueueRef = useRef<UploadTask[]>([]);
  const activeUploadsRef = useRef<Map<string, UploadTask>>(new Map());
  const uploadTasksRef = useRef<Map<string, UploadTask>>(new Map());
  const [uploadManagerOpen, setUploadManagerOpen] = useState(false);
  const [resumeTargetId, setResumeTargetId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const timer = window.setInterval(() => {
      const now = Date.now();
      setJobs((items) => {
        let changed = false;
        const next = items.map((job) => {
          const task = activeUploadsRef.current.get(job.key);
          if (!task) return job;
          const speed = job.status === 'uploading' ? task.tracker.sampleSpeed(now) : 0;
          task.speed = speed;
          if (Math.abs(job.speed - speed) < 1) return job;
          changed = true;
          return { ...job, speed };
        });
        return changed ? next : items;
      });
    }, 500);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    const hasInFlight = jobs.some(
      (job) => job.status === 'uploading' || job.status === 'retrying',
    );
    if (!hasInFlight) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [jobs]);
  const shortcutLabel = navigator.platform.toLowerCase().includes('mac') ? '⌘ K' : 'Ctrl K';
  const activeSectionLabel = section === 'drive'
    ? (!pathReady ? t('heading.opening') : currentFolderId ? breadcrumbs[breadcrumbs.length - 1].name : (activeTeam ? activeTeam.name : t('section.my_drive')))
    : section === 'shared' ? t('section.shared')
      : section === 'photos' ? t('section.photos')
        : section === 'storage' ? t('section.storage')
          : section === 'settings' ? t('section.settings')
            : t('section.trash');
  const [viewMode, setViewMode] = useState<'list' | 'grid'>(() => window.localStorage.getItem('my-drive-view') === 'grid' ? 'grid' : 'list');
  const [filtersOpen, setFiltersOpen] = useState(() => hasActiveFilters(route.filters));
  const [trashSelection, setTrashSelection] = useState<string[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [selectionMode, setSelectionMode] = useState(false);
  const [clipboard, setClipboard] = useState<DriveClipboard | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; ids: string[] } | null>(null);
  const selectionAnchor = useRef<string | null>(null);
  const [detailsId, setDetailsId] = useState<string | null>(null);
  const [details, setDetails] = useState<EntryDetails | null>(null);

  function showDrive(
    overrides: {
      folders?: Breadcrumb[];
      query?: string;
      fileId?: string | null;
      filters?: DriveFilters;
      sort?: DriveSort;
      order?: DriveOrder;
    },
    mode: 'push' | 'replace' = 'push'
  ) {
    const folders = overrides.folders ?? breadcrumbsRef.current;
    breadcrumbsRef.current = folders;
    setBreadcrumbs(folders);
    navigateTo(buildDrivePath({
      ...route,
      section: 'drive',
      folderIds: folders.map((folder) => folder.id),
      panel: null,
      query: overrides.query === undefined ? query : overrides.query,
      fileId: overrides.fileId === undefined ? (section === 'drive' ? route.fileId : null) : overrides.fileId,
      filters: overrides.filters ?? route.filters,
      sort: overrides.sort ?? route.sort,
      order: overrides.order ?? route.order,
      albumId: null,
      personId: null,
      photosTab: 'timeline'
    }, folders), mode);
  }

  function openSettings(target: DrivePanel) {
    navigateTo(buildDrivePath({ ...route, section: 'settings', panel: target, folderIds: [], query: '', fileId: null, filters: emptyFilters() }, []));
  }

  useEffect(() => {
    const SETTINGS_TITLE_KEYS: Record<Exclude<DrivePanel, null> | 'general', MessageKey> = {
      general: 'settings.general',
      accounts: 'menu.manage_accounts',
      teams: 'menu.teams',
      faces: 'drive.face_groups',
      indexing: 'drive.media_indexing',
      'google-drive': 'nav.google_drive',
      security: 'menu.account_security',
      developer: 'menu.developer',
      updates: 'menu.system_updates',
      'network-drive': 'menu.network_drive'
    };
    const label = section === 'settings' ? t(SETTINGS_TITLE_KEYS[panel ?? 'general']) : activeSectionLabel;
    document.title = section === 'drive' && !currentFolderId && !activeTeam ? t('section.my_drive') : label + ' · ' + t('section.my_drive');
  }, [activeSectionLabel, panel, section, currentFolderId, activeTeam, t]);

  useEffect(() => {
    if (section !== 'drive' || route.folderIds.length === 0) {
      if (breadcrumbsRef.current.length) {
        breadcrumbsRef.current = [];
        setBreadcrumbs([]);
      }
      return;
    }
    if (breadcrumbsRef.current.map((crumb) => crumb.id).join('/') === folderKey) return;
    let cancelled = false;
    folderChain(route.folderIds[route.folderIds.length - 1])
      .then((chain) => {
        if (cancelled) return;
        breadcrumbsRef.current = chain;
        setBreadcrumbs(chain);
        const resolvedKey = chain.map((crumb) => crumb.id).join('/');
        if (resolvedKey === folderKey) return;
        const extras = locationExtras.current;
        navigateTo(buildDrivePath({
          ...route,
          section: 'drive',
          folderIds: chain.map((crumb) => crumb.id),
          panel: extras.panel,
          query: extras.query,
          fileId: extras.fileId
        }, chain), 'replace');
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        breadcrumbsRef.current = [];
        setBreadcrumbs([]);
        setNotice(friendlyError(cause));
        navigateTo('/drive', 'replace');
      });
    return () => {
      cancelled = true;
    };
  }, [folderKey, section]);

  useEffect(() => {
    if (section === 'drive' && route.folderIds.length > 0 && breadcrumbsRef.current.map((crumb) => crumb.id).join('/') !== folderKey) {
      return;
    }
    const folders = section === 'drive' ? breadcrumbsRef.current : [];
    navigateTo(buildDrivePath({
      ...route,
      section,
      folderIds: folders.map((folder) => folder.id),
      panel: section === 'settings' ? panel : null,
      query,
      fileId: section === 'drive' || section === 'photos' ? route.fileId : null
    }, folders), 'replace');
  }, [breadcrumbs, folderKey, panel, query, route, section]);

  useEffect(() => {
    if (section !== 'drive' || !route.fileId) {
      setViewer(null);
      return;
    }
    let cancelled = false;
    api.getEntry(route.fileId)
      .then((entry) => {
        if (cancelled) return;
        if (entry.kind !== 'file' || entry.deleted_at) {
          clearSearchParam('file');
          return;
        }
        setViewer(entry);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setNotice(friendlyError(cause));
        clearSearchParam('file');
      });
    return () => {
      cancelled = true;
    };
  }, [route.fileId, section]);

  useEffect(() => {
    function onKeyboardShortcut(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k' && section === 'drive') {
        event.preventDefault();
        searchInputRef.current?.focus();
      }
      if (event.key === 'Escape') {
        if (contextMenu) {
          setContextMenu(null);
          return;
        }
        setModal(null);
        setShareTargets(null);
        if (route.fileId) clearSearchParam('file');
        else setViewer(null);
        document.querySelectorAll('details[open]').forEach((element) => element.removeAttribute('open'));
        return;
      }
      const target = event.target;
      const typing = target instanceof HTMLElement && !!target.closest('input, textarea, select, [contenteditable="true"]');
      if (typing || section !== 'drive' || modal || shareTargets || viewer) return;
      const key = event.key.toLowerCase();
      const command = event.metaKey || event.ctrlKey;
      if (command && key === 'a') {
        event.preventDefault();
        setSelectedIds(entries.map((entry) => entry.id));
        setSelectionMode(true);
      } else if (command && key === 'c' && selectedIds.length) {
        event.preventDefault();
        setClipboard({ mode: 'copy', ids: selectedIds });
        setNotice(t('notice.copied', { count: selectedIds.length }));
      } else if (command && key === 'x' && selectedIds.length) {
        event.preventDefault();
        const ids = operableIds(selectedIds);
        if (!ids.length) {
          setError(t('error.photos_move'));
          return;
        }
        setClipboard({ mode: 'cut', ids });
        setNotice(t('notice.move_ready', { count: ids.length }));
      } else if (command && key === 'v' && clipboard) {
        event.preventDefault();
        void pasteClipboard();
      } else if ((event.key === 'Delete' || event.key === 'Backspace') && selectedIds.length) {
        event.preventDefault();
        void trashEntries(operableIds(selectedIds));
      }
    }
    window.addEventListener('keydown', onKeyboardShortcut);
    return () => window.removeEventListener('keydown', onKeyboardShortcut);
  }, [clipboard, contextMenu, currentFolderId, entries, modal, route.fileId, section, selectedIds, shareTargets, viewer]);

  useEffect(() => {
    if (section === 'photos' || section === 'storage' || section === 'settings') {
      setLoading(false);
      setEntries([]);
      return;
    }
    if (!pathReady) {
      setLoading(true);
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setLoading(true);
      setError('');
      if (section === 'shared') {
        api.listShares()
          .then((page) => {
            setShares(page.shares);
            setNextOffset(page.next_offset);
          })
          .catch((cause: unknown) => {
            if (cause instanceof ApiError && cause.status === 401) onLoggedOut();
            else setError(friendlyError(cause));
          })
          .finally(() => setLoading(false));
        return;
      }
      const filtering = filtersReady(route.filters, currentFolderId);
      const load = section === 'trash'
        ? api.listTrash(controller.signal)
        : query.trim() || filtering
          ? api.search(query.trim(), controller.signal, 0, searchFilters(route.filters, currentFolderId, route.sort, route.order))
          : api.listDrive(currentFolderId, controller.signal, 0, {
            sort_by: route.sort,
            order: route.order,
            include_stats: true
          });
      load
        .then((page) => {
          setEntries(page.entries);
          setNextOffset(page.next_offset);
        })
        .catch((cause: unknown) => {
          if (cause instanceof DOMException && cause.name === 'AbortError') return;
          if (cause instanceof ApiError && cause.status === 401) onLoggedOut();
          else setError(friendlyError(cause));
        })
        .finally(() => setLoading(false));
    }, section === 'drive' && (query.trim() || hasActiveFilters(route.filters)) ? 180 : 0);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [section, currentFolderId, pathReady, query, route.filters, route.order, route.sort, refresh, shareRefresh, activeTeam?.id, onLoggedOut]);

  useEffect(() => {
    window.localStorage.setItem('my-drive-view', viewMode);
  }, [viewMode]);

  useEffect(() => {
    setTrashSelection((current) => current.filter((id) => entries.some((entry) => entry.id === id)));
  }, [entries]);

  useEffect(() => {
    if (!detailsId || (section !== 'drive' && section !== 'trash')) {
      setDetails(null);
      return;
    }
    let cancelled = false;
    api.entryDetails(detailsId)
      .then((value) => {
        if (!cancelled) setDetails(value);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setDetails(null);
        setError(friendlyError(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [detailsId, section]);

  function patchFilters(patch: Partial<DriveFilters>) {
    showDrive({ filters: { ...route.filters, ...patch }, fileId: null }, 'replace');
  }

  function changeSort(value: string) {
    const [sort, order] = value.split(':') as [DriveSort, DriveOrder];
    showDrive({ sort, order, fileId: null }, 'replace');
  }

  async function purgeTrash(payload: { ids?: string[]; all?: boolean }, message: string) {
    try {
      const report = await api.purgeTrash(payload);
      setTrashSelection([]);
      setNotice(report.entries > 0 ? message : t('trash.nothing'));
      setRefresh((value) => value + 1);
    } catch (cause) {
      setError(friendlyError(cause));
    }
  }

  function selectTeamWorkspace(team: TeamSummary | null) {
    setActiveTeamWorkspace(team?.id ?? null);
    setActiveTeam(team);
    setDetailsId(null);
    setSelectedIds([]);
    setSelectionMode(false);
    setRefresh((current) => current + 1);
    showDrive({ folders: [], query: '', fileId: null, filters: emptyFilters() });
  }

  function navigate(sectionValue: Section) {
    setError('');
    setNotice('');
    if (sectionValue === 'drive') {
      showDrive({ query: '', fileId: null, filters: emptyFilters() });
      return;
    }
    if (sectionValue === 'photos') {
      navigateTo('/photos');
      return;
    }
    if (sectionValue === 'storage') {
      navigateTo('/storage');
      return;
    }
    navigateTo(sectionValue === 'shared' ? '/shared' : '/trash');
  }

  async function openFolder(entry: Entry) {
    try {
      const next = query.trim()
        ? await folderChain(entry.id)
        : [...breadcrumbsRef.current, { id: entry.id, name: entry.name }];
      setNotice('');
      showDrive({ folders: next, query: '', fileId: null });
    } catch (cause) {
      setError(friendlyError(cause));
    }
  }

  function goToBreadcrumb(index: number) {
    const next = index < 0 ? [] : breadcrumbsRef.current.slice(0, index + 1);
    showDrive({ folders: next, query: '', fileId: null });
  }

  function openPreview(entry: Entry) {
    setViewer(entry);
    showDrive({ fileId: entry.id }, 'replace');
  }

  function updateJob(key: string, update: Partial<UploadJob>) {
    setJobs((items) => {
      if (items.some((job) => job.key === key)) {
        return items.map((job) => job.key === key ? { ...job, ...update } : job);
      }
      return [...items, {
        key,
        uploadId: null,
        name: '',
        size: 0,
        uploadedBytes: 0,
        progress: 0,
        speed: 0,
        status: 'queued',
        detail: '',
        ...update
      }];
    });
  }

  async function moveTo(entry: Entry, targetId: string | null) {
    if (isSystemFolder(entry)) {
      setError(t('error.photos_move'));
      return false;
    }
    try {
      if (entry.kind === 'folder' && targetId) {
        let parent = await api.getEntry(targetId);
        while (true) {
          if (parent.id === entry.id) {
            setError(t('error.folder_into_itself'));
            return false;
          }
          if (!parent.parent_id) break;
          parent = await api.getEntry(parent.parent_id);
        }
      }
      await api.moveEntry(entry.id, targetId);
      setNotice(targetId ? t('notice.moved') : t('notice.moved_root'));
      setRefresh((value) => value + 1);
      return true;
    } catch (cause) {
      setError(friendlyError(cause));
      return false;
    }
  }

  function operableIds(ids: string[]): string[] {
    const blocked = new Set(entries.filter(isSystemFolder).map((entry) => entry.id));
    return ids.filter((id) => !blocked.has(id));
  }

  function chooseEntries(id: string, gesture: 'toggle' | 'range' | 'replace') {
    const result = nextSelection(selectedIds, entries.map((entry) => entry.id), id, gesture, selectionAnchor.current);
    selectionAnchor.current = result.anchor;
    setSelectedIds(result.ids);
    if (result.ids.length > 0) setSelectionMode(true);
  }

  function shareSubjects(ids: string[]): ShareSubject[] {
    return entries.filter((entry) => ids.includes(entry.id)).map((entry) => ({
      id: entry.id,
      kind: entry.kind,
      name: entry.name
    }));
  }

  async function runBatch(action: 'move' | 'copy' | 'trash', ids: string[], parentId?: string | null) {
    const allowed = action === 'trash' || action === 'move' || action === 'copy' ? operableIds(ids) : ids;
    if (allowed.length === 0) {
      setError(t('error.photos_all'));
      return;
    }
    const skipped = ids.length - allowed.length;
    const result = await api.batchEntries({
      action,
      ids: allowed,
      ...(action === 'trash' ? {} : { parent_id: parentId ?? null })
    });
    setRefresh((value) => value + 1);
    setSelectedIds(action === 'copy' && (parentId ?? null) === currentFolderId ? result.entry_ids : []);
    if (action === 'move') setClipboard((current) => current?.mode === 'cut' ? null : current);
    const verbKey = action === 'copy' ? 'notice.batch_copied' : action === 'move' ? 'notice.batch_moved' : 'notice.batch_trashed';
    setNotice(t(verbKey, { count: result.count }) + (skipped ? t('notice.photos_left') : ''));
    setModal(null);
    setContextMenu(null);
  }

  async function pasteClipboard() {
    if (!clipboard) return;
    try {
      await runBatch(clipboard.mode === 'cut' ? 'move' : 'copy', clipboard.ids, currentFolderId);
    } catch (cause) {
      setError(friendlyError(cause));
    }
  }

  async function trashEntries(ids: string[]) {
    const allowed = operableIds(ids);
    if (allowed.length === 0) {
      setError(t('error.photos_delete'));
      return;
    }
    const count = allowed.length;
    if (!window.confirm(count === 1 ? t('confirm.trash_one') : t('confirm.trash_many', { count }))) return;
    try {
      await runBatch('trash', allowed);
    } catch (cause) {
      setError(friendlyError(cause));
    }
  }

  function entryMenuItems(ids: string[]): MenuItem[] {
    const chosen = entries.filter((entry) => ids.includes(entry.id));
    const single = chosen.length === 1 ? chosen[0] : null;
    const locked = chosen.length > 0 && chosen.every(isSystemFolder);
    const files = chosen.filter((entry) => entry.kind === 'file');
    return [
      { id: 'open', label: single?.kind === 'folder' ? t('menu.open') : t('menu.open'), hidden: !single, icon: single?.kind === 'folder' ? <Folder size={15} /> : <Eye size={15} />, onSelect: () => {
        if (!single) return;
        if (single.kind === 'folder') void openFolder(single);
        else if (isFilePreviewable(single)) openPreview(single);
        else window.location.assign(downloadUrl(single.id));
      } },
      { id: 'preview', label: t('menu.preview'), hidden: !single || single.kind !== 'file' || !isFilePreviewable(single), icon: <Eye size={15} />, onSelect: () => single && openPreview(single) },
      { id: 'download', label: t('menu.download'), hidden: files.length === 0, icon: <Download size={15} />, onSelect: () => downloadFiles(files.map((entry) => entry.id)) },
      { id: 'share', label: t('menu.share'), hidden: chosen.length === 0, icon: <Share2 size={15} />, onSelect: () => setShareTargets(shareSubjects(ids)) },
      { id: 'details', label: t('menu.details'), hidden: !single, icon: <Info size={15} />, onSelect: () => single && setDetailsId(single.id) },
      { id: 'rename', label: t('menu.rename'), hidden: !single, disabled: !single || isSystemFolder(single), onSelect: () => single && setModal({ kind: 'rename', entry: single }) },
      { id: 'move', label: t('menu.move'), disabled: locked, icon: <FolderInput size={15} />, onSelect: () => setModal({ kind: 'destination', action: 'move', ids: operableIds(ids) }) },
      { id: 'copy-to', label: t('menu.copy_to'), disabled: locked, icon: <Copy size={15} />, onSelect: () => setModal({ kind: 'destination', action: 'copy', ids: operableIds(ids) }) },
      { id: 'cut', label: t('menu.cut'), disabled: locked, icon: <Scissors size={15} />, onSelect: () => { const next = operableIds(ids); setClipboard({ mode: 'cut', ids: next }); setNotice(t('notice.move_ready', { count: next.length })); } },
      { id: 'copy', label: t('menu.copy'), disabled: locked, icon: <Copy size={15} />, onSelect: () => { const next = operableIds(ids); setClipboard({ mode: 'copy', ids: next }); setNotice(t('notice.copied', { count: next.length })); } },
      { id: 'move-here', label: t('menu.move_here'), hidden: !single || !currentFolderId || single.parent_id === currentFolderId, disabled: !single || isSystemFolder(single), onSelect: () => single && void moveTo(single, currentFolderId) },
      { id: 'move-root', label: t('menu.move_root'), hidden: !single || single.parent_id === null, disabled: !single || isSystemFolder(single), onSelect: () => single && void moveTo(single, null) },
      { id: 'trash', label: t('menu.trash'), danger: true, disabled: locked, icon: <Trash2 size={15} />, onSelect: () => void trashEntries(ids) }
    ];
  }

  function backgroundMenuItems(): MenuItem[] {
    return [
      { id: 'upload', label: t('drive.upload_files'), icon: <Upload size={15} />, onSelect: pickFiles },
      { id: 'folder', label: t('drive.new_folder'), icon: <FolderPlus size={15} />, onSelect: () => setModal({ kind: 'new-folder' }) },
      { id: 'paste', label: clipboard?.mode === 'cut' ? t('menu.paste_move') : t('menu.paste'), disabled: !clipboard, icon: <ClipboardPaste size={15} />, onSelect: () => void pasteClipboard() },
      { id: 'select-all', label: t('menu.select_all'), disabled: entries.length === 0, onSelect: () => { setSelectedIds(entries.map((entry) => entry.id)); setSelectionMode(true); } }
    ];
  }

  function setUploadProgress(task: UploadTask, bytes: number, detail?: string) {
    const fileSize = task.file?.size ?? 0;
    const uploadedBytes = fileSize ? Math.min(fileSize, Math.max(0, bytes)) : 0;
    const now = Date.now();
    task.speed = task.tracker.record(uploadedBytes, now);
    task.uploadedBytes = uploadedBytes;
    updateJob(task.key, {
      uploadedBytes,
      progress: fileSize ? (uploadedBytes / fileSize) * 100 : 100,
      speed: task.speed,
      status: 'uploading',
      ...(detail ? { detail } : {}),
    });
  }

  function resetUploadProgress(task: UploadTask, bytes: number) {
    const fileSize = task.file?.size ?? 0;
    const uploadedBytes = fileSize ? Math.min(fileSize, Math.max(0, bytes)) : 0;
    task.uploadedBytes = uploadedBytes;
    task.speed = 0;
    task.tracker.reset(uploadedBytes, Date.now());
    updateJob(task.key, {
      uploadedBytes,
      progress: fileSize ? (uploadedBytes / fileSize) * 100 : 100,
      speed: 0
    });
  }

  function removeSavedUpload(id: string | null | undefined) {
    if (!id) return;
    writeSavedUploads(readSavedUploads().filter((item) => item.id !== id));
  }

  function persistUploadOffset(session: SavedUpload, offset: number) {
    const savedUploads = readSavedUploads().filter((item) => item.id !== session.id);
    savedUploads.push({ ...session, uploadedBytes: Math.max(0, Math.min(session.size, offset)) });
    writeSavedUploads(savedUploads);
  }

  async function handleUploadAction(task: UploadTask, session: SavedUpload | null, fallbackOffset: number): Promise<boolean> {
    if (!task.action) return false;
    const action = task.action;
    task.controller = null;
    if (action === 'pause') {
      let offset = fallbackOffset;
      if (session) {
        try {
          const server = await api.uploadHead(session.id);
          offset = server.offset;
          persistUploadOffset(session, offset);
        } catch (cause) {
          if (cause instanceof ApiError && cause.status === 401) onLoggedOut();
        }
      }
      task.session = session;
      task.action = null;
      resetUploadProgress(task, offset);
      updateJob(task.key, {
        uploadId: session?.id || null,
        saved: session || undefined,
        status: 'paused',
        speed: 0,
        detail: t('upload.detail.paused_at', { size: formatSize(task.uploadedBytes) })
      });
      return true;
    }

    try {
      if (session) {
        try {
          await api.cancelUpload(session.id);
        } catch (cause) {
          if (!(cause instanceof ApiError) || !['upload_closed', 'not_found'].includes(cause.code)) throw cause;
        }
      }
      removeSavedUpload(session?.id);
      uploadTasksRef.current.delete(task.key);
      setJobs((items) => items.filter((job) => job.key !== task.key));
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) onLoggedOut();
      task.action = null;
      updateJob(task.key, { status: session ? 'paused' : 'error', speed: 0, detail: friendlyError(cause) });
    }
    return true;
  }

  async function runUpload(task: UploadTask) {
    const file = task.file;
    let session = task.session;
    let offset = task.uploadedBytes;
    if (!file) {
      updateJob(task.key, { status: 'paused', detail: t('upload.detail.resume') });
      return;
    }
    try {
      if (task.action && await handleUploadAction(task, session, offset)) return;
      if (!session) {
        const created = await api.createUpload(file.name, file.size, task.parentId);
        session = {
          schema: 1,
          id: created.id,
          name: file.name,
          size: file.size,
          lastModified: file.lastModified,
          parentId: task.parentId,
          createdAt: Date.now(),
          uploadedBytes: 0
        };
        task.session = session;
        persistUploadOffset(session, 0);
        updateJob(task.key, { uploadId: session.id, saved: session });
      }
      if (task.action && await handleUploadAction(task, session, offset)) return;

      updateJob(task.key, { detail: t('upload.detail.preparing') });
      let server = await api.uploadHead(session.id);
      offset = Math.min(server.offset, file.size);
      persistUploadOffset(session, offset);
      resetUploadProgress(task, offset);
      if (task.action && await handleUploadAction(task, session, offset)) return;

      const controller = new AbortController();
      task.controller = controller;
      offset = await uploadFileChunksResilient({
        file,
        sessionId: session.id,
        initialOffset: offset,
        transport: api,
        signal: controller.signal,
        onProgress: (uploadedBytes) => {
          setUploadProgress(task, uploadedBytes);
        },
        onOffsetCommitted: (committedOffset) => {
          offset = committedOffset;
          if (session) persistUploadOffset(session, committedOffset);
        },
        onPhase: (ev) => {
          if (ev.phase === 'retrying') {
            task.speed = 0;
            updateJob(task.key, { status: 'retrying', speed: 0, detail: ev.detail });
          } else {
            updateJob(task.key, { status: 'uploading', detail: ev.detail });
          }
        },
      });
      task.controller = null;

      if (task.action && await handleUploadAction(task, session, offset)) return;
      task.finalizing = true;
      task.speed = 0;
      updateJob(task.key, { status: 'uploading', detail: t('upload.detail.finalizing'), speed: 0 });
      await finalizeUploadWithRetry(
        () => api.finalizeUpload(session!.id),
        controller.signal,
        (attempt, max, waitMs) => {
          updateJob(task.key, {
            status: 'retrying',
            speed: 0,
            detail: t('upload.detail.retry_finish', { attempt, max, secs: (waitMs / 1000).toFixed(1) }),
          });
        },
      );
      task.session = null;
      task.finalizing = false;
      task.speed = 0;
      removeSavedUpload(session.id);
      uploadTasksRef.current.delete(task.key);
      updateJob(task.key, { status: 'done', uploadedBytes: file.size, progress: 100, speed: 0, detail: t('upload.detail.uploaded') });
      setNotice(t('notice.uploaded', { name: file.name }));
      setRefresh((value) => value + 1);
    } catch (cause) {
      task.controller = null;
      task.finalizing = false;
      if (task.action && await handleUploadAction(task, session, offset)) return;
      if (cause instanceof ApiError && cause.status === 401) {
        onLoggedOut();
        return;
      }
      const resumable = !!session && !(cause instanceof ApiError && ['upload_closed', 'not_found'].includes(cause.code));
      if (resumable && session) {
        try {
          const server = await api.uploadHead(session.id);
          offset = Math.min(server.offset, file.size);
          persistUploadOffset(session, offset);
        } catch (headCause) {
          if (headCause instanceof ApiError && headCause.status === 401) onLoggedOut();
        }
        resetUploadProgress(task, offset);
      }
      if (!resumable) {
        removeSavedUpload(session?.id);
        task.session = null;
      } else {
        task.session = session;
      }
      updateJob(task.key, {
        uploadId: session?.id || null,
        saved: resumable ? session || undefined : undefined,
        status: resumable ? 'paused' : 'error',
        speed: 0,
        detail: friendlyError(cause)
      });
    }
  }

  function pumpUploadQueue() {
    const queue = uploadQueueRef.current;
    while (activeUploadsRef.current.size < MAX_CONCURRENT_UPLOADS && queue.length > 0) {
      const task = queue.shift()!;
      if (task.action === 'cancel') continue;
      if (task.action === 'pause') {
        task.action = null;
        updateJob(task.key, { status: 'paused', speed: 0, detail: t('upload.detail.paused_queue') });
        continue;
      }
      activeUploadsRef.current.set(task.key, task);
      task.finalizing = false;
      task.tracker.reset(task.uploadedBytes, Date.now());
      updateJob(task.key, { status: 'uploading', speed: 0, detail: t('upload.detail.preparing') });
      void runUpload(task).finally(() => {
        activeUploadsRef.current.delete(task.key);
        task.controller = null;
        task.finalizing = false;
        pumpUploadQueue();
      });
    }
  }

  function queueUploadTask(task: UploadTask) {
    task.action = null;
    if (!activeUploadsRef.current.has(task.key) && !uploadQueueRef.current.some((item) => item.key === task.key)) {
      uploadQueueRef.current.push(task);
    }
    const fileSize = task.file?.size ?? 0;
    updateJob(task.key, {
      uploadId: task.session?.id || null,
      saved: task.session || undefined,
      uploadedBytes: task.uploadedBytes,
      progress: fileSize ? (task.uploadedBytes / fileSize) * 100 : 100,
      speed: 0,
      status: 'queued',
      detail: t('upload.detail.waiting')
    });
    pumpUploadQueue();
  }

  function enqueueUpload(file: File, parentId: string | null, saved?: SavedUpload, existingKey?: string) {
    const key = existingKey || saved?.id || 'pending-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
    const initialBytes = Math.min(file.size, Math.max(0, saved?.uploadedBytes || 0));
    const task = uploadTasksRef.current.get(key) || {
      key,
      file,
      parentId: saved ? saved.parentId : parentId,
      session: saved || null,
      action: null,
      controller: null,
      finalizing: false,
      uploadedBytes: initialBytes,
      speed: 0,
      tracker: new ThroughputTracker(initialBytes, Date.now()),
    } satisfies UploadTask;
    task.file = file;
    task.parentId = saved ? saved.parentId : parentId;
    task.session = saved || task.session;
    task.action = null;
    uploadTasksRef.current.set(key, task);
    queueUploadTask(task);
    updateJob(key, { key, name: file.name, size: file.size });
  }

  async function chooseFiles(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files || []);
    event.target.value = '';
    if (!files.length) return;
    setError('');
    const parentId = currentFolderId;
    if (resumeTargetId) {
      const saved = readSavedUploads().find((item) => item.id === resumeTargetId);
      setResumeTargetId(null);
      const file = saved && files.find((candidate) => fileMatches(candidate, saved, saved.parentId));
      if (!saved || !file) {
        setError(t('error.resume_same_file'));
        return;
      }
      enqueueUpload(file, saved.parentId, saved, saved.id);
      return;
    }
    for (const file of files) {
      const saved = readSavedUploads().find((item) => fileMatches(file, item, parentId));
      enqueueUpload(file, parentId, saved);
    }
  }

  function pickFiles() {
    setResumeTargetId(null);
    fileInputRef.current?.click();
  }

  function resumeUpload(job: UploadJob) {
    const task = uploadTasksRef.current.get(job.key);
    if (task?.file) {
      task.finalizing = false;
      queueUploadTask(task);
      return;
    }
    setResumeTargetId(job.uploadId);
    fileInputRef.current?.click();
  }

  function pauseUpload(job: UploadJob) {
    const task = uploadTasksRef.current.get(job.key);
    if (!task || task.finalizing || task.action) return;
    task.action = 'pause';
    updateJob(job.key, { speed: 0, detail: t('upload.detail.pausing') });
    task.controller?.abort();
  }

  function retryUpload(job: UploadJob) {
    const task = uploadTasksRef.current.get(job.key);
    if (!task?.file) {
      setResumeTargetId(job.uploadId);
      fileInputRef.current?.click();
      return;
    }
    removeSavedUpload(task.session?.id || job.uploadId);
    task.session = null;
    task.action = null;
    task.uploadedBytes = 0;
    task.speed = 0;
    task.tracker.reset(0, Date.now());
    queueUploadTask(task);
  }

  function resumeAllPaused() {
    for (const job of jobs) {
      if (job.status === 'paused' || job.status === 'error') {
        const task = uploadTasksRef.current.get(job.key);
        if (task?.file) {
          task.finalizing = false;
          queueUploadTask(task);
        }
      }
    }
  }

  function pauseAllActive() {
    for (const job of jobs) {
      if (job.status === 'uploading' || job.status === 'retrying') {
        pauseUpload(job);
      }
    }
  }

  async function cancelUpload(job: UploadJob) {
    const task = uploadTasksRef.current.get(job.key);
    if (task && activeUploadsRef.current.has(job.key)) {
      if (task.finalizing || task.action) return;
      task.action = 'cancel';
      updateJob(job.key, { speed: 0, detail: t('upload.detail.cancelling') });
      task.controller?.abort();
      return;
    }

    uploadQueueRef.current = uploadQueueRef.current.filter((item) => item.key !== job.key);
    try {
      const sessionId = task?.session?.id || job.uploadId;
      if (sessionId) {
        try {
          await api.cancelUpload(sessionId);
        } catch (cause) {
          if (!(cause instanceof ApiError) || !['upload_closed', 'not_found'].includes(cause.code)) throw cause;
        }
      }
      removeSavedUpload(sessionId);
      uploadTasksRef.current.delete(job.key);
      setJobs((items) => items.filter((item) => item.key !== job.key));
      pumpUploadQueue();
    } catch (cause) {
      setError(friendlyError(cause));
    }
  }

  async function createFolder(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const name = String(data.get('name') || '').trim();
    if (!name) return;
    try {
      await api.createFolder(name, currentFolderId);
      setModal(null);
      setNotice(t('notice.folder_created'));
      setRefresh((value) => value + 1);
    } catch (cause) {
      setError(friendlyError(cause));
    }
  }

  async function renameEntry(event: FormEvent<HTMLFormElement>, entry: Entry) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const name = String(data.get('name') || '').trim();
    if (!name) return;
    if (isSystemFolder(entry)) {
      setError(t('error.photos_rename'));
      return;
    }
    try {
      await api.renameEntry(entry.id, name);
      setModal(null);
      setNotice(t('notice.renamed'));
      const renamed = breadcrumbsRef.current.map((crumb) => crumb.id === entry.id ? { ...crumb, name } : crumb);
      if (renamed.some((crumb, index) => crumb.name !== breadcrumbsRef.current[index]?.name)) {
        showDrive({ folders: renamed }, 'replace');
      }
      setRefresh((value) => value + 1);
    } catch (cause) {
      setError(friendlyError(cause));
    }
  }

  async function restoreEntry(entry: Entry) {
    try {
      await api.restoreEntry(entry.id);
      setNotice(t('trash.restored'));
      setRefresh((value) => value + 1);
    } catch (cause) {
      setError(friendlyError(cause));
    }
  }

  async function revokeShare(share: ShareSummary) {
    if (!window.confirm(t('confirm.revoke_share', { name: share.resource_name }))) return;
    try {
      await api.revokeShare(share.id);
      setNotice(t('notice.share_revoked'));
      setShareRefresh((value) => value + 1);
    } catch (cause) {
      setError(friendlyError(cause));
    }
  }

  async function loadMore() {
    if (nextOffset == null) return;
    setLoadingMore(true);
    setError('');
    try {
      if (section === 'shared') {
        const page = await api.listShares(nextOffset);
        setShares((items) => [...items, ...page.shares]);
        setNextOffset(page.next_offset);
      } else {
        const filtering = filtersReady(route.filters, currentFolderId);
        const page: EntryPage = section === 'trash'
          ? await api.listTrash(undefined, nextOffset)
          : query.trim() || filtering
            ? await api.search(query.trim(), undefined, nextOffset, searchFilters(route.filters, currentFolderId, route.sort, route.order))
            : await api.listDrive(currentFolderId, undefined, nextOffset, {
              sort_by: route.sort,
              order: route.order,
              include_stats: true
            });
        setEntries((items) => [...items, ...page.entries]);
        setNextOffset(page.next_offset);
      }
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) onLoggedOut();
      else setError(friendlyError(cause));
    } finally {
      setLoadingMore(false);
    }
  }

  async function logout() {
    try {
      await api.logout();
    } catch {
      // Clearing the local view still sends the user back through sign-in.
    }
    setActiveTeamWorkspace(null);
    setActiveTeam(null);
    onLoggedOut();
  }

  const searchActive = section === 'drive' && (query.trim().length > 0 || filtersReady(route.filters, currentFolderId));
  const visibleRows = entries;
  const previewItems = visibleRows.filter((entry) => entry.kind === 'file' && isFilePreviewable(entry));
  const activeUploadJobs = jobs.filter((job) => job.status === 'uploading' || job.status === 'retrying');
  const retryingUploadJobs = jobs.filter((job) => job.status === 'retrying');
  const queuedUploadJobs = jobs.filter((job) => job.status === 'queued');
  const pausedUploadJobs = jobs.filter((job) => job.status === 'paused' || job.status === 'error');
  const completedUploadCount = jobs.filter((job) => job.status === 'done').length;
  const totalUploadSpeed = activeUploadJobs.reduce((total, job) => total + job.speed, 0);
  const unfinishedUploadJobs = jobs.filter((job) => job.status !== 'done');
  const totalBatchBytes = unfinishedUploadJobs.reduce((total, job) => total + job.size, 0);
  const uploadedBatchBytes = unfinishedUploadJobs.reduce((total, job) => total + Math.min(job.uploadedBytes, job.size), 0);
  const overallBatchProgress = totalBatchBytes > 0 ? Math.min(100, (uploadedBatchBytes / totalBatchBytes) * 100) : 100;
  const remainingBatchBytes = Math.max(0, totalBatchBytes - uploadedBatchBytes);
  const totalUploadEta = totalUploadSpeed > 0 && remainingBatchBytes > 0 ? remainingBatchBytes / totalUploadSpeed : null;
  const sortValue = `${route.sort}:${route.order}`;
  const allTrashSelected = section === 'trash' && visibleRows.length > 0 && visibleRows.every((entry) => trashSelection.includes(entry.id));

  return (
    <div className="drive-app">
      <header className="app-topbar">
        <a className="brand-wordmark" href="/drive" aria-label="My Drive" onClick={(event) => {
          event.preventDefault();
          showDrive({ folders: [], query: '', fileId: null });
        }}>
          <span className="brand-mark"><Folder size={18} fill="currentColor" strokeWidth={1.6} /></span>
          <span>MY DRIVE</span>
        </a>
        <label className={'global-search' + (section !== 'drive' ? ' search-disabled' : '')}>
          <Search size={19} />
          <input
            ref={searchInputRef}
            type="search"
            placeholder={section === 'drive' ? t('app.search_placeholder') : t('app.search_placeholder_disabled')}
            value={query}
            disabled={section !== 'drive'}
            onChange={(event) => showDrive({ query: event.target.value, fileId: null }, 'replace')}
            aria-label={t('app.search_placeholder')}
          />
          {query && section === 'drive' && <button className="clear-search" onClick={() => showDrive({ query: '', fileId: null }, 'replace')} aria-label={t('app.search_clear')}><X size={15} /></button>}
          <kbd className="search-shortcut">{shortcutLabel}</kbd>
        </label>
        <details className="account-menu">
          <summary className="account-button" aria-label={t('app.account_menu')}>
            <span className="avatar"><CircleUserRound size={21} /></span>
            <span className="account-email">{user.email}</span>
            <ChevronDown size={15} />
          </summary>
          <div className="menu-popover account-popover">
            <span className="account-menu-email">{user.email}</span>
            <div className="menu-divider" />
            <button onClick={(event) => {
              event.currentTarget.closest('details')?.removeAttribute('open');
              openSettings(null);
            }}>
              <Settings size={15} /> {t('menu.settings')}
              {updateAvailable ? <span className="update-menu-badge">{latestUpdateTag || t('menu.update_new')}</span> : null}
            </button>
            <button onClick={(event) => {
              event.currentTarget.closest('details')?.removeAttribute('open');
              navigate('storage');
            }}><Gauge size={15} /> {t('menu.storage')}</button>
            <div className="menu-divider" />
            <button onClick={logout}><LogOut size={15} /> {t('menu.sign_out')}</button>
          </div>
        </details>
      </header>

      <div className="app-body">
        <aside className="side-nav" aria-label="Main navigation">
          <div className="nav-section-label">{t('nav.workspace')}</div>
          <button
            className={'nav-item' + (section === 'drive' && !activeTeam && !teamsOpen ? ' active' : '')}
            onClick={() => {
              if (activeTeam) selectTeamWorkspace(null);
              else navigate('drive');
            }}
          >
            <HardDrive size={18} /><span>{t('nav.my_drive')}</span>
          </button>
          <button
            className={'nav-item' + (teamsOpen || Boolean(activeTeam) ? ' active' : '')}
            onClick={() => openSettings('teams')}
          >
            <Users size={18} /><span>{t('nav.teams')}</span>
          </button>
          <button className={'nav-item' + (section === 'photos' ? ' active' : '')} onClick={() => navigate('photos')}>
            <Images size={18} /><span>{t('nav.photos')}</span>
          </button>
          <button className={'nav-item' + (section === 'shared' ? ' active' : '')} onClick={() => navigate('shared')}>
            <Users size={18} /><span>{t('nav.shared')}</span>
          </button>
          <button className={'nav-item' + (section === 'trash' ? ' active' : '')} onClick={() => navigate('trash')}>
            <Trash2 size={18} /><span>{t('nav.trash')}</span>
          </button>
          <button className={'nav-item' + (section === 'storage' ? ' active' : '')} onClick={() => navigate('storage')}>
            <Gauge size={18} /><span>{t('nav.storage')}</span>
          </button>
          <button className={'nav-item' + (section === 'settings' && panel === 'google-drive' ? ' active' : '')} onClick={() => openSettings('google-drive')}>
            <Cloud size={18} /><span>{t('nav.google_drive')}</span>
          </button>
          <button className={'nav-item' + (section === 'settings' && panel !== 'google-drive' && !teamsOpen ? ' active' : '')} onClick={() => openSettings(null)}>
            <Settings size={18} /><span>{t('nav.settings')}</span>
          </button>
          <div className="sidebar-bottom">
            <QuotaCard teamName={activeTeam?.name} />
            <div className="privacy-card">
              <span className="privacy-icon"><LockKeyhole size={16} /></span>
              <span><strong>{t('nav.privacy_title')}</strong><small>{t('nav.privacy_body')}</small></span>
            </div>
          </div>
        </aside>

        <main className="main-content">
          {section !== 'photos' && section !== 'storage' && (
          <section className="page-heading">
            <div className="heading-copy">
              <span className="eyebrow">{section === 'drive' ? t('heading.your_files') : section === 'shared' ? t('heading.link_settings') : section === 'settings' ? t('settings.title').toUpperCase() : t('heading.recently_removed')}</span>
              <h1>{activeSectionLabel}</h1>
              <p>
                {section === 'drive'
                  ? searchActive ? t('subtitle.drive_search') : t('subtitle.drive')
                  : section === 'shared'
                    ? t('subtitle.shared')
                    : section === 'settings'
                      ? t('subtitle.settings')
                      : t('subtitle.trash')}
              </p>
            </div>
            {section === 'drive' && (
              <div className="heading-actions">
                {user.role === 'owner' && updateAvailable ? (
                  <button
                    className="button button-secondary update-available-trigger"
                    type="button"
                    onClick={() => openSettings('updates')}
                  >
                    <ArrowUpCircle size={16} /> <span>{latestUpdateTag ? t('drive.update_tag', { tag: latestUpdateTag }) : t('drive.update_available')}</span>
                  </button>
                ) : null}
                <button className="button button-secondary" onClick={() => setModal({ kind: 'new-folder' })}>
                  <FolderPlus size={17} /> <span>{t('drive.new_folder')}</span>
                </button>
                <button className="button button-primary" onClick={pickFiles}>
                  <Upload size={17} /> <span>{t('drive.upload_files')}</span>
                </button>
                <input ref={fileInputRef} className="visually-hidden" type="file" multiple onChange={(event) => void chooseFiles(event)} />
              </div>
            )}
            {section === 'trash' && (
              <div className="heading-actions">
                <button
                  className="button button-secondary"
                  disabled={trashSelection.length === 0}
                  onClick={() => {
                    const count = trashSelection.length;
                    if (window.confirm(t('trash.confirm_delete', { count }))) {
                      void purgeTrash({ ids: trashSelection }, t('trash.deleted'));
                    }
                  }}
                >
                  <Trash2 size={16} /> <span>{t('trash.delete_permanently')}</span>
                </button>
                <button
                  className="button button-quiet-danger"
                  disabled={loading || entries.length === 0}
                  onClick={() => {
                    if (window.confirm(t('trash.confirm_empty'))) {
                      void purgeTrash({ all: true }, t('trash.emptied'));
                    }
                  }}
                >
                  {t('trash.empty')}
                </button>
              </div>
            )}
          </section>
          )}

          {section === 'drive' && breadcrumbs.length > 0 && !searchActive && (
            <nav className="breadcrumb-nav" aria-label={t('breadcrumb.label')}>
              <button onClick={() => goToBreadcrumb(-1)}>{activeTeam ? activeTeam.name : t('section.my_drive')}</button>
              {breadcrumbs.map((crumb, index) => (
                <span className="breadcrumb-item" key={crumb.id}>
                  <ChevronRight size={14} className="breadcrumb-slash" />
                  <button onClick={() => goToBreadcrumb(index)} aria-current={index === breadcrumbs.length - 1 ? 'page' : undefined}>{crumb.name}</button>
                </span>
              ))}
            </nav>
          )}

          {section === 'drive' && activeTeam ? (
            <div className="team-workspace-banner" role="status">
              <span>
                {t('team.viewing')} <strong>{activeTeam.name}</strong> ({activeTeam.myRole})
              </span>
              <div className="account-access-actions">
                <button
                  className="button button-secondary"
                  type="button"
                  onClick={() => openSettings('teams')}
                >
                  {t('team.settings')}
                </button>
                <button
                  className="button button-secondary"
                  type="button"
                  onClick={() => selectTeamWorkspace(null)}
                >
                  {t('team.return')}
                </button>
              </div>
            </div>
          ) : null}

          {error && <div className="notice notice-error" role="alert"><span>{error}</span><button onClick={() => setError('')} aria-label={t('app.dismiss')}><X size={16} /></button></div>}
          {notice && !error && <div className="notice notice-success" role="status"><Check size={16} /><span>{notice}</span><button onClick={() => setNotice('')} aria-label={t('app.dismiss')}><X size={16} /></button></div>}

          {section === 'photos' ? (
            <PhotosPage
              tab={route.photosTab}
              albumId={route.albumId}
              personId={route.personId}
              fileId={route.fileId}
              onNavigate={(next) => navigateTo(buildDrivePath({
                ...route,
                section: 'photos',
                folderIds: [],
                panel: null,
                query: '',
                photosTab: next.tab ?? route.photosTab,
                albumId: next.albumId === undefined ? route.albumId : next.albumId,
                personId: next.personId === undefined ? route.personId : next.personId,
                fileId: next.fileId === undefined ? route.fileId : next.fileId,
                filters: emptyFilters()
              }, []))}
            />
          ) : section === 'storage' ? (
            <StoragePage user={user} />
          ) : section === 'settings' ? (
            <SettingsPage
              user={user}
              panel={panel}
              activeTeam={activeTeam}
              updateAvailable={updateAvailable}
              latestUpdateTag={latestUpdateTag}
              onNavigate={openSettings}
              onBack={() => showDrive({ folders: [], query: '', fileId: null })}
              onSelectWorkspace={selectTeamWorkspace}
              onUpdateStatusChange={(snapshot) => {
                setUpdateAvailable(snapshot.latest.updateAvailable);
                setLatestUpdateTag(snapshot.latest.tag);
              }}
            />
          ) : section === 'shared' ? (
            <section className="share-manager">
              {loading ? (
                <div className="table-card"><div className="loading-rows"><span /><span /><span /></div></div>
              ) : shares.length ? (
                <div className="table-card share-table">
                  <div className="table-head share-grid"><span>{t('shared.item')}</span><span>{t('shared.access')}</span><span>{t('shared.created')}</span><span>{t('shared.expires')}</span><span>{t('shared.status')}</span><span /></div>
                  {shares.map((share) => {
                    const status = displayShareStatus(share);
                    return (
                      <div className="table-row share-grid" key={share.id}>
                        <div className="entry-main share-resource">
                          {extensionIcon({ kind: share.resource_type, name: share.resource_name })}
                          <span className="entry-name">{share.resource_name}</span>
                          <span className="resource-type">{share.resource_type}</span>
                        </div>
                        <div className="share-access">
                          <span>{share.password_protected ? <><LockKeyhole size={13} /> {t('shared.password')}</> : t('shared.anyone')}</span>
                          <small>{share.allow_download ? t('shared.downloads_on') : t('shared.view_only')}</small>
                          {share.max_downloads != null && <small>{t('shared.downloads_count', { count: share.download_count, max: share.max_downloads })}</small>}
                        </div>
                        <span className="entry-modified">{formatDate(share.created_at)}</span>
                        <span className="entry-modified">{formatDate(share.expires_at)}</span>
                        <span><span className={'status-pill ' + status.className}><i />{t(status.label)}</span></span>
                        <span className="share-row-action">
                          {status.label === 'status.active' && <button className="button button-quiet-danger" onClick={() => void revokeShare(share)}>{t('shared.revoke')}</button>}
                        </span>
                      </div>
                    );
                  })}
                  {nextOffset != null && <button className="load-more" disabled={loadingMore} onClick={() => void loadMore()}>{loadingMore ? t('misc.loading') : t('shared.load_more')}</button>}
                </div>
              ) : (
                <div className="empty-state share-empty">
                  <span className="empty-icon"><Share2 size={22} /></span>
                  <h2>{t('shared.empty_title')}</h2>
                  <p>{t('shared.empty_hint')}</p>
                  <button className="button button-secondary" onClick={() => navigate('drive')}>{t('shared.goto_drive')}</button>
                </div>
              )}
            </section>
          ) : (
            <section
              className={'drive-list-section' + (selectedIds.length ? ' selection-active' : '')}
              onContextMenu={(event) => {
                if (section !== 'drive') return;
                const target = event.target;
                if (target instanceof HTMLElement && target.closest('[data-entry-id], .context-menu, .batch-bar')) return;
                event.preventDefault();
                setContextMenu({ x: event.clientX, y: event.clientY, ids: [] });
              }}
            >
              <div className="explorer-toolbar">
                <div className="explorer-toolbar-copy">
                  {section === 'trash' && (
                    <label className="trash-select-all">
                      <input
                        type="checkbox"
                        checked={allTrashSelected}
                        onChange={() => setTrashSelection(allTrashSelected ? [] : visibleRows.map((entry) => entry.id))}
                        aria-label={t('trash.select_all')}
                      />
                      <span>{trashSelection.length ? t('toolbar.selected', { count: trashSelection.length }) : t('toolbar.select')}</span>
                    </label>
                  )}
                  <span>{searchActive ? t('toolbar.search_results') : section === 'trash' ? t('toolbar.trash_items') : selectedIds.length ? t('toolbar.selected', { count: selectedIds.length }) : t('toolbar.files')}</span>
                </div>
                <div className="explorer-toolbar-actions">
                  {section === 'drive' && (
                    <label className="sort-control">
                      <span className="visually-hidden">{t('sort.label')}</span>
                      <select value={sortValue} onChange={(event) => changeSort(event.target.value)}>
                        <option value="name:asc">{t('sort.name')}</option>
                        <option value="name:desc">{t('sort.name_desc')}</option>
                        <option value="updated_at:desc">{t('sort.updated')}</option>
                        <option value="created_at:desc">{t('sort.created')}</option>
                        <option value="size:desc">{t('sort.size_desc')}</option>
                        <option value="size:asc">{t('sort.size_asc')}</option>
                      </select>
                    </label>
                  )}
                  {section === 'drive' && (
                    <button
                      className={'button button-secondary' + (selectionMode ? ' is-active' : '')}
                      type="button"
                      aria-pressed={selectionMode}
                      onClick={() => {
                        setSelectionMode((value) => !value);
                        if (selectionMode) setSelectedIds([]);
                      }}
                    >
                      {t('toolbar.select')}
                    </button>
                  )}
                  {section === 'drive' && (
                    <button
                      className={'button button-secondary filter-toggle' + (filtersOpen || hasActiveFilters(route.filters) ? ' is-active' : '')}
                      type="button"
                      aria-expanded={filtersOpen}
                      onClick={() => setFiltersOpen((open) => !open)}
                    >
                      <SlidersHorizontal size={15} /> <span>{t('filters.button')}</span>
                    </button>
                  )}
                  <div className="view-toggle" role="group" aria-label={t('view.label')}>
                    <button className={viewMode === 'list' ? 'active' : ''} type="button" aria-pressed={viewMode === 'list'} onClick={() => setViewMode('list')} aria-label={t('view.list')}><List size={16} /></button>
                    <button className={viewMode === 'grid' ? 'active' : ''} type="button" aria-pressed={viewMode === 'grid'} onClick={() => setViewMode('grid')} aria-label={t('view.grid')}><LayoutGrid size={16} /></button>
                  </div>
                </div>
              </div>
              {section === 'drive' && filtersOpen && (
                <form className="filter-panel" onSubmit={(event) => event.preventDefault()}>
                  <label>{t('filters.type')}
                    <select value={route.filters.category} onChange={(event) => patchFilters({ category: event.target.value })}>
                      <option value="">{t('filters.any')}</option>
                      <option value="folder">{t('filters.folders')}</option>
                      <option value="image">{t('filters.images')}</option>
                      <option value="video">{t('filters.videos')}</option>
                      <option value="audio">{t('filters.audio')}</option>
                      <option value="document">{t('filters.documents')}</option>
                      <option value="archive">{t('filters.archives')}</option>
                      <option value="other">{t('filters.other')}</option>
                    </select>
                  </label>
                  <label>MIME
                    <input value={route.filters.mime} placeholder="image/jpeg" onChange={(event) => patchFilters({ mime: event.target.value.trim() })} />
                  </label>
                  <label>{t('filters.min_mb')}
                    <input inputMode="decimal" value={route.filters.minSize} placeholder="0" onChange={(event) => patchFilters({ minSize: event.target.value })} />
                  </label>
                  <label>{t('filters.max_mb')}
                    <input inputMode="decimal" value={route.filters.maxSize} placeholder={t('filters.any')} onChange={(event) => patchFilters({ maxSize: event.target.value })} />
                  </label>
                  <label>{t('filters.created_from')}
                    <input type="date" value={route.filters.createdFrom} onChange={(event) => patchFilters({ createdFrom: event.target.value })} />
                  </label>
                  <label>{t('filters.created_to')}
                    <input type="date" value={route.filters.createdTo} onChange={(event) => patchFilters({ createdTo: event.target.value })} />
                  </label>
                  <label>{t('filters.modified_from')}
                    <input type="date" value={route.filters.modifiedFrom} onChange={(event) => patchFilters({ modifiedFrom: event.target.value })} />
                  </label>
                  <label>{t('filters.modified_to')}
                    <input type="date" value={route.filters.modifiedTo} onChange={(event) => patchFilters({ modifiedTo: event.target.value })} />
                  </label>
                  {currentFolderId && (
                    <label className="filter-check">
                      <input type="checkbox" checked={route.filters.inFolder} onChange={(event) => patchFilters({ inFolder: event.target.checked })} />
                      {t('filters.in_folder')}
                    </label>
                  )}
                  <button className="button button-secondary" type="button" onClick={() => showDrive({ filters: emptyFilters(), fileId: null }, 'replace')}>{t('filters.clear')}</button>
                </form>
              )}
              <div className={viewMode === 'grid' && !loading && visibleRows.length ? 'entry-grid' : 'table-card drive-table'}>
                {viewMode === 'list' && (
                  <div className="list-toolbar">
                    <div className="list-toolbar-title"><span>{t('col.name')}</span></div>
                    <span className="list-toolbar-date">{section === 'trash' ? t('col.removed') : t('col.modified')}</span>
                    <span className="list-toolbar-size">{t('col.size')}</span>
                    <span className="list-toolbar-menu" />
                  </div>
                )}
                {loading ? (
                  <div className="loading-rows"><span /><span /><span /><span /></div>
                ) : visibleRows.length ? visibleRows.map((entry) => {
                  const open = () => {
                    if (section === 'trash') return;
                    if (entry.kind === 'folder') void openFolder(entry);
                    else if (isFilePreviewable(entry)) openPreview(entry);
                    else window.location.assign(downloadUrl(entry.id));
                  };
                  const activate = (event: MouseEvent<HTMLElement>) => {
                    if (section !== 'drive') {
                      open();
                      return;
                    }
                    const gesture = selectionGesture(event, selectionMode);
                    if (gesture) {
                      event.preventDefault();
                      chooseEntries(entry.id, gesture);
                      return;
                    }
                    open();
                  };
                  const onRowMenu = (event: MouseEvent<HTMLElement>) => {
                    if (section !== 'drive') return;
                    event.preventDefault();
                    event.stopPropagation();
                    const ids = selectedIds.includes(entry.id) ? selectedIds : [entry.id];
                    if (!selectedIds.includes(entry.id)) {
                      setSelectedIds([entry.id]);
                      selectionAnchor.current = entry.id;
                    }
                    setContextMenu({ x: event.clientX, y: event.clientY, ids });
                  };
                  const menuIds = selectedIds.includes(entry.id) && selectedIds.length > 1 ? selectedIds : [entry.id];
                  const selected = section === 'trash' ? trashSelection.includes(entry.id) : selectedIds.includes(entry.id);
                  const cut = clipboard?.mode === 'cut' && clipboard.ids.includes(entry.id);
                  const actions = section === 'trash' ? (
                    <button className="icon-button restore-button" onClick={() => void restoreEntry(entry)} aria-label={t('a11y.restore', { name: entry.name })} title={t('trash.restore')}><RotateCcw size={17} /></button>
                  ) : (
                    <>
                      <button className="icon-button" onClick={() => setDetailsId(entry.id)} aria-label={t('a11y.details_for', { name: entry.name })} title={t('menu.details')}><Info size={16} /></button>
                      <EntryMenu label={t('a11y.actions_for', { name: entry.name })} items={entryMenuItems(menuIds)} />
                    </>
                  );
                  const checkbox = (
                    <label className="entry-select" onClick={(event) => event.stopPropagation()}>
                      <input
                        type="checkbox"
                        checked={selected}
                        onChange={() => {
                          if (section === 'trash') {
                            setTrashSelection((current) => current.includes(entry.id) ? current.filter((id) => id !== entry.id) : [...current, entry.id]);
                          } else {
                            chooseEntries(entry.id, 'toggle');
                          }
                        }}
                        aria-label={t('a11y.select', { name: entry.name })}
                      />
                    </label>
                  );
                  if (viewMode === 'grid') {
                    return (
                      <article
                        className={'entry-card' + (selected ? ' selected' : '') + (cut ? ' is-cut' : '')}
                        key={entry.id}
                        data-entry-id={entry.id}
                        onContextMenu={onRowMenu}
                      >
                        <button className="entry-card-preview" onClick={activate} disabled={section === 'trash'}>
                          <EntryVisual entry={entry} showThumbnail={section !== 'trash'} />
                          {entry.kind === 'file' && mediaKindFor(entry) === 'video' && <span className="photo-badge">{t('entry.video')}</span>}
                          {checkbox}
                        </button>
                        <div className="entry-card-meta">
                          <button className="entry-name" onClick={activate} disabled={section === 'trash'}>
                            {entry.name}
                            {isSystemFolder(entry) && <span className="system-badge">{t('entry.photos_badge')}</span>}
                          </button>
                          <span>{entrySize(entry)}{entry.kind === 'folder' && entry.folder_file_count != null ? ' · ' + t('entry.files_count', { count: entry.folder_file_count }) : ''}</span>
                          <div className="entry-card-actions">{actions}</div>
                        </div>
                      </article>
                    );
                  }
                  return (
                  <div className={'table-row drive-grid' + (selected ? ' selected' : '') + (cut ? ' is-cut' : '')} key={entry.id} data-entry-id={entry.id} onContextMenu={onRowMenu}>
                    <div className="entry-main">
                      {checkbox}
                      <EntryVisual entry={entry} showThumbnail={section !== 'trash'} />
                      <div className="entry-name-wrap">
                        {entry.kind === 'folder' && section !== 'trash' ? (
                          <button className="entry-name" onClick={activate}>{entry.name}{isSystemFolder(entry) && <span className="system-badge">{t('entry.photos_badge')}</span>}</button>
                        ) : entry.kind === 'file' && section !== 'trash' ? (
                          isFilePreviewable(entry) ? (
                            <button className="entry-name" onClick={activate}>{entry.name}</button>
                          ) : <a className="entry-name" href={downloadUrl(entry.id)} onClick={(event) => { const gesture = selectionGesture(event, selectionMode); if (gesture) { event.preventDefault(); chooseEntries(entry.id, gesture); } }}>{entry.name}</a>
                        ) : (
                          <span className="entry-name">{entry.name}</span>
                        )}
                        <span className="entry-mobile-meta">
                          {entry.kind === 'folder' ? (entry.folder_file_count != null ? t('entry.files_count', { count: entry.folder_file_count }) : t('entry.folder')) : formatSize(entry.size_bytes)}
                          <span>·</span>{formatDate(section === 'trash' ? entry.deleted_at : entry.updated_at)}
                        </span>
                      </div>
                    </div>
                    <span className="entry-modified">{formatDate(section === 'trash' ? entry.deleted_at : entry.updated_at)}</span>
                    <span className="entry-size">{entrySize(entry)}</span>
                    <span className="entry-action">{actions}</span>
                  </div>
                  );
                }) : (
                  <div className="empty-state">
                    <span className="empty-icon">
                      {section === 'trash' ? <Trash2 size={22} /> : searchActive ? <Search size={22} /> : <Folder size={22} />}
                    </span>
                    <h2>{searchActive ? t('empty.no_match') : section === 'trash' ? t('empty.trash') : t('empty.folder')}</h2>
                    <p>{searchActive ? t('empty.no_match_hint') : section === 'trash' ? t('empty.trash_hint') : t('empty.folder_hint')}</p>
                    {!searchActive && section === 'drive' && (
                      <div className="empty-actions">
                        <button className="button button-secondary" onClick={() => setModal({ kind: 'new-folder' })}><FolderPlus size={16} /> {t('drive.new_folder')}</button>
                        <button className="button button-primary" onClick={pickFiles}><Upload size={16} /> {t('drive.upload_files')}</button>
                      </div>
                    )}
                  </div>
                )}
                {!loading && visibleRows.length > 0 && nextOffset != null && (
                  <button className="load-more" disabled={loadingMore} onClick={() => void loadMore()}>
                    {loadingMore ? t('misc.loading') : t('misc.load_more')}
                  </button>
                )}
              </div>
            </section>
          )}
        </main>
      </div>

      <nav className="mobile-nav" aria-label="Main navigation">
        <button
          className={section === 'drive' && !activeTeam ? 'active' : ''}
          onClick={() => {
            if (activeTeam) selectTeamWorkspace(null);
            else navigate('drive');
          }}
        ><HardDrive size={19} /><span>{t('nav.drive_short')}</span></button>
        <button className={section === 'photos' ? 'active' : ''} onClick={() => navigate('photos')}><Images size={19} /><span>{t('nav.photos')}</span></button>
        <button className={section === 'shared' ? 'active' : ''} onClick={() => navigate('shared')}><Users size={19} /><span>{t('nav.shared_short')}</span></button>
        <button className={section === 'settings' ? 'active' : ''} onClick={() => openSettings(null)}><Settings size={19} /><span>{t('nav.settings')}</span></button>
        <button className={section === 'trash' ? 'active' : ''} onClick={() => navigate('trash')}><Trash2 size={19} /><span>{t('nav.trash')}</span></button>
      </nav>

      {jobs.length > 0 && (
        <aside className="upload-queue" aria-label={t('upload.queue_label')}>
          <div className="upload-queue-head">
            <button className="upload-queue-open" onClick={() => setUploadManagerOpen(true)} aria-haspopup="dialog">
              <span className="upload-queue-mark"><CloudUpload size={17} /></span>
              <span className="upload-queue-summary">
                <strong>{retryingUploadJobs.length > 0 ? t('upload.retrying_n', { count: retryingUploadJobs.length }) : t('upload.title')}</strong>
                <small>
                  {t('upload.active_queued', { active: activeUploadJobs.length, queued: queuedUploadJobs.length })}
                  {totalUploadEta !== null ? ' · ' + t('upload.eta', { time: formatUploadEta(totalUploadEta) }) : ''}
                </small>
              </span>
              <span className="upload-queue-speed">{formatSize(totalUploadSpeed)}/s</span>
              <ChevronDown size={16} />
            </button>
            <details className="queue-menu">
              <summary className="icon-button" aria-label={t('upload.queue_actions')}><MoreHorizontal size={17} /></summary>
              <div className="menu-popover">
                {activeUploadJobs.length > 0 && <button onClick={pauseAllActive}>{t('upload.pause_active')}</button>}
                {pausedUploadJobs.length > 0 && <button onClick={resumeAllPaused}>{t('upload.resume_failed')}</button>}
                <button onClick={() => setJobs((items) => items.filter((job) => job.status !== 'done'))}>{t('upload.clear_done')}</button>
              </div>
            </details>
          </div>
          {unfinishedUploadJobs.length > 0 && (
            <div className="upload-queue-overall">
              <div className="upload-progress"><i style={{ width: overallBatchProgress + '%' }} /></div>
              <small>
                {Math.round(overallBatchProgress)}% · {formatSize(uploadedBatchBytes)} / {formatSize(totalBatchBytes)}
              </small>
            </div>
          )}
          <div className="upload-queue-items">
            {(activeUploadJobs.length ? activeUploadJobs : unfinishedUploadJobs).slice(0, 3).map((job) => {
              const badgeLabel = job.status === 'uploading'
                ? Math.round(job.progress) + '%'
                : job.status === 'retrying'
                  ? t('upload.status.retrying')
                  : job.status === 'queued'
                    ? t('upload.status.waiting')
                    : job.status === 'paused'
                      ? t('upload.status.paused')
                      : t('upload.status.failed');
              return (
                <div className="upload-job" key={job.key}>
                  <span className="upload-job-icon"><Upload size={15} /></span>
                  <div className="upload-job-content">
                    <div className="upload-job-title"><strong title={job.name}>{job.name}</strong><span className={job.status === 'retrying' ? 'upload-job-state upload-state-retrying' : ''}>{badgeLabel}</span></div>
                    <div className="upload-progress"><i style={{ width: job.progress + '%' }} /></div>
                    <small>
                      {formatSize(job.uploadedBytes)} / {formatSize(job.size)}
                      {job.status === 'uploading' ? ' · ' + formatSize(job.speed) + '/s' : job.status === 'retrying' ? ' · ' + job.detail : ''}
                    </small>
                  </div>
                </div>
              );
            })}
          </div>
        </aside>
      )}

      {uploadManagerOpen && (
        <div className="upload-manager-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setUploadManagerOpen(false); }}>
          <section className="upload-manager" role="dialog" aria-modal="true" aria-labelledby="upload-manager-title">
            <header className="upload-manager-header">
              <div>
                <span className="eyebrow">{t('upload.manager_eyebrow')}</span>
                <h2 id="upload-manager-title">{t('upload.manager_title')}</h2>
                <p>
                  {t('upload.manager_counts', { active: activeUploadJobs.length, retrying: retryingUploadJobs.length > 0 ? t('upload.retrying_suffix', { count: retryingUploadJobs.length }) : '', queued: queuedUploadJobs.length, speed: formatSize(totalUploadSpeed) })}
                  {totalUploadEta !== null ? ' · ' + t('upload.eta', { time: formatUploadEta(totalUploadEta) }) : ''}
                </p>
              </div>
              <div className="upload-manager-header-actions">
                {activeUploadJobs.length > 0 && <button className="upload-manager-clear" onClick={pauseAllActive}>{t('upload.pause_active')}</button>}
                {pausedUploadJobs.length > 0 && <button className="upload-manager-clear" onClick={resumeAllPaused}>{t('upload.resume_all')}</button>}
                <button className="upload-manager-clear" disabled={!completedUploadCount} onClick={() => setJobs((items) => items.filter((job) => job.status !== 'done'))}>{t('upload.clear_done')}</button>
                <button className="icon-button" onClick={() => setUploadManagerOpen(false)} aria-label={t('upload.manager_close')}><X size={18} /></button>
              </div>
            </header>

            <div className="upload-manager-summary">
              <div><span>{t('upload.summary_files')}</span><strong>{jobs.length}</strong></div>
              <div><span>{t('upload.summary_active')}</span><strong>{activeUploadJobs.length} / {MAX_CONCURRENT_UPLOADS}</strong></div>
              <div><span>{t('upload.summary_waiting')}</span><strong>{queuedUploadJobs.length}</strong></div>
              <div><span>{t('upload.summary_paused')}</span><strong>{pausedUploadJobs.length}</strong></div>
              <div><span>{t('upload.summary_done')}</span><strong>{completedUploadCount}</strong></div>
            </div>

            {unfinishedUploadJobs.length > 0 && (
              <div className="upload-manager-overall">
                <div className="upload-manager-overall-meta">
                  <span>{t('upload.overall', { pct: Math.round(overallBatchProgress) })}</span>
                  <span>{formatSize(uploadedBatchBytes)} / {formatSize(totalBatchBytes)} · {t('upload.eta', { time: formatUploadEta(totalUploadEta) })}</span>
                </div>
                <div className="upload-progress"><i style={{ width: overallBatchProgress + '%' }} /></div>
              </div>
            )}

            <div className="upload-manager-list">
              {jobs.length === 0 && <p className="upload-manager-empty">{t('upload.no_tasks')}</p>}
              {jobs.map((job) => {
                const task = uploadTasksRef.current.get(job.key);
                const isFinishing = !!task?.finalizing;
                const isControlling = !!task?.action;
                const isActiveStatus = job.status === 'uploading' || job.status === 'retrying';
                const statusLabel = isFinishing
                  ? t('upload.status.finishing')
                  : job.status === 'uploading'
                    ? t('upload.status.uploading')
                    : job.status === 'retrying'
                      ? t('upload.status.retrying')
                      : job.status === 'queued'
                        ? t('upload.status.waiting')
                        : job.status === 'paused'
                          ? t('upload.status.paused')
                          : job.status === 'error'
                            ? t('upload.status.failed')
                            : t('upload.status.complete');
                const eta = job.status === 'uploading' && job.speed > 0 ? (job.size - job.uploadedBytes) / job.speed : null;
                return (
                  <article className="upload-manager-job" key={job.key}>
                    <div className="upload-manager-job-main">
                      <span className={'upload-job-icon' + (job.status === 'done' ? ' upload-complete-icon' : '')}>{job.status === 'done' ? <Check size={16} /> : <Upload size={15} />}</span>
                      <div className="upload-job-content">
                        <div className="upload-job-title"><strong title={job.name}>{job.name}</strong><span className={'upload-job-state upload-state-' + job.status}>{statusLabel}</span></div>
                        <div className="upload-progress" role="progressbar" aria-label={t('upload.progress_label', { name: job.name })} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(job.progress)}><i style={{ width: job.progress + '%' }} /></div>
                        <div className="upload-manager-job-stats">
                          <span>{formatSize(job.uploadedBytes)} / {formatSize(job.size)} ({Math.round(job.progress)}%)</span>
                          <span>{job.status === 'uploading' ? formatSize(job.speed) + '/s' : job.status === 'retrying' ? t('upload.recovering') : '—'}</span>
                          <span>{t('upload.eta', { time: formatUploadEta(eta) })}</span>
                        </div>
                        <small className="upload-manager-detail">{job.detail}</small>
                      </div>
                    </div>
                    <div className="upload-manager-job-actions">
                      {isActiveStatus && !isFinishing && !isControlling && <button className="queue-action" onClick={() => pauseUpload(job)} aria-label={t('a11y.pause', { name: job.name })} title={t('upload.pause_title')}><Pause size={16} /></button>}
                      {job.status === 'queued' && <button className="queue-action" onClick={() => void cancelUpload(job)} aria-label={t('a11y.cancel', { name: job.name })} title={t('upload.cancel_title')}><X size={16} /></button>}
                      {job.status === 'paused' && <button className="queue-action" onClick={() => resumeUpload(job)} aria-label={t('a11y.resume', { name: job.name })} title={t('upload.resume_title')}><Play size={16} /></button>}
                      {job.status === 'error' && <button className="queue-action" onClick={() => retryUpload(job)} aria-label={t('a11y.retry', { name: job.name })} title={t('upload.retry_title')}><RotateCcw size={16} /></button>}
                      {(isActiveStatus || job.status === 'paused' || job.status === 'error') && !isFinishing && !isControlling && <button className="queue-action" onClick={() => void cancelUpload(job)} aria-label={t('a11y.cancel', { name: job.name })} title={t('upload.cancel_title')}><X size={16} /></button>}
                    </div>
                  </article>
                );
              })}
            </div>
          </section>
        </div>
      )}

      {modal?.kind === 'destination' && (
        <DestinationDialog
          title={modal.action === 'copy' ? t('dialog.copy_items') : t('dialog.move_items')}
          description={modal.ids.length === 1 ? t('dialog.dest_one') : t('dialog.dest_many', { count: modal.ids.length })}
          confirmLabel={modal.action === 'copy' ? t('dialog.copy_here') : t('dialog.move_here')}
          startId={currentFolderId}
          excludeIds={modal.ids}
          onCancel={() => setModal(null)}
          onConfirm={async (parentId) => {
            await runBatch(modal.action, modal.ids, parentId);
          }}
        />
      )}

      {modal && modal.kind !== 'destination' && (
        <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setModal(null); }}>
          <section className="modal-card" role="dialog" aria-modal="true" aria-labelledby="modal-title">
            <button className="modal-close icon-button" onClick={() => setModal(null)} aria-label={t('dialog.close')}><X size={18} /></button>
            {modal.kind === 'new-folder' && (
              <>
                <span className="modal-icon"><FolderPlus size={19} /></span>
                <span className="eyebrow">{t('dialog.organize')}</span>
                <h2 id="modal-title">{t('dialog.new_folder_title')}</h2>
                <p className="modal-description">{t('dialog.new_folder_desc', { location: activeSectionLabel })}</p>
                <form className="form-stack" onSubmit={(event) => void createFolder(event)}>
                  <label className="field-label" htmlFor="folder-name">{t('dialog.folder_name')}</label>
                  <input autoFocus id="folder-name" name="name" className="text-input" maxLength={255} required placeholder={t('dialog.folder_placeholder')} />
                  <div className="modal-actions"><button type="button" className="button button-secondary" onClick={() => setModal(null)}>{t('dialog.cancel')}</button><button type="submit" className="button button-primary">{t('dialog.create_folder')}</button></div>
                </form>
              </>
            )}
            {modal.kind === 'rename' && (
              <>
                <span className="modal-icon">{extensionIcon(modal.entry)}</span>
                <span className="eyebrow">{t('dialog.rename_eyebrow')}</span>
                <h2 id="modal-title">{t('dialog.rename_title', { kind: modal.entry.kind === 'folder' ? t('entry.kind_folder') : t('entry.kind_file') })}</h2>
                <p className="modal-description">{t('dialog.rename_desc')}</p>
                <form className="form-stack" onSubmit={(event) => void renameEntry(event, modal.entry)}>
                  <label className="field-label" htmlFor="rename-name">{t('dialog.name')}</label>
                  <input autoFocus id="rename-name" name="name" className="text-input" maxLength={255} required defaultValue={modal.entry.name} />
                  <div className="modal-actions"><button type="button" className="button button-secondary" onClick={() => setModal(null)}>{t('dialog.cancel')}</button><button type="submit" className="button button-primary">{t('dialog.save_name')}</button></div>
                </form>
              </>
            )}
          </section>
        </div>
      )}

      {shareTargets && (
        <ShareDialog
          entries={shareTargets}
          onClose={() => setShareTargets(null)}
          onCreated={() => {
            setShareRefresh((value) => value + 1);
            setNotice(shareTargets.length > 1 ? t('notice.shares_created') : t('notice.share_created'));
          }}
        />
      )}

      {section === 'drive' && selectedIds.length > 0 && (
        <div className="batch-bar" role="toolbar" aria-label={t('batch.label')}>
          <strong>{t('toolbar.selected', { count: selectedIds.length })}</strong>
          <button className="batch-action" type="button" onClick={() => downloadFiles(entries.filter((entry) => selectedIds.includes(entry.id) && entry.kind === 'file').map((entry) => entry.id))}><Download size={15} /> {t('menu.download')}</button>
          <button className="batch-action" type="button" onClick={() => setShareTargets(shareSubjects(selectedIds))}><Share2 size={15} /> {t('menu.share')}</button>
          <button className="batch-action" type="button" onClick={() => setModal({ kind: 'destination', action: 'move', ids: operableIds(selectedIds) })}><FolderInput size={15} /> {t('menu.move')}</button>
          <button className="batch-action" type="button" onClick={() => setModal({ kind: 'destination', action: 'copy', ids: operableIds(selectedIds) })}><Copy size={15} /> {t('menu.copy')}</button>
          <button className="batch-action" type="button" onClick={() => { const ids = operableIds(selectedIds); setClipboard({ mode: 'cut', ids }); setNotice(t('notice.move_ready', { count: ids.length })); }}><Scissors size={15} /> {t('menu.cut')}</button>
          <button className="batch-action batch-danger" type="button" onClick={() => void trashEntries(selectedIds)}><Trash2 size={15} /> {t('nav.trash')}</button>
          <button className="batch-action" type="button" onClick={() => { setSelectedIds([]); setSelectionMode(false); }}>{t('filters.clear')}</button>
        </div>
      )}

      {contextMenu && section === 'drive' && (
        <ContextMenu
          point={{ x: contextMenu.x, y: contextMenu.y }}
          items={contextMenu.ids.length ? entryMenuItems(contextMenu.ids) : backgroundMenuItems()}
          label={t('menu.item_actions')}
          onClose={() => setContextMenu(null)}
        />
      )}

      {detailsId && (
        <aside className="details-drawer" aria-label={t('details.label')}>
          <header>
            <strong>{t('menu.details')}</strong>
            <button className="icon-button" onClick={() => setDetailsId(null)} aria-label={t('details.close')}><X size={16} /></button>
          </header>
          {!details ? (
            <p className="details-loading">{t('details.loading')}</p>
          ) : (
            <dl>
              <div><dt>{t('details.name')}</dt><dd>{details.name}</dd></div>
              <div><dt>{t('details.type')}</dt><dd>{details.mime_type || details.category}</dd></div>
              <div><dt>{t('details.size')}</dt><dd>{formatSize(details.size_bytes)}</dd></div>
              <div><dt>{t('details.created')}</dt><dd>{formatDate(details.created_at)}</dd></div>
              <div><dt>{t('details.modified')}</dt><dd>{formatDate(details.updated_at)}</dd></div>
              <div><dt>{t('details.location')}</dt><dd>{details.location}</dd></div>
              <div><dt>{t('details.index')}</dt><dd>{details.category}</dd></div>
              {details.media.width && details.media.height ? <div><dt>{t('details.dimensions')}</dt><dd>{details.media.width} × {details.media.height}</dd></div> : null}
              {details.folder && (
                <>
                  <div><dt>{t('details.folder_size')}</dt><dd>{formatSize(details.folder.total_bytes)}</dd></div>
                  <div><dt>{t('details.files')}</dt><dd>{details.folder.file_count}</dd></div>
                  <div><dt>{t('details.subfolders')}</dt><dd>{details.folder.subfolder_count}</dd></div>
                  {Object.entries(details.folder.by_category).map(([category, bytes]) => (
                    <div key={category}><dt>{category}</dt><dd>{formatSize(bytes)}</dd></div>
                  ))}
                </>
              )}
            </dl>
          )}
        </aside>
      )}

      {viewer && (
        <FilePreviewer
          items={previewItems.length ? previewItems : [viewer]}
          index={Math.max(previewItems.findIndex((item) => item.id === viewer.id), 0)}
          onIndexChange={(next) => {
            const item = (previewItems.length ? previewItems : [viewer])[next];
            if (item) showDrive({ fileId: item.id }, 'replace');
          }}
          onClose={() => clearSearchParam('file')}
          loadDetails={(item) => api.entryDetails(item.id).catch(() => null)}
        />
      )}
    </div>
  );
}
