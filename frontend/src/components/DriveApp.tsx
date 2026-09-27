import { useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent, type MouseEvent } from 'react';
import {
  Activity, Check, ChevronDown, ChevronRight, CircleUserRound, ClipboardPaste, Cloud, CloudUpload, Copy, Download, Eye, File, FileImage, Film,
  FileSpreadsheet, FileText, Folder, FolderInput, FolderPlus, Gauge, HardDrive, Images, Info, LayoutGrid, List, LockKeyhole, LogOut, MoreHorizontal,
  Pause, Play, Presentation, RotateCcw, ScanFace, Scissors, Search, Share2, ShieldCheck, SlidersHorizontal, Trash2, Upload, Users, X
} from 'lucide-react';
import { ApiError, api, downloadUrl, thumbnailUrl, type MediaIndexJob, type MediaIndexStatus } from '../api';
import { formatDate, formatSize, friendlyError } from '../format';
import { buildDrivePath, clearSearchParam, emptyFilters, hasActiveFilters, navigateTo, parseDriveRoute, useBrowserHref, type DriveFilters, type DriveOrder, type DrivePanel, type DriveSort } from '../route';
import { nextSelection, selectionGesture } from '../selection';
import type { Entry, EntryDetails, EntryPage, ShareSummary, User } from '../types';
import ShareDialog from './ShareDialog';
import { AnchoredMenu, ContextMenu, type MenuItem } from './ContextMenu';
import DestinationDialog from './DestinationDialog';
import FilePreviewer from './FilePreviewer';
import { isFilePreviewable, mediaKindFor } from './MediaViewer';
import AccountManagementPanel from './AccountManagementPanel';
import FaceManagementPanel from './FaceManagementPanel';
import PhotosPage from './PhotosPage';
import StoragePage, { QuotaCard } from './StoragePage';
import GoogleDrivePanel from './GoogleDrivePanel';
import AccountSecurityPanel from './AccountSecurityPanel';

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

type UploadStatus = 'queued' | 'uploading' | 'paused' | 'done' | 'error';
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
  sampleAt: number;
  sampleBytes: number;
  lastProgressAt: number;
};

const RESUME_KEY = 'my-drive.upload-sessions.v1';
const CHUNK_SIZE = 8 * 1024 * 1024;
const MAX_CONCURRENT_UPLOADS = 3;

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

function displayShareStatus(share: ShareSummary): { label: string; className: string } {
  if (share.revoked_at) return { label: 'Revoked', className: 'status-neutral' };
  if (share.expires_at && new Date(share.expires_at).getTime() <= Date.now()) {
    return { label: 'Expired', className: 'status-neutral' };
  }
  if (share.max_downloads != null && share.download_count >= share.max_downloads) {
    return { label: 'Limit reached', className: 'status-warning' };
  }
  return { label: 'Active', className: 'status-active' };
}

function mediaStageLabel(stage: string | null): string {
  const labels: Record<string, string> = {
    opening_source: 'Reading original media',
    copying_source: 'Reading original media',
    checking_dimensions: 'Checking media dimensions',
    thumbnailing_viewer: 'Building image viewer preview',
    thumbnailing_card: 'Building image card preview',
    extracting_video_poster: 'Extracting video poster frame',
    encoding_video_poster: 'Encoding video poster',
    transcoding_video_preview: 'Building browser video preview',
    extracting_face_frame: 'Extracting face index frame',
    detecting_faces: 'Detecting faces',
    publishing_viewer: 'Saving image viewer preview',
    publishing_card: 'Saving image card preview',
    publishing_video_poster: 'Saving video poster',
    publishing_video_preview: 'Saving browser video preview'
  };
  return stage ? labels[stage] || 'Processing media' : 'Starting';
}

function mediaTaskLabel(task: string): string {
  switch (task) {
    case 'image_preview': return 'Image preview';
    case 'video_thumbnail': return 'Video poster';
    case 'video_preview': return 'Browser video preview';
    case 'face_index': return 'Face index';
    default: return 'Media job';
  }
}

function mediaFailureLabel(code: string | null): string {
  const labels: Record<string, string> = {
    unsupported_format: 'This media format is not supported for previews.',
    decode_failed: 'The media could not be decoded.',
    input_missing: 'The original file is unavailable.',
    resource_limit: 'The media exceeds preview processing limits.',
    preview_storage_unavailable: 'Preview storage is unavailable.',
    detector_unavailable: 'Face detector is unavailable on the indexer.',
    processing_failed: 'Preview processing failed.'
  };
  return code ? labels[code] || labels.processing_failed : labels.processing_failed;
}

