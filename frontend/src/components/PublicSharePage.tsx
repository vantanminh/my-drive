import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { ArrowLeft, ArrowRight, Download, File, FileImage, FileSpreadsheet, FileText, Film, Folder, LayoutGrid, List, LockKeyhole, Presentation, ShieldCheck } from 'lucide-react';
import { ApiError, api, publicDownloadUrl, publicPreviewUrl, publicThumbnailUrl } from '../api';
import { formatDate, formatSize, friendlyError } from '../format';
import { buildPublicPath, navigateTo, parsePublicRoute, useBrowserHref } from '../route';
import type { Breadcrumb, PublicEntry, PublicShareView } from '../types';
import FilePreviewer from './FilePreviewer';
import { isFilePreviewable, mediaKindFor } from './MediaViewer';
import PhotoMosaic from './PhotoMosaic';

type Props = {
  token: string;
};

function PublicFileIcon({ entry }: { entry: PublicEntry }) {
  if (entry.kind === 'folder') return <Folder size={21} className="file-icon folder-icon" />;
  const name = entry.name.toLowerCase();
  if (/\.(png|jpe?g|gif|webp|avif|bmp|ico|svg|tiff?|heic|heif)$/.test(name)) return <FileImage size={21} className="file-icon image-icon" />;
  if (/\.(mp4|m4v|webm|mov|qt|mkv|mk3d|avi|ogv|ogg|mpg|mpeg|mpe|ts|mts|m2ts|flv|wmv|asf|3gp|3g2)$/.test(name)) return <Film size={21} className="file-icon video-icon" />;
  if (/\.(pptx?)$/.test(name)) return <Presentation size={21} className="file-icon document-icon" />;
  if (/\.(pdf|docx?|txt|md|markdown|json|rtf)$/.test(name)) return <FileText size={21} className="file-icon document-icon" />;
  if (/\.(xlsx?|csv|numbers)$/.test(name)) return <FileSpreadsheet size={21} className="file-icon sheet-icon" />;
  return <File size={21} className="file-icon" />;
}

function isPreviewable(entry: PublicEntry): boolean {
  return entry.kind === 'file' && isFilePreviewable({ name: entry.name, mime_detected: null });
}

