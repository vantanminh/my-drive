import { useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent, type MouseEvent } from 'react';
import {
  Activity, Check, ChevronDown, ChevronRight, CircleUserRound, CloudUpload, Download, Eye, File, FileImage,
  FileSpreadsheet, FileText, Folder, FolderPlus, HardDrive, LockKeyhole, LogOut, MoreHorizontal,
  Pause, Play, RotateCcw, Search, Share2, Trash2, Upload, Users, X
} from 'lucide-react';
import { ApiError, api, downloadUrl, thumbnailUrl, type MediaIndexJob, type MediaIndexStatus } from '../api';
import { formatDate, formatSize, friendlyError } from '../format';
import type { Entry, EntryPage, ShareSummary, User } from '../types';
import ShareDialog from './ShareDialog';
import MediaViewer, { mediaKindFor } from './MediaViewer';
import AccountManagementPanel from './AccountManagementPanel';

type Props = {
  user: User;
  onLoggedOut: () => void;
};

type Section = 'drive' | 'shared' | 'trash';
type Breadcrumb = { id: string; name: string };
type Modal =
  | { kind: 'new-folder' }
  | { kind: 'rename'; entry: Entry }
  | { kind: 'move'; entry: Entry }
  | null;

type SavedUpload = {
  schema: 1;
  id: string;
  name: string;
  size: number;
  lastModified: number;
  parentId: string | null;
  createdAt: number;
};

type UploadStatus = 'queued' | 'uploading' | 'paused' | 'done' | 'error';
type UploadJob = {
  key: string;
  uploadId: string | null;
  name: string;
  size: number;
  progress: number;
  status: UploadStatus;
  detail: string;
  saved?: SavedUpload;
};

const RESUME_KEY = 'my-drive.upload-sessions.v1';
const CHUNK_SIZE = 8 * 1024 * 1024;

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

function extensionIcon(entry: Pick<Entry, 'kind' | 'name'>) {
  if (entry.kind === 'folder') return <Folder size={20} strokeWidth={1.8} className="file-icon folder-icon" />;
  const name = entry.name.toLowerCase();
  if (/\.(png|jpe?g|gif|webp|svg)$/.test(name)) return <FileImage size={20} strokeWidth={1.8} className="file-icon image-icon" />;
  if (/\.(pdf|docx?|txt|md|rtf)$/.test(name)) return <FileText size={20} strokeWidth={1.8} className="file-icon document-icon" />;
  if (/\.(xlsx?|csv|numbers)$/.test(name)) return <FileSpreadsheet size={20} strokeWidth={1.8} className="file-icon sheet-icon" />;
  return <File size={20} strokeWidth={1.8} className="file-icon" />;
}

const INDEXED_THUMBNAIL_MIMES = new Set([
  'image/jpeg', 'image/png', 'image/webp',
  'video/mp4', 'video/webm'
]);

function hasIndexedCardPreview(entry: Entry): boolean {
  if (entry.mime_detected) return INDEXED_THUMBNAIL_MIMES.has(entry.mime_detected);
  return /\.(jpe?g|png|webp|mp4|m4v|webm)$/i.test(entry.name);
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
    publishing_viewer: 'Saving image viewer preview',
    publishing_card: 'Saving image card preview',
    publishing_video_poster: 'Saving video poster'
  };
  return stage ? labels[stage] || 'Processing media' : 'Starting';
}