function MediaIndexPanel({ onClose }: { onClose: () => void }) {
  const [status, setStatus] = useState<MediaIndexStatus | null>(null);
  const [olderJobs, setOlderJobs] = useState<MediaIndexJob[]>([]);
  const [olderCursor, setOlderCursor] = useState<number | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const activeRequests = useRef<Set<AbortController>>(new Set());

  useEffect(() => {
    let closed = false;
    let timer: number | undefined;
    const poll = async () => {
      const controller = new AbortController();
      activeRequests.current.add(controller);
      try {
        const result = await api.mediaIndexStatus(controller.signal);
        if (!closed) {
          setStatus(result);
          setError('');
          if (olderJobs.length === 0) setOlderCursor(result.nextBeforeId);
        }
      } catch (cause: unknown) {
        if (!closed && !controller.signal.aborted) setError(friendlyError(cause));
      } finally {
        activeRequests.current.delete(controller);
        if (!closed) timer = window.setTimeout(() => void poll(), 15000);
      }
    };
    void poll();
    return () => {
      closed = true;
      if (timer != null) window.clearTimeout(timer);
      activeRequests.current.forEach((controller) => controller.abort());
      activeRequests.current.clear();
    };
  }, [reloadKey, olderJobs.length]);

  async function runAction(action: 'pause' | 'resume' | 'retry' | 'retry-all', jobId?: number) {
    const key = jobId == null ? action : 'retry-' + jobId;
    const controller = new AbortController();
    activeRequests.current.add(controller);
    setBusyAction(key);
    setError('');
    setNotice('');
    try {
      if (action === 'pause' || action === 'resume') {
        const result = await api.setMediaIndexPaused(action === 'pause', controller.signal);
        if (!controller.signal.aborted) {
          setStatus((current) => current ? { ...current, paused: result.paused } : current);
          setNotice(result.paused ? 'Media preview indexing paused.' : 'Media preview indexing resumed.');
        }
      } else {
        const result = await api.retryMediaIndex(jobId, controller.signal);
        if (!controller.signal.aborted) {
          setOlderJobs((jobs) => jobs.filter((job) => jobId == null || job.id !== jobId));
          setNotice(result.retried === 1 ? 'One failed job queued for retry.' : result.retried + ' failed jobs queued for retry.');
        }
      }
      if (!controller.signal.aborted) setReloadKey((value) => value + 1);
    } catch (cause: unknown) {
      if (!controller.signal.aborted) setError(friendlyError(cause));
    } finally {
      activeRequests.current.delete(controller);
      if (!controller.signal.aborted) setBusyAction(null);
    }
  }

  async function loadOlderJobs() {
    if (olderCursor == null || loadingOlder) return;
    const controller = new AbortController();
    activeRequests.current.add(controller);
    setLoadingOlder(true);
    try {
      const page = await api.mediaIndexStatus(controller.signal, olderCursor);
      if (!controller.signal.aborted) {
        setOlderJobs((jobs) => {
          const existing = new Set(jobs.map((job) => job.id));
          return [...jobs, ...page.jobs.filter((job) => !existing.has(job.id))];
        });
        setOlderCursor(page.nextBeforeId);
      }
    } catch (cause: unknown) {
      if (!controller.signal.aborted) setError(friendlyError(cause));
    } finally {
      activeRequests.current.delete(controller);
      if (!controller.signal.aborted) setLoadingOlder(false);
    }
  }

  const allJobs = status ? [...status.jobs, ...olderJobs] : olderJobs;
  const failedJobs = allJobs.filter((job) => job.state === 'failed');
  const visibleFailures = failedJobs.slice(0, 4);
  const counts = status?.counts;
  const activeJob = status?.jobs.find((job) => job.state === 'running');

  return (
    <section className="media-index-panel" id="media-index-panel" aria-labelledby="media-index-title">
      <div className="media-index-header">
        <div>
          <span className="eyebrow">OWNER CONTROLS</span>
          <h2 id="media-index-title">Media preview indexing</h2>
          <p>Track preview processing and manage failed jobs.</p>
        </div>
        <button className="icon-button media-index-close" type="button" onClick={onClose} aria-label="Close media indexing panel"><X size={18} /></button>
      </div>

      {error ? <div className="media-index-message media-index-error" role="alert">{error}</div> : null}
      {notice ? <div className="media-index-message media-index-notice" role="status">{notice}</div> : null}

      {status ? (
        <>
          <div className="media-index-toolbar">
            <span className={'media-index-health ' + (status.previewStorageAvailable ? 'is-healthy' : 'is-unhealthy')} role="status">
              <i /> Preview SSD {status.previewStorageAvailable ? 'available' : 'unavailable'}
            </span>
            <div className="media-index-actions">
              <button
                className="button button-secondary"
                type="button"
                disabled={busyAction != null}
                onClick={() => void runAction(status.paused ? 'resume' : 'pause')}
              >
                {status.paused ? <Play size={15} /> : <Pause size={15} />}
                {status.paused ? 'Resume indexing' : 'Pause indexing'}
              </button>
              {status.counts.failed > 0 ? (
                <button
                  className="button button-secondary"
                  type="button"
                  disabled={busyAction != null}
                  onClick={() => void runAction('retry-all')}
                >
                  <RotateCcw size={15} /> Retry all failed
                </button>
              ) : null}
            </div>
          </div>

          <div className="media-index-metrics" aria-label="Media preview indexing totals">
            <div><span>Queued</span><strong>{counts?.queued ?? 0}</strong></div>
            <div><span>Running</span><strong>{counts?.running ?? 0}</strong></div>
            <div><span>Completed</span><strong>{counts?.completed ?? 0}</strong></div>
            <div><span>Unsupported</span><strong>{counts?.unsupported ?? 0}</strong></div>
            <div><span>Retry waiting</span><strong>{counts?.retryWait ?? 0}</strong></div>
            <div><span>Failed</span><strong>{counts?.failed ?? 0}</strong></div>
          </div>

          <div className="media-index-byte-stats">
            <div><span>Bytes pending</span><strong>{formatSize(status.pendingBytes)}</strong></div>
            <div><span>Bytes processed in active jobs</span><strong>{formatSize(status.processedBytes)}</strong></div>
          </div>

          {status.taskMetrics?.length ? (
            <div className="media-index-task-metrics" aria-label="Media preview indexing by task">
              {status.taskMetrics.map((metric) => (
                <article key={metric.task}>
                  <div className="media-index-task-heading">
                    <strong>{mediaTaskLabel(metric.task)}</strong>
                    <span>{metric.counts.running > 0 ? `${metric.counts.running} running` : 'Idle'}</span>
                  </div>
                  <div className="media-index-task-counts">
                    <span>{metric.counts.queued} queued</span>
                    <span>{metric.counts.completed} done</span>
                    <span>{metric.counts.failed} failed</span>
                  </div>
                  <div className="media-index-task-bytes">
                    <span>{formatSize(metric.pendingBytes)} pending</span>
                    <span>{formatSize(metric.processedBytes)} active</span>
                  </div>
                </article>
              ))}
            </div>
          ) : null}

          <div className="media-index-active" aria-live="polite">
            <Activity size={16} />
            {activeJob ? (
              <span><strong>{activeJob.fileName}</strong> · {mediaTaskLabel(activeJob.task)} · {mediaStageLabel(activeJob.currentStage)} · {formatSize(activeJob.processedBytes)} / {formatSize(activeJob.totalBytes)}</span>
            ) : <span>No media preview job is running right now.</span>}
          </div>

          <div className="media-index-failures">
            <div className="media-index-subhead"><strong>Recent failures</strong><span>{counts?.failed ?? 0} total</span></div>
            {visibleFailures.length ? (
              <ul>
                {visibleFailures.map((job) => (
                  <li key={job.id}>
                    <div><strong title={job.fileName}>{job.fileName}</strong><span>{mediaTaskLabel(job.task)} · {mediaFailureLabel(job.errorCode)}</span></div>
                    <button
                      className="button button-secondary"
                      type="button"
                      disabled={busyAction != null}
                      onClick={() => void runAction('retry', job.id)}
                      aria-label={'Retry preview for ' + job.fileName}
                    >
                      <RotateCcw size={14} /> Retry
                    </button>
                  </li>
                ))}
              </ul>
            ) : counts?.failed ? (
              <p className="media-index-empty">Failed jobs are older than the latest 100 jobs. Load older jobs to review their sanitized errors.</p>
            ) : (
              <p className="media-index-empty">No failed media preview jobs.</p>
            )}
            {olderCursor != null && failedJobs.length < (counts?.failed ?? 0) ? (
              <button className="load-more media-index-load-more" type="button" disabled={loadingOlder} onClick={() => void loadOlderJobs()}>
                {loadingOlder ? 'Loading older jobs…' : 'Load older jobs'}
              </button>
            ) : null}
            {failedJobs.length > visibleFailures.length ? <p className="media-index-empty">Showing the 4 most recent of {failedJobs.length} loaded failures.</p> : null}
          </div>
        </>
      ) : (
        <div className="media-index-loading" role="status">Loading indexing status…</div>
      )}
    </section>
  );
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
  const href = useBrowserHref();
  const route = useMemo(() => {
    const search = href.includes('?') ? href.slice(href.indexOf('?')) : '';
    const pathname = href.includes('?') ? href.slice(0, href.indexOf('?')) : href;
    return parseDriveRoute(pathname, search);
  }, [href]);
  const section = route.section;
  const panel: DrivePanel = section !== 'drive' || route.panel == null
    ? null
    : route.panel === 'google-drive' || route.panel === 'security' || user.role === 'owner'
      ? route.panel
      : null;
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
  const accountAdminOpen = panel === 'accounts';
  const faceAdminOpen = panel === 'faces';
  const mediaIndexOpen = panel === 'indexing';
  const googleDriveOpen = panel === 'google-drive';
  const securityOpen = panel === 'security';
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
      detail: 'Choose this file again to resume.',
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
      const now = performance.now();
      setJobs((items) => {
        let changed = false;
        const next = items.map((job) => {
          const task = activeUploadsRef.current.get(job.key);
          if (!task) return job;
          const speed = now - task.lastProgressAt > 1200 ? 0 : task.speed;
          task.speed = speed;
          if (job.speed === speed) return job;
          changed = true;
          return { ...job, speed };
        });
        return changed ? next : items;
      });
    }, 500);
    return () => window.clearInterval(timer);
  }, []);
  const shortcutLabel = navigator.platform.toLowerCase().includes('mac') ? '⌘ K' : 'Ctrl K';
  const activeSectionLabel = section === 'drive'
    ? (!pathReady ? 'Opening folder…' : currentFolderId ? breadcrumbs[breadcrumbs.length - 1].name : 'My Drive')
    : section === 'shared' ? 'Shared links'
      : section === 'photos' ? 'Photos'
        : section === 'storage' ? 'Storage'
          : 'Trash';
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
      panel?: DrivePanel;
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
      panel: overrides.panel === undefined ? panel : overrides.panel,
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

  useEffect(() => {
    const title = (panel === 'accounts'
      ? 'Accounts'
      : panel === 'faces'
        ? 'Face groups'
          : panel === 'indexing'
            ? 'Media indexing'
            : panel === 'google-drive'
              ? 'Google Drive'
              : panel === 'security'
                ? 'Account security'
                : activeSectionLabel) + ' · My Drive';
    document.title = !panel && activeSectionLabel === 'My Drive' ? 'My Drive' : title;
  }, [activeSectionLabel, panel]);

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
      panel: section === 'drive' ? panel : null,
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
        setNotice(selectedIds.length === 1 ? 'Copied 1 item.' : `Copied ${selectedIds.length} items.`);
      } else if (command && key === 'x' && selectedIds.length) {
        event.preventDefault();
        const ids = operableIds(selectedIds);
        if (!ids.length) {
          setError('The Photos folder cannot be moved.');
          return;
        }
        setClipboard({ mode: 'cut', ids });
        setNotice(ids.length === 1 ? 'Ready to move 1 item.' : `Ready to move ${ids.length} items.`);
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
    if (section === 'photos' || section === 'storage') {
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
  }, [section, currentFolderId, pathReady, query, route.filters, route.order, route.sort, refresh, shareRefresh, onLoggedOut]);

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
      setNotice(report.entries > 0 ? message : 'Nothing to delete');
      setRefresh((value) => value + 1);
    } catch (cause) {
      setError(friendlyError(cause));
    }
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
      setError('The Photos folder cannot be moved.');
      return false;
    }
    try {
      if (entry.kind === 'folder' && targetId) {
        let parent = await api.getEntry(targetId);
        while (true) {
          if (parent.id === entry.id) {
            setError('A folder cannot be moved into itself or one of its own folders.');
            return false;
          }
          if (!parent.parent_id) break;
          parent = await api.getEntry(parent.parent_id);
        }
      }
      await api.moveEntry(entry.id, targetId);
      setNotice(targetId ? 'Item moved' : 'Item moved to My Drive');
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
      setError('The Photos folder cannot be renamed, moved, copied, or deleted.');
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
    const verb = action === 'copy' ? 'Copied' : action === 'move' ? 'Moved' : 'Moved to trash';
    setNotice(`${verb} ${result.count} item${result.count === 1 ? '' : 's'}.` + (skipped ? ' The Photos folder was left in place.' : ''));
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
      setError('The Photos folder cannot be deleted.');
      return;
    }
    const count = allowed.length;
    if (!window.confirm(count === 1 ? 'Move this item to trash?' : `Move ${count} items to trash?`)) return;
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
      { id: 'open', label: single?.kind === 'folder' ? 'Open' : 'Open', hidden: !single, icon: single?.kind === 'folder' ? <Folder size={15} /> : <Eye size={15} />, onSelect: () => {
        if (!single) return;
        if (single.kind === 'folder') void openFolder(single);
        else if (isFilePreviewable(single)) openPreview(single);
        else window.location.assign(downloadUrl(single.id));
      } },
      { id: 'preview', label: 'Preview', hidden: !single || single.kind !== 'file' || !isFilePreviewable(single), icon: <Eye size={15} />, onSelect: () => single && openPreview(single) },
      { id: 'download', label: files.length > 1 ? 'Download' : 'Download', hidden: files.length === 0, icon: <Download size={15} />, onSelect: () => downloadFiles(files.map((entry) => entry.id)) },
      { id: 'share', label: 'Share', hidden: chosen.length === 0, icon: <Share2 size={15} />, onSelect: () => setShareTargets(shareSubjects(ids)) },
      { id: 'details', label: 'Details', hidden: !single, icon: <Info size={15} />, onSelect: () => single && setDetailsId(single.id) },
      { id: 'rename', label: 'Rename', hidden: !single, disabled: !single || isSystemFolder(single), onSelect: () => single && setModal({ kind: 'rename', entry: single }) },
      { id: 'move', label: 'Move', disabled: locked, icon: <FolderInput size={15} />, onSelect: () => setModal({ kind: 'destination', action: 'move', ids: operableIds(ids) }) },
      { id: 'copy-to', label: 'Copy to…', disabled: locked, icon: <Copy size={15} />, onSelect: () => setModal({ kind: 'destination', action: 'copy', ids: operableIds(ids) }) },
      { id: 'cut', label: 'Cut', disabled: locked, icon: <Scissors size={15} />, onSelect: () => { const next = operableIds(ids); setClipboard({ mode: 'cut', ids: next }); setNotice(next.length === 1 ? 'Ready to move 1 item.' : `Ready to move ${next.length} items.`); } },
      { id: 'copy', label: 'Copy', disabled: locked, icon: <Copy size={15} />, onSelect: () => { const next = operableIds(ids); setClipboard({ mode: 'copy', ids: next }); setNotice(next.length === 1 ? 'Copied 1 item.' : `Copied ${next.length} items.`); } },
      { id: 'move-here', label: 'Move to this folder', hidden: !single || !currentFolderId || single.parent_id === currentFolderId, disabled: !single || isSystemFolder(single), onSelect: () => single && void moveTo(single, currentFolderId) },
      { id: 'move-root', label: 'Move to My Drive', hidden: !single || single.parent_id === null, disabled: !single || isSystemFolder(single), onSelect: () => single && void moveTo(single, null) },
      { id: 'trash', label: 'Move to trash', danger: true, disabled: locked, icon: <Trash2 size={15} />, onSelect: () => void trashEntries(ids) }
    ];
  }

  function backgroundMenuItems(): MenuItem[] {
    return [
      { id: 'upload', label: 'Upload files', icon: <Upload size={15} />, onSelect: pickFiles },
      { id: 'folder', label: 'New folder', icon: <FolderPlus size={15} />, onSelect: () => setModal({ kind: 'new-folder' }) },
      { id: 'paste', label: clipboard?.mode === 'cut' ? 'Paste move' : 'Paste', disabled: !clipboard, icon: <ClipboardPaste size={15} />, onSelect: () => void pasteClipboard() },
      { id: 'select-all', label: 'Select all', disabled: entries.length === 0, onSelect: () => { setSelectedIds(entries.map((entry) => entry.id)); setSelectionMode(true); } }
    ];
  }

  function setUploadProgress(task: UploadTask, bytes: number) {
    const fileSize = task.file?.size ?? 0;
    const uploadedBytes = fileSize ? Math.min(fileSize, Math.max(0, bytes)) : 0;
    const now = performance.now();
    const elapsed = (now - task.sampleAt) / 1000;
    const delta = uploadedBytes - task.sampleBytes;
    if (delta > 0 && elapsed >= 0.025) {
      const sampleSpeed = delta / elapsed;
      task.speed = task.speed > 0 ? task.speed * 0.65 + sampleSpeed * 0.35 : sampleSpeed;
      task.sampleAt = now;
      task.sampleBytes = uploadedBytes;
    }
    task.uploadedBytes = uploadedBytes;
    task.lastProgressAt = now;
    updateJob(task.key, {
      uploadedBytes,
      progress: fileSize ? (uploadedBytes / fileSize) * 100 : 100,
      speed: task.speed,
      detail: 'Uploading…'
    });
  }

  function resetUploadProgress(task: UploadTask, bytes: number) {
    const fileSize = task.file?.size ?? 0;
    const uploadedBytes = fileSize ? Math.min(fileSize, Math.max(0, bytes)) : 0;
    const now = performance.now();
    task.uploadedBytes = uploadedBytes;
    task.speed = 0;
    task.sampleAt = now;
    task.sampleBytes = uploadedBytes;
    task.lastProgressAt = now;
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
        detail: `Paused at ${formatSize(task.uploadedBytes)}.`
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
      updateJob(task.key, { status: 'paused', detail: 'Choose this file again to resume.' });
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

      updateJob(task.key, { detail: 'Preparing transfer…' });
      let server = await api.uploadHead(session.id);
      offset = Math.min(server.offset, file.size);
      persistUploadOffset(session, offset);
      resetUploadProgress(task, offset);
      if (task.action && await handleUploadAction(task, session, offset)) return;

      while (offset < file.size) {
        if (task.action && await handleUploadAction(task, session, offset)) return;
        const end = Math.min(offset + CHUNK_SIZE, file.size);
        const controller = new AbortController();
        task.controller = controller;
        try {
          await api.uploadChunk(
            session.id,
            offset,
            file.slice(offset, end),
            (loadedBytes) => setUploadProgress(task, offset + loadedBytes),
            controller.signal
          );
          task.controller = null;
          offset = end;
          persistUploadOffset(session, offset);
          setUploadProgress(task, offset);
        } catch (cause) {
          task.controller = null;
          if (task.action && await handleUploadAction(task, session, offset)) return;
          if (cause instanceof ApiError && cause.status === 409 && cause.code === 'offset_mismatch') {
            server = await api.uploadHead(session.id);
            if (server.offset === offset) throw cause;
            offset = Math.min(server.offset, file.size);
            persistUploadOffset(session, offset);
            resetUploadProgress(task, offset);
            continue;
          }
          throw cause;
        }
        if (task.action && await handleUploadAction(task, session, offset)) return;
      }

      if (task.action && await handleUploadAction(task, session, offset)) return;
      task.finalizing = true;
      task.speed = 0;
      updateJob(task.key, { detail: 'Finishing upload…', speed: 0 });
      await api.finalizeUpload(session.id);
      task.session = null;
      task.finalizing = false;
      task.speed = 0;
      removeSavedUpload(session.id);
      uploadTasksRef.current.delete(task.key);
      updateJob(task.key, { status: 'done', uploadedBytes: file.size, progress: 100, speed: 0, detail: 'Uploaded' });
      setNotice(file.name + ' uploaded');
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
        updateJob(task.key, { status: 'paused', speed: 0, detail: 'Paused in queue.' });
        continue;
      }
      activeUploadsRef.current.set(task.key, task);
      task.finalizing = false;
      task.lastProgressAt = performance.now();
      updateJob(task.key, { status: 'uploading', speed: 0, detail: 'Preparing transfer…' });
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
      detail: 'Waiting in queue…'
    });
    pumpUploadQueue();
  }

  function enqueueUpload(file: File, parentId: string | null, saved?: SavedUpload, existingKey?: string) {
    const key = existingKey || saved?.id || 'pending-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
    const now = performance.now();
    const task = uploadTasksRef.current.get(key) || {
      key,
      file,
      parentId: saved ? saved.parentId : parentId,
      session: saved || null,
      action: null,
      controller: null,
      finalizing: false,
      uploadedBytes: Math.min(file.size, Math.max(0, saved?.uploadedBytes || 0)),
      speed: 0,
      sampleAt: now,
      sampleBytes: Math.min(file.size, Math.max(0, saved?.uploadedBytes || 0)),
      lastProgressAt: now
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
        setError('Choose the same file that was selected for this upload to resume it.');
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
    updateJob(job.key, { speed: 0, detail: 'Pausing…' });
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
    task.sampleAt = performance.now();
    task.sampleBytes = 0;
    queueUploadTask(task);
  }

  async function cancelUpload(job: UploadJob) {
    const task = uploadTasksRef.current.get(job.key);
    if (task && activeUploadsRef.current.has(job.key)) {
      if (task.finalizing || task.action) return;
      task.action = 'cancel';
      updateJob(job.key, { speed: 0, detail: 'Cancelling…' });
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
      setNotice('Folder created');
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
      setError('The Photos folder cannot be renamed.');
      return;
    }
    try {
      await api.renameEntry(entry.id, name);
      setModal(null);
      setNotice('Name updated');
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
      setNotice('Item restored');
      setRefresh((value) => value + 1);
    } catch (cause) {
      setError(friendlyError(cause));
    }
  }

  async function revokeShare(share: ShareSummary) {
    if (!window.confirm('Revoke the public link for “' + share.resource_name + '”?')) return;
    try {
      await api.revokeShare(share.id);
      setNotice('Share link revoked');
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
    onLoggedOut();
  }

  const searchActive = section === 'drive' && (query.trim().length > 0 || filtersReady(route.filters, currentFolderId));
  const visibleRows = entries;
  const previewItems = visibleRows.filter((entry) => entry.kind === 'file' && isFilePreviewable(entry));
  const activeUploadJobs = jobs.filter((job) => job.status === 'uploading');
  const queuedUploadJobs = jobs.filter((job) => job.status === 'queued');
  const pausedUploadJobs = jobs.filter((job) => job.status === 'paused' || job.status === 'error');
  const completedUploadCount = jobs.filter((job) => job.status === 'done').length;
  const totalUploadSpeed = activeUploadJobs.reduce((total, job) => total + job.speed, 0);
  const sortValue = `${route.sort}:${route.order}`;
  const allTrashSelected = section === 'trash' && visibleRows.length > 0 && visibleRows.every((entry) => trashSelection.includes(entry.id));

  return (
    <div className="drive-app">
      <header className="app-topbar">
        <a className="brand-wordmark" href="/drive" aria-label="My Drive" onClick={(event) => {
          event.preventDefault();
          showDrive({ folders: [], panel: null, query: '', fileId: null });
        }}>
          <span className="brand-mark"><Folder size={18} fill="currentColor" strokeWidth={1.6} /></span>
          <span>MY DRIVE</span>
        </a>
        <label className={'global-search' + (section !== 'drive' ? ' search-disabled' : '')}>
          <Search size={19} />
          <input
            ref={searchInputRef}
            type="search"
            placeholder={section === 'drive' ? 'Search files and folders' : 'Search from My Drive'}
            value={query}
            disabled={section !== 'drive'}
            onChange={(event) => showDrive({ query: event.target.value, fileId: null }, 'replace')}
            aria-label="Search files and folders"
          />
          {query && section === 'drive' && <button className="clear-search" onClick={() => showDrive({ query: '', fileId: null }, 'replace')} aria-label="Clear search"><X size={15} /></button>}
          <kbd className="search-shortcut">{shortcutLabel}</kbd>
        </label>
        <details className="account-menu">
          <summary className="account-button" aria-label="Account menu">
            <span className="avatar"><CircleUserRound size={21} /></span>
            <span className="account-email">{user.email}</span>
            <ChevronDown size={15} />
          </summary>
          <div className="menu-popover account-popover">
            <span className="account-menu-email">{user.email}</span>
            <div className="menu-divider" />
            {user.role === 'owner' && (
              <>
                <button onClick={(event) => {
                  event.currentTarget.closest('details')?.removeAttribute('open');
                  showDrive({ folders: [], panel: 'accounts', query: '', fileId: null });
                }}><Users size={15} /> Manage accounts</button>
                <div className="menu-divider" />
              </>
            )}
            <button onClick={(event) => {
              event.currentTarget.closest('details')?.removeAttribute('open');
              showDrive({ folders: [], panel: 'security', query: '', fileId: null });
            }}><ShieldCheck size={15} /> Account security</button>
            <div className="menu-divider" />
            <button onClick={(event) => {
              event.currentTarget.closest('details')?.removeAttribute('open');
              navigate('storage');
            }}><Gauge size={15} /> Storage</button>
            <div className="menu-divider" />
            <button onClick={logout}><LogOut size={15} /> Sign out</button>
          </div>
        </details>
      </header>

      <div className="app-body">
        <aside className="side-nav" aria-label="Main navigation">
          <div className="nav-section-label">WORKSPACE</div>
          <button className={'nav-item' + (section === 'drive' ? ' active' : '')} onClick={() => navigate('drive')}>
            <HardDrive size={18} /><span>My Drive</span>
          </button>
          <button className={'nav-item' + (section === 'photos' ? ' active' : '')} onClick={() => navigate('photos')}>
            <Images size={18} /><span>Photos</span>
          </button>
          <button className={'nav-item' + (section === 'shared' ? ' active' : '')} onClick={() => navigate('shared')}>
            <Users size={18} /><span>Shared links</span>
          </button>
          <button className={'nav-item' + (section === 'trash' ? ' active' : '')} onClick={() => navigate('trash')}>
            <Trash2 size={18} /><span>Trash</span>
          </button>
          <button className={'nav-item' + (section === 'storage' ? ' active' : '')} onClick={() => navigate('storage')}>
            <Gauge size={18} /><span>Storage</span>
          </button>
          <button className={'nav-item' + (googleDriveOpen ? ' active' : '')} onClick={() => showDrive({ panel: googleDriveOpen ? null : 'google-drive' })}>
            <Cloud size={18} /><span>Google Drive</span>
          </button>
          <div className="sidebar-bottom">
            <QuotaCard />
            <div className="privacy-card">
              <span className="privacy-icon"><LockKeyhole size={16} /></span>
              <span><strong>Your drive is private</strong><small>Only you can access your files.</small></span>
            </div>
          </div>
        </aside>

        <main className="main-content">
          {section !== 'photos' && section !== 'storage' && (
          <section className="page-heading">
            <div className="heading-copy">
              <span className="eyebrow">{section === 'drive' ? 'YOUR FILES' : section === 'shared' ? 'LINK SETTINGS' : 'RECENTLY REMOVED'}</span>
              <h1>{activeSectionLabel}</h1>
              <p>
                {section === 'drive'
                  ? searchActive ? 'Results that match the current search and filters.' : 'Your files, organized in one place.'
                  : section === 'shared'
                    ? 'Create, review, and revoke the links you have shared.'
                    : 'Restore an item, or delete it permanently.'}
              </p>
            </div>
            {section === 'drive' && (
              <div className="heading-actions">
                {user.role === 'owner' ? (
                  <button
                    className="button button-secondary media-index-trigger"
                    type="button"
                    aria-expanded={mediaIndexOpen}
                    aria-controls={mediaIndexOpen ? 'media-index-panel' : undefined}
                    aria-label={mediaIndexOpen ? 'Hide media indexing controls' : 'Show media indexing controls'}
                    onClick={() => showDrive({ panel: mediaIndexOpen ? null : 'indexing' })}
                  >
                    <Activity size={16} /> <span>{mediaIndexOpen ? 'Hide indexing' : 'Media indexing'}</span>
                  </button>
                ) : null}
                {user.role === 'owner' ? (
                  <button
                    className="button button-secondary face-admin-trigger"
                    type="button"
                    aria-expanded={faceAdminOpen}
                    aria-controls={faceAdminOpen ? 'face-admin-panel' : undefined}
                    aria-label={faceAdminOpen ? 'Hide face group controls' : 'Show face group controls'}
                    onClick={() => showDrive({ panel: faceAdminOpen ? null : 'faces' })}
                  >
                    <ScanFace size={16} /> <span>{faceAdminOpen ? 'Hide faces' : 'Face groups'}</span>
                  </button>
                ) : null}
                <button className="button button-secondary" onClick={() => setModal({ kind: 'new-folder' })}>
                  <FolderPlus size={17} /> <span>New folder</span>
                </button>
                <button className="button button-primary" onClick={pickFiles}>
                  <Upload size={17} /> <span>Upload files</span>
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
                    if (window.confirm(`Permanently delete ${count} item${count === 1 ? '' : 's'}? This cannot be undone.`)) {
                      void purgeTrash({ ids: trashSelection }, 'Selected items deleted permanently');
                    }
                  }}
                >
                  <Trash2 size={16} /> <span>Delete permanently</span>
                </button>
                <button
                  className="button button-quiet-danger"
                  disabled={loading || entries.length === 0}
                  onClick={() => {
                    if (window.confirm('Empty trash? Every item in trash will be deleted permanently. This cannot be undone.')) {
                      void purgeTrash({ all: true }, 'Trash emptied');
                    }
                  }}
                >
                  Empty trash
                </button>
              </div>
            )}
          </section>
          )}

          {section === 'drive' && breadcrumbs.length > 0 && !searchActive && (
            <nav className="breadcrumb-nav" aria-label="Folder path">
              <button onClick={() => goToBreadcrumb(-1)}>My Drive</button>
              {breadcrumbs.map((crumb, index) => (
                <span className="breadcrumb-item" key={crumb.id}>
                  <ChevronRight size={14} className="breadcrumb-slash" />
                  <button onClick={() => goToBreadcrumb(index)} aria-current={index === breadcrumbs.length - 1 ? 'page' : undefined}>{crumb.name}</button>
                </span>
              ))}
            </nav>
          )}

          {section === 'drive' && securityOpen ? <AccountSecurityPanel user={user} onClose={() => showDrive({ panel: null })} /> : null}
          {section === 'drive' && googleDriveOpen ? <GoogleDrivePanel onClose={() => showDrive({ panel: null })} /> : null}
          {section === 'drive' ? (
            user.role === 'owner' ? (
              accountAdminOpen ? (
                <AccountManagementPanel onClose={() => showDrive({ panel: null })} />
              ) : faceAdminOpen ? (
                <FaceManagementPanel onClose={() => showDrive({ panel: null })} />
              ) : mediaIndexOpen ? <MediaIndexPanel onClose={() => showDrive({ panel: null })} /> : null
            ) : null
          ) : null}

          {error && <div className="notice notice-error" role="alert"><span>{error}</span><button onClick={() => setError('')} aria-label="Dismiss"><X size={16} /></button></div>}
          {notice && !error && <div className="notice notice-success" role="status"><Check size={16} /><span>{notice}</span><button onClick={() => setNotice('')} aria-label="Dismiss"><X size={16} /></button></div>}

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
          ) : section === 'shared' ? (
            <section className="share-manager">
              {loading ? (
                <div className="table-card"><div className="loading-rows"><span /><span /><span /></div></div>
              ) : shares.length ? (
                <div className="table-card share-table">
                  <div className="table-head share-grid"><span>Shared item</span><span>Access</span><span>Created</span><span>Expires</span><span>Status</span><span /></div>
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
                          <span>{share.password_protected ? <><LockKeyhole size={13} /> Password</> : 'Anyone with link'}</span>
                          <small>{share.allow_download ? 'Downloads on' : 'View only'}</small>
                          {share.max_downloads != null && <small>{share.download_count} / {share.max_downloads} downloads</small>}
                        </div>
                        <span className="entry-modified">{formatDate(share.created_at)}</span>
                        <span className="entry-modified">{formatDate(share.expires_at)}</span>
                        <span><span className={'status-pill ' + status.className}><i />{status.label}</span></span>
                        <span className="share-row-action">
                          {status.label === 'Active' && <button className="button button-quiet-danger" onClick={() => void revokeShare(share)}>Revoke</button>}
                        </span>
                      </div>
                    );
                  })}
                  {nextOffset != null && <button className="load-more" disabled={loadingMore} onClick={() => void loadMore()}>{loadingMore ? 'Loading…' : 'Load more links'}</button>}
                </div>
              ) : (
                <div className="empty-state share-empty">
                  <span className="empty-icon"><Share2 size={22} /></span>
                  <h2>No shared links yet</h2>
                  <p>Use the actions menu on a file or folder to create a private link.</p>
                  <button className="button button-secondary" onClick={() => navigate('drive')}>Go to My Drive</button>
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
                        aria-label="Select all items in trash"
                      />
                      <span>{trashSelection.length ? `${trashSelection.length} selected` : 'Select'}</span>
                    </label>
                  )}
                  <span>{searchActive ? 'Search results' : section === 'trash' ? 'Items in trash' : selectedIds.length ? `${selectedIds.length} selected` : 'Files'}</span>
                </div>
                <div className="explorer-toolbar-actions">
                  {section === 'drive' && (
                    <label className="sort-control">
                      <span className="visually-hidden">Sort</span>
                      <select value={sortValue} onChange={(event) => changeSort(event.target.value)}>
                        <option value="name:asc">Name</option>
                        <option value="name:desc">Name, Z–A</option>
                        <option value="updated_at:desc">Last modified</option>
                        <option value="created_at:desc">Date created</option>
                        <option value="size:desc">Largest first</option>
                        <option value="size:asc">Smallest first</option>
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
                      Select
                    </button>
                  )}
                  {section === 'drive' && (
                    <button
                      className={'button button-secondary filter-toggle' + (filtersOpen || hasActiveFilters(route.filters) ? ' is-active' : '')}
                      type="button"
                      aria-expanded={filtersOpen}
                      onClick={() => setFiltersOpen((open) => !open)}
                    >
                      <SlidersHorizontal size={15} /> <span>Filters</span>
                    </button>
                  )}
                  <div className="view-toggle" role="group" aria-label="View">
                    <button className={viewMode === 'list' ? 'active' : ''} type="button" aria-pressed={viewMode === 'list'} onClick={() => setViewMode('list')} aria-label="List view"><List size={16} /></button>
                    <button className={viewMode === 'grid' ? 'active' : ''} type="button" aria-pressed={viewMode === 'grid'} onClick={() => setViewMode('grid')} aria-label="Grid view"><LayoutGrid size={16} /></button>
                  </div>
                </div>
              </div>
              {section === 'drive' && filtersOpen && (
                <form className="filter-panel" onSubmit={(event) => event.preventDefault()}>
                  <label>Type
                    <select value={route.filters.category} onChange={(event) => patchFilters({ category: event.target.value })}>
                      <option value="">Any</option>
                      <option value="folder">Folders</option>
                      <option value="image">Images</option>
                      <option value="video">Videos</option>
                      <option value="audio">Audio</option>
                      <option value="document">Documents</option>
                      <option value="archive">Archives</option>
                      <option value="other">Other</option>
                    </select>
                  </label>
                  <label>MIME
                    <input value={route.filters.mime} placeholder="image/jpeg" onChange={(event) => patchFilters({ mime: event.target.value.trim() })} />
                  </label>
                  <label>Min MB
                    <input inputMode="decimal" value={route.filters.minSize} placeholder="0" onChange={(event) => patchFilters({ minSize: event.target.value })} />
                  </label>
                  <label>Max MB
                    <input inputMode="decimal" value={route.filters.maxSize} placeholder="Any" onChange={(event) => patchFilters({ maxSize: event.target.value })} />
                  </label>
                  <label>Created from
                    <input type="date" value={route.filters.createdFrom} onChange={(event) => patchFilters({ createdFrom: event.target.value })} />
                  </label>
                  <label>Created to
                    <input type="date" value={route.filters.createdTo} onChange={(event) => patchFilters({ createdTo: event.target.value })} />
                  </label>
                  <label>Modified from
                    <input type="date" value={route.filters.modifiedFrom} onChange={(event) => patchFilters({ modifiedFrom: event.target.value })} />
                  </label>
                  <label>Modified to
                    <input type="date" value={route.filters.modifiedTo} onChange={(event) => patchFilters({ modifiedTo: event.target.value })} />
                  </label>
                  {currentFolderId && (
                    <label className="filter-check">
                      <input type="checkbox" checked={route.filters.inFolder} onChange={(event) => patchFilters({ inFolder: event.target.checked })} />
                      Only this folder
                    </label>
                  )}
                  <button className="button button-secondary" type="button" onClick={() => showDrive({ filters: emptyFilters(), fileId: null }, 'replace')}>Clear</button>
                </form>
              )}
              <div className={viewMode === 'grid' && !loading && visibleRows.length ? 'entry-grid' : 'table-card drive-table'}>
                {viewMode === 'list' && (
                  <div className="list-toolbar">
                    <div className="list-toolbar-title"><span>Name</span></div>
                    <span className="list-toolbar-date">{section === 'trash' ? 'Removed' : 'Last modified'}</span>
                    <span className="list-toolbar-size">Size</span>
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
                    <button className="icon-button restore-button" onClick={() => void restoreEntry(entry)} aria-label={'Restore ' + entry.name} title="Restore"><RotateCcw size={17} /></button>
                  ) : (
                    <>
                      <button className="icon-button" onClick={() => setDetailsId(entry.id)} aria-label={'Details for ' + entry.name} title="Details"><Info size={16} /></button>
                      <EntryMenu label={'Actions for ' + entry.name} items={entryMenuItems(menuIds)} />
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
                        aria-label={'Select ' + entry.name}
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
                          {entry.kind === 'file' && mediaKindFor(entry) === 'video' && <span className="photo-badge">Video</span>}
                          {checkbox}
                        </button>
                        <div className="entry-card-meta">
                          <button className="entry-name" onClick={activate} disabled={section === 'trash'}>
                            {entry.name}
                            {isSystemFolder(entry) && <span className="system-badge">Photos</span>}
                          </button>
                          <span>{entrySize(entry)}{entry.kind === 'folder' && entry.folder_file_count != null ? ` · ${entry.folder_file_count} files` : ''}</span>
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
                          <button className="entry-name" onClick={activate}>{entry.name}{isSystemFolder(entry) && <span className="system-badge">Photos</span>}</button>
                        ) : entry.kind === 'file' && section !== 'trash' ? (
                          isFilePreviewable(entry) ? (
                            <button className="entry-name" onClick={activate}>{entry.name}</button>
                          ) : <a className="entry-name" href={downloadUrl(entry.id)} onClick={(event) => { const gesture = selectionGesture(event, selectionMode); if (gesture) { event.preventDefault(); chooseEntries(entry.id, gesture); } }}>{entry.name}</a>
                        ) : (
                          <span className="entry-name">{entry.name}</span>
                        )}
                        <span className="entry-mobile-meta">
                          {entry.kind === 'folder' ? (entry.folder_file_count != null ? `${entry.folder_file_count} files` : 'Folder') : formatSize(entry.size_bytes)}
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
                    <h2>{searchActive ? 'No matching files' : section === 'trash' ? 'Trash is empty' : 'This folder is empty'}</h2>
                    <p>{searchActive ? 'Try another search term.' : section === 'trash' ? 'Items you remove will appear here.' : 'Upload files or create a folder to get started.'}</p>
                    {!searchActive && section === 'drive' && (
                      <div className="empty-actions">
                        <button className="button button-secondary" onClick={() => setModal({ kind: 'new-folder' })}><FolderPlus size={16} /> New folder</button>
                        <button className="button button-primary" onClick={pickFiles}><Upload size={16} /> Upload files</button>
                      </div>
                    )}
                  </div>
                )}
                {!loading && visibleRows.length > 0 && nextOffset != null && (
                  <button className="load-more" disabled={loadingMore} onClick={() => void loadMore()}>
                    {loadingMore ? 'Loading…' : 'Load more'}
                  </button>
                )}
              </div>
            </section>
          )}
        </main>
      </div>

      <nav className="mobile-nav" aria-label="Main navigation">
        <button className={section === 'drive' ? 'active' : ''} onClick={() => navigate('drive')}><HardDrive size={19} /><span>Drive</span></button>
        <button className={section === 'photos' ? 'active' : ''} onClick={() => navigate('photos')}><Images size={19} /><span>Photos</span></button>
        <button className={section === 'shared' ? 'active' : ''} onClick={() => navigate('shared')}><Users size={19} /><span>Shared</span></button>
        <button className={section === 'trash' ? 'active' : ''} onClick={() => navigate('trash')}><Trash2 size={19} /><span>Trash</span></button>
      </nav>

      {jobs.length > 0 && (
        <aside className="upload-queue" aria-label="Upload queue">
          <div className="upload-queue-head">
            <button className="upload-queue-open" onClick={() => setUploadManagerOpen(true)} aria-haspopup="dialog">
              <span className="upload-queue-mark"><CloudUpload size={17} /></span>
              <span className="upload-queue-summary">
                <strong>Uploads</strong>
                <small>{activeUploadJobs.length} uploading · {queuedUploadJobs.length} queued</small>
              </span>
              <span className="upload-queue-speed">{formatSize(totalUploadSpeed)}/s</span>
              <ChevronDown size={16} />
            </button>
            <details className="queue-menu">
              <summary className="icon-button" aria-label="Upload queue actions"><MoreHorizontal size={17} /></summary>
              <div className="menu-popover">
                <button onClick={() => setJobs((items) => items.filter((job) => job.status !== 'done'))}>Clear completed</button>
              </div>
            </details>
          </div>
          <div className="upload-queue-items">
            {(activeUploadJobs.length ? activeUploadJobs : jobs.filter((job) => job.status !== 'done')).slice(0, 3).map((job) => (
              <div className="upload-job" key={job.key}>
                <span className="upload-job-icon"><Upload size={15} /></span>
                <div className="upload-job-content">
                  <div className="upload-job-title"><strong title={job.name}>{job.name}</strong><span>{job.status === 'uploading' ? Math.round(job.progress) + '%' : job.status === 'queued' ? 'Waiting' : job.status === 'paused' ? 'Paused' : 'Failed'}</span></div>
                  <div className="upload-progress"><i style={{ width: job.progress + '%' }} /></div>
                  <small>{formatSize(job.uploadedBytes)} / {formatSize(job.size)}{job.status === 'uploading' ? ' · ' + formatSize(job.speed) + '/s' : ''}</small>
                </div>
              </div>
            ))}
          </div>
        </aside>
      )}

      {uploadManagerOpen && (
        <div className="upload-manager-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setUploadManagerOpen(false); }}>
          <section className="upload-manager" role="dialog" aria-modal="true" aria-labelledby="upload-manager-title">
            <header className="upload-manager-header">
              <div>
                <span className="eyebrow">TRANSFER ACTIVITY</span>
                <h2 id="upload-manager-title">Upload manager</h2>
                <p>{activeUploadJobs.length} uploading · {queuedUploadJobs.length} queued · {formatSize(totalUploadSpeed)}/s total</p>
              </div>
              <div className="upload-manager-header-actions">
                <button className="upload-manager-clear" disabled={!completedUploadCount} onClick={() => setJobs((items) => items.filter((job) => job.status !== 'done'))}>Clear completed</button>
                <button className="icon-button" onClick={() => setUploadManagerOpen(false)} aria-label="Close upload manager"><X size={18} /></button>
              </div>
            </header>

            <div className="upload-manager-summary">
              <div><span>Files</span><strong>{jobs.length}</strong></div>
              <div><span>Uploading</span><strong>{activeUploadJobs.length} / {MAX_CONCURRENT_UPLOADS}</strong></div>
              <div><span>Waiting</span><strong>{queuedUploadJobs.length}</strong></div>
              <div><span>Paused / failed</span><strong>{pausedUploadJobs.length}</strong></div>
              <div><span>Completed</span><strong>{completedUploadCount}</strong></div>
            </div>

            <div className="upload-manager-list">
              {jobs.length === 0 && <p className="upload-manager-empty">No upload tasks.</p>}
              {jobs.map((job) => {
                const task = uploadTasksRef.current.get(job.key);
                const isFinishing = !!task?.finalizing;
                const isControlling = !!task?.action;
                const statusLabel = isFinishing ? 'Finishing' : job.status === 'uploading' ? 'Uploading' : job.status === 'queued' ? 'Waiting' : job.status === 'paused' ? 'Paused' : job.status === 'error' ? 'Failed' : 'Complete';
                const eta = job.status === 'uploading' && job.speed > 0 ? (job.size - job.uploadedBytes) / job.speed : null;
                return (
                  <article className="upload-manager-job" key={job.key}>
                    <div className="upload-manager-job-main">
                      <span className={'upload-job-icon' + (job.status === 'done' ? ' upload-complete-icon' : '')}>{job.status === 'done' ? <Check size={16} /> : <Upload size={15} />}</span>
                      <div className="upload-job-content">
                        <div className="upload-job-title"><strong title={job.name}>{job.name}</strong><span className={'upload-job-state upload-state-' + job.status}>{statusLabel}</span></div>
                        <div className="upload-progress" role="progressbar" aria-label={'Upload progress for ' + job.name} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(job.progress)}><i style={{ width: job.progress + '%' }} /></div>
                        <div className="upload-manager-job-stats">
                          <span>{formatSize(job.uploadedBytes)} / {formatSize(job.size)}</span>
                          <span>{job.status === 'uploading' ? formatSize(job.speed) + '/s' : '—'}</span>
                          <span>ETA {formatUploadEta(eta)}</span>
                        </div>
                        <small className="upload-manager-detail">{job.detail}</small>
                      </div>
                    </div>
                    <div className="upload-manager-job-actions">
                      {job.status === 'uploading' && !isFinishing && !isControlling && <button className="queue-action" onClick={() => pauseUpload(job)} aria-label={'Pause ' + job.name} title="Pause upload"><Pause size={16} /></button>}
                      {job.status === 'queued' && <button className="queue-action" onClick={() => void cancelUpload(job)} aria-label={'Cancel ' + job.name} title="Cancel upload"><X size={16} /></button>}
                      {job.status === 'paused' && <button className="queue-action" onClick={() => resumeUpload(job)} aria-label={'Resume ' + job.name} title="Resume upload"><Play size={16} /></button>}
                      {job.status === 'error' && <button className="queue-action" onClick={() => retryUpload(job)} aria-label={'Retry ' + job.name} title="Retry upload"><RotateCcw size={16} /></button>}
                      {(job.status === 'uploading' || job.status === 'paused' || job.status === 'error') && !isFinishing && !isControlling && <button className="queue-action" onClick={() => void cancelUpload(job)} aria-label={'Cancel ' + job.name} title="Cancel upload"><X size={16} /></button>}
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
          title={modal.action === 'copy' ? 'Copy items' : 'Move items'}
          description={modal.ids.length === 1 ? 'Choose where this item should go.' : `Choose where these ${modal.ids.length} items should go.`}
          confirmLabel={modal.action === 'copy' ? 'Copy here' : 'Move here'}
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
            <button className="modal-close icon-button" onClick={() => setModal(null)} aria-label="Close dialog"><X size={18} /></button>
            {modal.kind === 'new-folder' && (
              <>
                <span className="modal-icon"><FolderPlus size={19} /></span>
                <span className="eyebrow">ORGANIZE FILES</span>
                <h2 id="modal-title">Create a new folder</h2>
                <p className="modal-description">Choose a name for the folder in {activeSectionLabel}.</p>
                <form className="form-stack" onSubmit={(event) => void createFolder(event)}>
                  <label className="field-label" htmlFor="folder-name">Folder name</label>
                  <input autoFocus id="folder-name" name="name" className="text-input" maxLength={255} required placeholder="e.g. Project files" />
                  <div className="modal-actions"><button type="button" className="button button-secondary" onClick={() => setModal(null)}>Cancel</button><button type="submit" className="button button-primary">Create folder</button></div>
                </form>
              </>
            )}
            {modal.kind === 'rename' && (
              <>
                <span className="modal-icon">{extensionIcon(modal.entry)}</span>
                <span className="eyebrow">UPDATE ITEM</span>
                <h2 id="modal-title">Rename {modal.entry.kind}</h2>
                <p className="modal-description">The new name will be visible anywhere this item appears.</p>
                <form className="form-stack" onSubmit={(event) => void renameEntry(event, modal.entry)}>
                  <label className="field-label" htmlFor="rename-name">Name</label>
                  <input autoFocus id="rename-name" name="name" className="text-input" maxLength={255} required defaultValue={modal.entry.name} />
                  <div className="modal-actions"><button type="button" className="button button-secondary" onClick={() => setModal(null)}>Cancel</button><button type="submit" className="button button-primary">Save name</button></div>
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
            setNotice(shareTargets.length > 1 ? 'Share links created' : 'Share link created');
          }}
        />
      )}

      {section === 'drive' && selectedIds.length > 0 && (
        <div className="batch-bar" role="toolbar" aria-label="Selected items">
          <strong>{selectedIds.length} selected</strong>
          <button className="batch-action" type="button" onClick={() => downloadFiles(entries.filter((entry) => selectedIds.includes(entry.id) && entry.kind === 'file').map((entry) => entry.id))}><Download size={15} /> Download</button>
          <button className="batch-action" type="button" onClick={() => setShareTargets(shareSubjects(selectedIds))}><Share2 size={15} /> Share</button>
          <button className="batch-action" type="button" onClick={() => setModal({ kind: 'destination', action: 'move', ids: operableIds(selectedIds) })}><FolderInput size={15} /> Move</button>
          <button className="batch-action" type="button" onClick={() => setModal({ kind: 'destination', action: 'copy', ids: operableIds(selectedIds) })}><Copy size={15} /> Copy</button>
          <button className="batch-action" type="button" onClick={() => { const ids = operableIds(selectedIds); setClipboard({ mode: 'cut', ids }); setNotice(ids.length === 1 ? 'Ready to move 1 item.' : `Ready to move ${ids.length} items.`); }}><Scissors size={15} /> Cut</button>
          <button className="batch-action batch-danger" type="button" onClick={() => void trashEntries(selectedIds)}><Trash2 size={15} /> Trash</button>
          <button className="batch-action" type="button" onClick={() => { setSelectedIds([]); setSelectionMode(false); }}>Clear</button>
        </div>
      )}

      {contextMenu && section === 'drive' && (
        <ContextMenu
          point={{ x: contextMenu.x, y: contextMenu.y }}
          items={contextMenu.ids.length ? entryMenuItems(contextMenu.ids) : backgroundMenuItems()}
          label="Item actions"
          onClose={() => setContextMenu(null)}
        />
      )}

      {detailsId && (
        <aside className="details-drawer" aria-label="Item details">
          <header>
            <strong>Details</strong>
            <button className="icon-button" onClick={() => setDetailsId(null)} aria-label="Close details"><X size={16} /></button>
          </header>
          {!details ? (
            <p className="details-loading">Loading details…</p>
          ) : (
            <dl>
              <div><dt>Name</dt><dd>{details.name}</dd></div>
              <div><dt>Type</dt><dd>{details.mime_type || details.category}</dd></div>
              <div><dt>Size</dt><dd>{formatSize(details.size_bytes)}</dd></div>
              <div><dt>Created</dt><dd>{formatDate(details.created_at)}</dd></div>
              <div><dt>Modified</dt><dd>{formatDate(details.updated_at)}</dd></div>
              <div><dt>Location</dt><dd>{details.location}</dd></div>
              <div><dt>Index</dt><dd>{details.category}</dd></div>
              {details.media.width && details.media.height ? <div><dt>Dimensions</dt><dd>{details.media.width} × {details.media.height}</dd></div> : null}
              {details.folder && (
                <>
                  <div><dt>Folder size</dt><dd>{formatSize(details.folder.total_bytes)}</dd></div>
                  <div><dt>Files</dt><dd>{details.folder.file_count}</dd></div>
                  <div><dt>Subfolders</dt><dd>{details.folder.subfolder_count}</dd></div>
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