export default function PublicSharePage({ token }: Props) {
  const href = useBrowserHref();
  const route = useMemo(() => {
    const search = href.includes('?') ? href.slice(href.indexOf('?')) : '';
    const pathname = href.includes('?') ? href.slice(0, href.indexOf('?')) : href;
    return parsePublicRoute(pathname, search);
  }, [href]);
  const requestedFolderId = route && route.token === token ? route.folderIds.at(-1) : undefined;
  const [view, setView] = useState<PublicShareView | null>(null);
  const [loading, setLoading] = useState(true);
  const [password, setPassword] = useState('');
  const [needsPassword, setNeedsPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [viewer, setViewer] = useState<PublicEntry | null>(null);
  const [viewMode, setViewMode] = useState<'gallery' | 'list'>('gallery');
  const loadRequest = useRef(0);
  const autoOpened = useRef(false);

  async function load(nextFolderId?: string) {
    const requestId = ++loadRequest.current;
    setLoading(true);
    setError('');
    try {
      const result = await api.publicShare(token, nextFolderId);
      if (requestId !== loadRequest.current) return;
      setView(result);
      setNeedsPassword(false);
    } catch (cause) {
      if (requestId !== loadRequest.current) return;
      if (cause instanceof ApiError && cause.code === 'password_required') {
        setNeedsPassword(true);
        setView(null);
      } else {
        setError(friendlyError(cause));
      }
    } finally {
      if (requestId === loadRequest.current) setLoading(false);
    }
  }

  useEffect(() => {
    void load(requestedFolderId);
    // The token identifies the share; the folder id comes from the address bar.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, requestedFolderId]);

  useEffect(() => {
    if (!view) return;
    const currentId = view.current_folder;
    if (requestedFolderId && currentId !== requestedFolderId) return;
    if (!requestedFolderId && view.resource.kind === 'folder' && currentId && currentId !== view.resource.id) return;
    const nested = view.resource.kind === 'folder' ? view.breadcrumbs.slice(1) : [];
    const rows = view.resource.kind === 'file' ? [view.resource] : view.entries;
    const fileId = route?.fileId && rows.some((entry) => entry.id === route.fileId && entry.kind === 'file')
      ? route.fileId
      : null;
    navigateTo(buildPublicPath(token, nested, fileId), 'replace');
    document.title = (view.resource.kind === 'file'
      ? view.resource.name
      : view.breadcrumbs.at(-1)?.name || view.resource.name) + ' · Shared · My Drive';
  }, [requestedFolderId, route?.fileId, token, view]);

  useEffect(() => {
    if (!view || !route?.fileId) {
      setViewer(null);
      return;
    }
    const rows = view.resource.kind === 'file' ? [view.resource] : view.entries;
    const match = rows.find((entry) => entry.id === route.fileId && entry.kind === 'file');
    setViewer(match ?? null);
  }, [route?.fileId, view]);

  useEffect(() => {
    if (autoOpened.current || !view || view.resource.kind !== 'file') return;
    if (!isPreviewable(view.resource) || route?.fileId) return;
    autoOpened.current = true;
    navigateTo(buildPublicPath(token, [], view.resource.id), 'replace');
  }, [route?.fileId, token, view]);

  function openFolder(entry: PublicEntry) {
    const nested = view?.breadcrumbs.slice(1) ?? [];
    navigateTo(buildPublicPath(token, [...nested, { id: entry.id, name: entry.name }], null));
  }

  function openCrumb(index: number, crumbs: Breadcrumb[]) {
    navigateTo(buildPublicPath(token, crumbs.slice(1, index + 1), null));
  }

  async function unlock(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      await api.unlockShare(token, password);
      setPassword('');
      await load(requestedFolderId);
    } catch (cause) {
      setError(friendlyError(cause));
    } finally {
      setSubmitting(false);
    }
  }

  const isFileShare = view?.resource.kind === 'file';
  const rows = isFileShare ? [view!.resource] : view?.entries || [];
  const mediaRows = rows.filter((entry) => entry.kind === 'file' && mediaKindFor({ name: entry.name, mime_detected: null }));
  const otherRows = rows.filter((entry) => !mediaRows.some((item) => item.id === entry.id));
  const title = view
    ? isFileShare
      ? view.resource.name
      : view.breadcrumbs.length
        ? view.breadcrumbs[view.breadcrumbs.length - 1].name
        : view.resource.name
    : '';

  return (
    <main className="public-page">
      <header className="public-topbar">
        <a className="brand-wordmark" href="/" aria-label="My Drive home">MY DRIVE</a>
        <span className="public-topbar-label"><ShieldCheck size={15} /> Shared securely</span>
      </header>

      {needsPassword ? (
        <section className="password-card">
          <span className="password-mark"><LockKeyhole size={24} /></span>
          <span className="eyebrow">PRIVATE LINK</span>
          <h1>This link is password protected</h1>
          <p>Enter the password from the person who shared this link.</p>
          <form onSubmit={unlock} className="form-stack">
            <label className="field-label" htmlFor="share-password">Password</label>
            <input
              id="share-password"
              className="text-input"
              type="password"
              autoComplete="current-password"
              autoFocus
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="Enter password"
            />
            {error && <div className="inline-alert" role="alert">{error}</div>}
            <button className="button button-primary" type="submit" disabled={submitting}>
              {submitting ? 'Checking…' : 'Continue'}
              {!submitting && <ArrowRight size={17} />}
            </button>
          </form>
        </section>
      ) : (
        <section className="public-content">
          {view && (
            <>
              <div className="public-heading">
                <div>
                  <button className="back-link" onClick={() => openCrumb(Math.max(view.breadcrumbs.length - 2, 0), view.breadcrumbs)} disabled={view.breadcrumbs.length <= 1}>
                    <ArrowLeft size={16} /> Back to shared folder
                  </button>
                  <div className="public-title-line">
                    {view.resource.kind === 'folder' ? <Folder size={25} className="folder-icon" /> : <PublicFileIcon entry={view.resource} />}
                    <h1>{title}</h1>
                  </div>
                  <p className="public-subtitle">
                    {isFileShare ? 'Shared file' : 'Shared folder · ' + view.entries.length + (view.entries.length === 1 ? ' item' : ' items')}
                    {view.expires_at && <span> · Expires {formatDate(view.expires_at)}</span>}
                  </p>
                </div>
                <div className="heading-actions">
                  {!isFileShare && rows.length > 0 && (
                    <div className="view-toggle" role="group" aria-label="Shared view">
                      <button className={viewMode === 'gallery' ? 'active' : ''} type="button" aria-pressed={viewMode === 'gallery'} onClick={() => setViewMode('gallery')} aria-label="Gallery view"><LayoutGrid size={16} /></button>
                      <button className={viewMode === 'list' ? 'active' : ''} type="button" aria-pressed={viewMode === 'list'} onClick={() => setViewMode('list')} aria-label="List view"><List size={16} /></button>
                    </div>
                  )}
                  {view.allow_download && isFileShare && (
                    <a className="button button-primary" href={publicDownloadUrl(token, view.resource.id)}>
                      <Download size={17} /> Download file
                    </a>
                  )}
                </div>
              </div>
              {!isFileShare && view.breadcrumbs.length > 1 && (
                <nav className="breadcrumb-nav" aria-label="Shared folder path">
                  {view.breadcrumbs.map((crumb, index) => (
                    <span className="breadcrumb-item" key={crumb.id}>
                      {index > 0 && <span className="breadcrumb-slash">/</span>}
                      <button onClick={() => openCrumb(index, view.breadcrumbs)}>{crumb.name}</button>
                    </span>
                  ))}
                </nav>
              )}
              {viewMode === 'gallery' && mediaRows.length > 0 && (
                <PhotoMosaic
                  items={mediaRows.map((entry) => ({
                    id: entry.id,
                    name: entry.name,
                    src: publicThumbnailUrl(token, entry.id),
                    video: mediaKindFor({ name: entry.name, mime_detected: null }) === 'video'
                  }))}
                  onOpen={(id) => {
                    const nested = view.resource.kind === 'folder' ? view.breadcrumbs.slice(1) : [];
                    navigateTo(buildPublicPath(token, nested, id), 'replace');
                  }}
                />
              )}
              {(viewMode === 'list' ? rows : otherRows).length > 0 && (
              <div className="public-table">
                {viewMode === 'gallery' && otherRows.length > 0 && <h2 className="public-section-label">Folders and files</h2>}
                <div className="table-head public-grid">
                  <span>Name</span><span>Size</span><span>Modified</span><span />
                </div>
                {(viewMode === 'list' ? rows : otherRows).map((entry) => (
                  <div className="table-row public-grid" key={entry.id}>
                    <div className="entry-main">
                      {entry.kind === 'file' && mediaKindFor({ name: entry.name, mime_detected: null }) ? (
                        <img className="public-row-thumb" src={publicThumbnailUrl(token, entry.id)} alt="" />
                      ) : <PublicFileIcon entry={entry} />}
                      {entry.kind === 'folder' ? (
                        <button className="entry-name" onClick={() => openFolder(entry)}>{entry.name}</button>
                        ) : isPreviewable(entry) ? (
                          <button className="entry-name" onClick={() => navigateTo(buildPublicPath(token, view.breadcrumbs.slice(1), entry.id), 'replace')}>{entry.name}</button>
                        ) : (
                          <span className="entry-name">{entry.name}</span>
                        )}
                    </div>
                    <span className="entry-size">{entry.kind === 'folder' ? '—' : formatSize(entry.size_bytes)}</span>
                    <span className="entry-modified">{formatDate(entry.updated_at)}</span>
                    <span className="public-download-cell">
                      {entry.kind === 'file' && view.allow_download && (
                        <a className="icon-button" href={publicDownloadUrl(token, entry.id)} aria-label={'Download ' + entry.name}>
                          <Download size={17} />
                        </a>
                      )}
                    </span>
                  </div>
                ))}
              </div>
              )}
              {rows.length === 0 && !loading && (
                <div className="empty-state compact-empty">
                  <span className="empty-icon"><Folder size={22} /></span>
                  <h2>This folder is empty</h2>
                  <p>There are no shared items in this folder yet.</p>
                </div>
              )}
              {!view.allow_download && <p className="download-note"><LockKeyhole size={14} /> Downloads are disabled for this link.</p>}
            </>
          )}
          {loading && !view && <div className="public-loading">Opening shared link…</div>}
          {error && !needsPassword && (
            <div className="public-error" role="alert">
              <h1>Link unavailable</h1>
              <p>{error}</p>
              <button className="button button-secondary" onClick={() => void load(requestedFolderId)}>Try again</button>
            </div>
          )}
        </section>
      )}
      <footer className="public-footer">Shared with My Drive <span>·</span> Your files stay private</footer>
      {viewer && (
        <FilePreviewer
          items={rows.filter(isPreviewable).map((entry) => ({ ...entry, mime_detected: null }))}
          index={Math.max(rows.filter(isPreviewable).findIndex((entry) => entry.id === viewer.id), 0)}
          onIndexChange={(next) => {
            const item = rows.filter(isPreviewable)[next];
            if (!item || !view) return;
            const nested = view.resource.kind === 'folder' ? view.breadcrumbs.slice(1) : [];
            navigateTo(buildPublicPath(token, nested, item.id), 'replace');
          }}
          onClose={() => navigateTo(buildPublicPath(token, view?.breadcrumbs.slice(1) ?? [], null), 'replace')}
          sourceFor={(item) => ({
            preview: publicPreviewUrl(token, item.id),
            thumbnail: publicThumbnailUrl(token, item.id),
            ...(view?.allow_download ? { download: publicDownloadUrl(token, item.id) } : {})
          })}
          showDownload={view?.allow_download ?? false}
        />
      )}
    </main>
  );
}