function mediaFailureLabel(code: string | null): string {
  const labels: Record<string, string> = {
    unsupported_format: 'This media format is not supported for previews.',
    decode_failed: 'The media could not be decoded.',
    input_missing: 'The original file is unavailable.',
    resource_limit: 'The media exceeds preview processing limits.',
    preview_storage_unavailable: 'Preview storage is unavailable.',
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

          <div className="media-index-active" aria-live="polite">
            <Activity size={16} />
            {activeJob ? (
              <span><strong>{activeJob.fileName}</strong> · {mediaStageLabel(activeJob.currentStage)} · {formatSize(activeJob.processedBytes)} / {formatSize(activeJob.totalBytes)}</span>
            ) : <span>No media preview job is running right now.</span>}
          </div>

          <div className="media-index-failures">
            <div className="media-index-subhead"><strong>Recent failures</strong><span>{counts?.failed ?? 0} total</span></div>
            {visibleFailures.length ? (
              <ul>
                {visibleFailures.map((job) => (
                  <li key={job.id}>
                    <div><strong title={job.fileName}>{job.fileName}</strong><span>{mediaFailureLabel(job.errorCode)}</span></div>
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

function EntryMenu({
  entry,
  section,
  currentFolderId,
  onOpen,
  onPreview,
  onDownload,
  onShare,
  onRename,
  onMove,
  onMoveHere,
  onMoveToRoot,
  onTrash
}: {
  entry: Entry;
  section: Section;
  currentFolderId: string | null;
  onOpen: () => void;
  onPreview: () => void;
  onDownload: () => void;
  onShare: () => void;
  onRename: () => void;
  onMove: () => void;
  onMoveHere: () => void;
  onMoveToRoot: () => void;
  onTrash: () => void;
}) {
  function closeMenu(event: MouseEvent<HTMLButtonElement>) {
    event.currentTarget.closest('details')?.removeAttribute('open');
  }

  if (section === 'trash') {
    return <span className="trash-hint">In trash</span>;
  }

  return (
    <details className="row-menu">
      <summary className="icon-button" aria-label={'Actions for ' + entry.name}>
        <MoreHorizontal size={18} />
      </summary>
      <div className="menu-popover">
        {entry.kind === 'folder' ? (
          <button onClick={(event) => { closeMenu(event); onOpen(); }}><Folder size={15} /> Open folder</button>
        ) : (
          <>
            {mediaKindFor(entry) && <button onClick={(event) => { closeMenu(event); onPreview(); }}><Eye size={15} /> Preview</button>}
            <button onClick={(event) => { closeMenu(event); onDownload(); }}><Download size={15} /> Download</button>
          </>
        )}
        <button onClick={(event) => { closeMenu(event); onShare(); }}><Share2 size={15} /> Create share link</button>
        <div className="menu-divider" />
        <button onClick={(event) => { closeMenu(event); onRename(); }}>Rename</button>
        <button onClick={(event) => { closeMenu(event); onMove(); }}>Move to…</button>
        <button disabled={!currentFolderId || entry.parent_id === currentFolderId} onClick={(event) => { closeMenu(event); onMoveHere(); }}>
          Move to this folder
        </button>
        <button disabled={entry.parent_id === null} onClick={(event) => { closeMenu(event); onMoveToRoot(); }}>Move to My Drive</button>
        <div className="menu-divider" />
        <button className="menu-danger" onClick={(event) => { closeMenu(event); onTrash(); }}><Trash2 size={15} /> Move to trash</button>
      </div>
    </details>
  );
}

export default function DriveApp({ user, onLoggedOut }: Props) {
  const [section, setSection] = useState<Section>('drive');
  const [breadcrumbs, setBreadcrumbs] = useState<Breadcrumb[]>([]);
  const currentFolderId = breadcrumbs.length ? breadcrumbs[breadcrumbs.length - 1].id : null;
  const [query, setQuery] = useState('');
  const [entries, setEntries] = useState<Entry[]>([]);
  const [shares, setShares] = useState<ShareSummary[]>([]);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [modal, setModal] = useState<Modal>(null);
  const [shareTarget, setShareTarget] = useState<Entry | null>(null);
  const [viewer, setViewer] = useState<Entry | null>(null);
  const [mediaIndexOpen, setMediaIndexOpen] = useState(false);
  const [accountAdminOpen, setAccountAdminOpen] = useState(false);
  const [shareRefresh, setShareRefresh] = useState(0);
  const [jobs, setJobs] = useState<UploadJob[]>(() =>
    readSavedUploads().map((saved) => ({
      key: saved.id,
      uploadId: saved.id,
      name: saved.name,
      size: saved.size,
      progress: 0,
      status: 'paused',
      detail: 'Choose this file again to resume.',
      saved
    }))
  );
  const [resumeTargetId, setResumeTargetId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const shortcutLabel = navigator.platform.toLowerCase().includes('mac') ? '⌘ K' : 'Ctrl K';
  const activeSectionLabel = section === 'drive'
    ? (currentFolderId ? breadcrumbs[breadcrumbs.length - 1].name : 'My Drive')
    : section === 'shared' ? 'Shared links' : 'Trash';

  useEffect(() => {
    function onKeyboardShortcut(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k' && section === 'drive') {
        event.preventDefault();
        searchInputRef.current?.focus();
      }
      if (event.key === 'Escape') {
        setModal(null);
        setShareTarget(null);
        setViewer(null);
        document.querySelectorAll('details[open]').forEach((element) => element.removeAttribute('open'));
      }
    }
    window.addEventListener('keydown', onKeyboardShortcut);
    return () => window.removeEventListener('keydown', onKeyboardShortcut);
  }, [section]);

  useEffect(() => {
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
      const load = section === 'trash'
        ? api.listTrash(controller.signal)
        : query.trim()
          ? api.search(query.trim(), controller.signal)
          : api.listDrive(currentFolderId, controller.signal);
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
    }, section === 'drive' && query.trim() ? 180 : 0);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [section, currentFolderId, query, refresh, shareRefresh, onLoggedOut]);

  const folderOptions = useMemo(() => {
    const options: Array<{ id: string | null; name: string }> = [{ id: null, name: 'My Drive' }];
    breadcrumbs.forEach((crumb, index) => options.push({
      id: crumb.id,
      name: ['My Drive', ...breadcrumbs.slice(0, index + 1).map((item) => item.name)].join(' / ')
    }));
    entries.filter((entry) => entry.kind === 'folder').forEach((entry) => {
      if (!options.some((option) => option.id === entry.id)) {
        options.push({
          id: entry.id,
          name: ['My Drive', ...breadcrumbs.map((item) => item.name), entry.name].join(' / ')
        });
      }
    });
    return options;
  }, [breadcrumbs, entries]);

  function navigate(sectionValue: Section) {
    setSection(sectionValue);
    setQuery('');
    if (sectionValue !== 'drive') setBreadcrumbs([]);
    setError('');
    setNotice('');
  }

  async function openFolder(entry: Entry) {
    try {
      if (!query.trim()) {
        setBreadcrumbs((path) => [...path, { id: entry.id, name: entry.name }]);
      } else {
        const chain: Breadcrumb[] = [];
        let current: Entry | null = entry;
        while (current && chain.length < 100) {
          chain.unshift({ id: current.id, name: current.name });
          current = current.parent_id ? await api.getEntry(current.parent_id) : null;
        }
        setBreadcrumbs(chain);
      }
      setSection('drive');
      setQuery('');
      setNotice('');
    } catch (cause) {
      setError(friendlyError(cause));
    }
  }

  function goToBreadcrumb(index: number) {
    setBreadcrumbs(index < 0 ? [] : breadcrumbs.slice(0, index + 1));
    setSection('drive');
    setQuery('');
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
        progress: 0,
        status: 'queued',
        detail: '',
        ...update
      }];
    });
  }

  async function moveTo(entry: Entry, targetId: string | null) {
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

  async function runUpload(file: File, saved?: SavedUpload, existingKey?: string) {
    const key = existingKey || saved?.id || 'pending-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
    setError('');
    updateJob(key, { key, uploadId: saved?.id || null, name: file.name, size: file.size, progress: 0, status: 'queued', detail: 'Waiting to upload…' });
    let session = saved;
    try {
      if (!session) {
        const created = await api.createUpload(file.name, file.size, currentFolderId);
        session = {
          schema: 1,
          id: created.id,
          name: file.name,
          size: file.size,
          lastModified: file.lastModified,
          parentId: currentFolderId,
          createdAt: Date.now()
        };
        const savedUploads = readSavedUploads().filter((item) => item.id !== session!.id);
        savedUploads.push(session);
        writeSavedUploads(savedUploads);
        updateJob(key, { uploadId: session.id, saved: session });
      }
      updateJob(key, { status: 'uploading', detail: 'Preparing transfer…' });
      let server = await api.uploadHead(session.id);
      let offset = Math.min(server.offset, file.size);
      updateJob(key, { progress: file.size ? (offset / file.size) * 100 : 100 });
      while (offset < file.size) {
        const end = Math.min(offset + CHUNK_SIZE, file.size);
        const chunk = file.slice(offset, end);
        try {
          await api.uploadChunk(session.id, offset, chunk);
          offset = end;
        } catch (cause) {
          if (cause instanceof ApiError && cause.status === 409 && cause.code === 'offset_mismatch') {
            server = await api.uploadHead(session.id);
            if (server.offset === offset) throw cause;
            offset = Math.min(server.offset, file.size);
            continue;
          }
          throw cause;
        }
        updateJob(key, {
          progress: file.size ? (offset / file.size) * 100 : 100,
          detail: 'Uploading…'
        });
      }
      updateJob(key, { detail: 'Finishing upload…' });
      await api.finalizeUpload(session.id);
      writeSavedUploads(readSavedUploads().filter((item) => item.id !== session!.id));
      updateJob(key, { status: 'done', progress: 100, detail: 'Uploaded' });
      setError('');
      setNotice(file.name + ' uploaded');
      setRefresh((value) => value + 1);
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) {
        onLoggedOut();
        return;
      }
      const resumable = !!session && !(cause instanceof ApiError && ['upload_closed', 'not_found'].includes(cause.code));
      updateJob(key, {
        uploadId: session?.id || null,
        saved: session,
        status: resumable ? 'paused' : 'error',
        detail: friendlyError(cause)
      });
      setError(friendlyError(cause));
    }
  }

  async function chooseFiles(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files || []);
    event.target.value = '';
    if (!files.length) return;
    const parentId = currentFolderId;
    if (resumeTargetId) {
      const saved = readSavedUploads().find((item) => item.id === resumeTargetId);
      setResumeTargetId(null);
      const file = saved && files.find((candidate) => fileMatches(candidate, saved, saved.parentId));
      if (!saved || !file) {
        setError('Choose the same file that was selected for this upload to resume it.');
        return;
      }
      await runUpload(file, saved, saved.id);
      return;
    }
    for (const file of files) {
      const saved = readSavedUploads().find((item) => fileMatches(file, item, parentId));
      await runUpload(file, saved);
    }
  }

  function pickFiles() {
    setResumeTargetId(null);
    fileInputRef.current?.click();
  }

  function resumeUpload(job: UploadJob) {
    setResumeTargetId(job.uploadId);
    fileInputRef.current?.click();
  }

  async function cancelUpload(job: UploadJob) {
    try {
      if (job.uploadId) {
        try {
          await api.cancelUpload(job.uploadId);
        } catch (cause) {
          if (!(cause instanceof ApiError) || !['upload_closed', 'not_found'].includes(cause.code)) throw cause;
        }
      }
      writeSavedUploads(readSavedUploads().filter((item) => item.id !== job.uploadId));
      setJobs((items) => items.filter((item) => item.key !== job.key));
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
    try {
      await api.renameEntry(entry.id, name);
      setModal(null);
      setNotice('Name updated');
      setRefresh((value) => value + 1);
    } catch (cause) {
      setError(friendlyError(cause));
    }
  }

  async function moveEntry(event: FormEvent<HTMLFormElement>, entry: Entry) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const target = String(data.get('parent_id') || '');
    if (target === entry.id) {
      setError('An item cannot be moved into itself.');
      return;
    }
    const moved = await moveTo(entry, target || null);
    if (moved) setModal(null);
  }

  async function trashEntry(entry: Entry) {
    if (!window.confirm('Move “' + entry.name + '” to trash?')) return;
    try {
      await api.trashEntry(entry.id);
      setNotice('Moved to trash');
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
        const page: EntryPage = section === 'trash'
          ? await api.listTrash(undefined, nextOffset)
          : query.trim()
            ? await api.search(query.trim(), undefined, nextOffset)
            : await api.listDrive(currentFolderId, undefined, nextOffset);
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

  const searchActive = section === 'drive' && query.trim().length > 0;
  const visibleRows = entries;
  const pendingJobs = jobs.filter((job) => job.status !== 'done');

  return (
    <div className="drive-app">
      <header className="app-topbar">
        <a className="brand-wordmark" href="/" aria-label="My Drive">
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
            onChange={(event) => setQuery(event.target.value)}
            aria-label="Search files and folders"
          />
          {query && section === 'drive' && <button className="clear-search" onClick={() => setQuery('')} aria-label="Clear search"><X size={15} /></button>}
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
                  setSection('drive');
                  setBreadcrumbs([]);
                  setQuery('');
                  setMediaIndexOpen(false);
                  setAccountAdminOpen(true);
                }}><Users size={15} /> Manage accounts</button>
                <div className="menu-divider" />
              </>
            )}
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
          <button className={'nav-item' + (section === 'shared' ? ' active' : '')} onClick={() => navigate('shared')}>
            <Users size={18} /><span>Shared links</span>
          </button>
          <button className={'nav-item' + (section === 'trash' ? ' active' : '')} onClick={() => navigate('trash')}>
            <Trash2 size={18} /><span>Trash</span>
          </button>
          <div className="sidebar-bottom">
            <div className="privacy-card">
              <span className="privacy-icon"><LockKeyhole size={16} /></span>
              <span><strong>Your drive is private</strong><small>Only you can access your files.</small></span>
            </div>
          </div>
        </aside>

        <main className="main-content">
          <section className="page-heading">
            <div className="heading-copy">
              <span className="eyebrow">{section === 'drive' ? 'YOUR FILES' : section === 'shared' ? 'LINK SETTINGS' : 'RECENTLY REMOVED'}</span>
              <h1>{section === 'drive' ? activeSectionLabel : activeSectionLabel}</h1>
              <p>
                {section === 'drive'
                  ? searchActive ? 'Search results in your private drive.' : 'Your files, organized in one place.'
                  : section === 'shared'
                    ? 'Create, review, and revoke the links you have shared.'
                    : 'Restore an item to return it to your drive.'}
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
                    onClick={() => {
                      setAccountAdminOpen(false);
                      setMediaIndexOpen((open) => !open);
                    }}
                  >
                    <Activity size={16} /> <span>{mediaIndexOpen ? 'Hide indexing' : 'Image indexing'}</span>
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
          </section>

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

          {section === 'drive' ? (
            user.role === 'owner' ? (
              accountAdminOpen ? (
                <AccountManagementPanel onClose={() => setAccountAdminOpen(false)} />
              ) : mediaIndexOpen ? <MediaIndexPanel onClose={() => setMediaIndexOpen(false)} /> : null
            ) : null
          ) : null}

          {error && <div className="notice notice-error" role="alert"><span>{error}</span><button onClick={() => setError('')} aria-label="Dismiss"><X size={16} /></button></div>}
          {notice && !error && <div className="notice notice-success" role="status"><Check size={16} /><span>{notice}</span><button onClick={() => setNotice('')} aria-label="Dismiss"><X size={16} /></button></div>}

          {section === 'shared' ? (
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
            <section className="drive-list-section">
              <div className="list-toolbar">
                <div className="list-toolbar-title">
                  <span>{searchActive ? 'Search results' : section === 'trash' ? 'Items in trash' : 'Name'}</span>
                  {section === 'drive' && !searchActive && <span className="sort-mark">A–Z</span>}
                </div>
                <span className="list-toolbar-date">{section === 'trash' ? 'Removed' : 'Last modified'}</span>
                <span className="list-toolbar-size">Size</span>
                <span className="list-toolbar-menu" />
              </div>
              <div className="table-card drive-table">
                {loading ? (
                  <div className="loading-rows"><span /><span /><span /><span /></div>
                ) : visibleRows.length ? visibleRows.map((entry) => (
                  <div className="table-row drive-grid" key={entry.id}>
                    <div className="entry-main">
                      <EntryVisual entry={entry} showThumbnail={section !== 'trash'} />
                      <div className="entry-name-wrap">
                        {entry.kind === 'folder' && section !== 'trash' ? (
                          <button className="entry-name" onClick={() => void openFolder(entry)}>{entry.name}</button>
                        ) : entry.kind === 'file' && section !== 'trash' ? (
                          mediaKindFor(entry) ? (
                            <button className="entry-name" onClick={() => setViewer(entry)}>{entry.name}</button>
                          ) : <a className="entry-name" href={downloadUrl(entry.id)}>{entry.name}</a>
                        ) : (
                          <span className="entry-name">{entry.name}</span>
                        )}
                        <span className="entry-mobile-meta">
                          {entry.kind === 'folder' ? 'Folder' : formatSize(entry.size_bytes)}
                          <span>·</span>{formatDate(section === 'trash' ? entry.deleted_at : entry.updated_at)}
                        </span>
                      </div>
                    </div>
                    <span className="entry-modified">{formatDate(section === 'trash' ? entry.deleted_at : entry.updated_at)}</span>
                    <span className="entry-size">{entry.kind === 'folder' ? '—' : formatSize(entry.size_bytes)}</span>
                    <span className="entry-action">
                      {section === 'trash' ? (
                        <button className="icon-button restore-button" onClick={() => void restoreEntry(entry)} aria-label={'Restore ' + entry.name} title="Restore">
                          <RotateCcw size={17} />
                        </button>
                      ) : (
                        <EntryMenu
                          entry={entry}
                          section={section}
                          currentFolderId={currentFolderId}
                          onOpen={() => void openFolder(entry)}
                          onPreview={() => setViewer(entry)}
                          onDownload={() => window.location.assign(downloadUrl(entry.id))}
                          onShare={() => setShareTarget(entry)}
                          onRename={() => setModal({ kind: 'rename', entry })}
                          onMove={() => setModal({ kind: 'move', entry })}
                          onMoveHere={() => void moveTo(entry, currentFolderId)}
                          onMoveToRoot={() => void moveTo(entry, null)}
                          onTrash={() => void trashEntry(entry)}
                        />
                      )}
                    </span>
                  </div>
                )) : (
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
        <button className={section === 'shared' ? 'active' : ''} onClick={() => navigate('shared')}><Users size={19} /><span>Shared</span></button>
        <button className={section === 'trash' ? 'active' : ''} onClick={() => navigate('trash')}><Trash2 size={19} /><span>Trash</span></button>
      </nav>

      {jobs.length > 0 && (
        <aside className="upload-queue" aria-label="Upload queue">
          <div className="upload-queue-head">
            <span><CloudUpload size={17} /> Uploads ({pendingJobs.length})</span>
            <details className="queue-menu">
              <summary className="icon-button" aria-label="Upload queue actions"><MoreHorizontal size={17} /></summary>
              <div className="menu-popover">
                <button onClick={() => setJobs((items) => items.filter((job) => job.status !== 'done'))}>Clear completed</button>
              </div>
            </details>
          </div>
          <div className="upload-queue-items">
            {jobs.slice(-4).map((job) => (
              <div className="upload-job" key={job.key}>
                <span className={'upload-job-icon' + (job.status === 'done' ? ' upload-complete-icon' : '')}>{job.status === 'done' ? <Check size={16} /> : <Upload size={16} />}</span>
                <div className="upload-job-content">
                  <div className="upload-job-title"><strong title={job.name}>{job.name}</strong><span>{job.status === 'uploading' ? Math.round(job.progress) + '%' : job.status === 'done' ? 'Done' : job.status === 'queued' ? 'Waiting' : job.status === 'paused' ? 'Paused' : 'Failed'}</span></div>
                  <div className="upload-progress"><i style={{ width: job.progress + '%' }} /></div>
                  <small>{job.detail}</small>
                </div>
                {job.status === 'paused' && job.uploadId && <button className="queue-action" onClick={() => resumeUpload(job)} title="Resume upload"><RotateCcw size={15} /></button>}
                {(job.status === 'paused' || job.status === 'error') && <button className="queue-action" onClick={() => void cancelUpload(job)} title="Remove upload"><X size={15} /></button>}
              </div>
            ))}
          </div>
        </aside>
      )}

      {modal && (
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
            {modal.kind === 'move' && (
              <>
                <span className="modal-icon"><Folder size={19} /></span>
                <span className="eyebrow">ORGANIZE FILES</span>
                <h2 id="modal-title">Move “{modal.entry.name}”</h2>
                <p className="modal-description">Choose a destination folder.</p>
                <form className="form-stack" onSubmit={(event) => void moveEntry(event, modal.entry)}>
                  <label className="field-label" htmlFor="move-parent">Move to</label>
                  <select id="move-parent" name="parent_id" className="text-input select-input" defaultValue={currentFolderId || ''}>
                    {folderOptions.filter((option) => option.id !== modal.entry.id).map((option) => (
                      <option key={option.id || 'root'} value={option.id || ''}>{option.name}</option>
                    ))}
                  </select>
                  <div className="modal-actions"><button type="button" className="button button-secondary" onClick={() => setModal(null)}>Cancel</button><button type="submit" className="button button-primary">Move item</button></div>
                </form>
              </>
            )}
          </section>
        </div>
      )}

      {shareTarget && (
        <ShareDialog
          entry={shareTarget}
          onClose={() => setShareTarget(null)}
          onCreated={() => {
            setShareRefresh((value) => value + 1);
            setNotice('Share link created');
          }}
        />
      )}

      {viewer && <MediaViewer entry={viewer} onClose={() => setViewer(null)} />}
    </div>
  );
}
