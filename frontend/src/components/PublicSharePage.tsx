import { useEffect, useState, type FormEvent } from 'react';
import { ArrowLeft, ArrowRight, Download, File, FileImage, FileSpreadsheet, FileText, Folder, LockKeyhole, ShieldCheck } from 'lucide-react';
import { ApiError, api, publicDownloadUrl } from '../api';
import { formatDate, formatSize, friendlyError } from '../format';
import type { PublicEntry, PublicShareView } from '../types';

type Props = {
  token: string;
};

function PublicFileIcon({ entry }: { entry: PublicEntry }) {
  if (entry.kind === 'folder') return <Folder size={21} className="file-icon folder-icon" />;
  const name = entry.name.toLowerCase();
  if (/\.(png|jpe?g|gif|webp|svg)$/.test(name)) return <FileImage size={21} className="file-icon" />;
  if (/\.(pdf|docx?|txt|md|rtf)$/.test(name)) return <FileText size={21} className="file-icon document-icon" />;
  if (/\.(xlsx?|csv|numbers)$/.test(name)) return <FileSpreadsheet size={21} className="file-icon sheet-icon" />;
  return <File size={21} className="file-icon" />;
}

export default function PublicSharePage({ token }: Props) {
  const [view, setView] = useState<PublicShareView | null>(null);
  const [folderId, setFolderId] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);
  const [password, setPassword] = useState('');
  const [needsPassword, setNeedsPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  async function load(nextFolderId?: string) {
    setLoading(true);
    setError('');
    try {
      const result = await api.publicShare(token, nextFolderId);
      setView(result);
      setFolderId(nextFolderId);
      setNeedsPassword(false);
    } catch (cause) {
      if (cause instanceof ApiError && cause.code === 'password_required') {
        setNeedsPassword(true);
        setView(null);
      } else {
        setError(friendlyError(cause));
      }
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // A public URL has a fixed token for the lifetime of this page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  async function unlock(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      await api.unlockShare(token, password);
      setPassword('');
      await load();
    } catch (cause) {
      setError(friendlyError(cause));
    } finally {
      setSubmitting(false);
    }
  }

  const isFileShare = view?.resource.kind === 'file';
  const rows = isFileShare ? [view!.resource] : view?.entries || [];
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
                  <button className="back-link" onClick={() => {
                    if (view.breadcrumbs.length > 1) {
                      void load(view.breadcrumbs[view.breadcrumbs.length - 2].id);
                    } else {
                      void load();
                    }
                  }} disabled={!folderId}>
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
                {view.allow_download && isFileShare && (
                  <a className="button button-primary" href={publicDownloadUrl(token, view.resource.id)}>
                    <Download size={17} /> Download file
                  </a>
                )}
              </div>
              {!isFileShare && view.breadcrumbs.length > 1 && (
                <nav className="breadcrumb-nav" aria-label="Shared folder path">
                  {view.breadcrumbs.map((crumb, index) => (
                    <span className="breadcrumb-item" key={crumb.id}>
                      {index > 0 && <span className="breadcrumb-slash">/</span>}
                      <button onClick={() => void load(crumb.id)}>{crumb.name}</button>
                    </span>
                  ))}
                </nav>
              )}
              <div className="public-table">
                <div className="table-head public-grid">
                  <span>Name</span><span>Size</span><span>Modified</span><span />
                </div>
                {rows.map((entry) => (
                  <div className="table-row public-grid" key={entry.id}>
                    <div className="entry-main">
                      <PublicFileIcon entry={entry} />
                      {entry.kind === 'folder' ? (
                        <button className="entry-name" onClick={() => void load(entry.id)}>{entry.name}</button>
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
                {rows.length === 0 && !loading && (
                  <div className="empty-state compact-empty">
                    <span className="empty-icon"><Folder size={22} /></span>
                    <h2>This folder is empty</h2>
                    <p>There are no shared items in this folder yet.</p>
                  </div>
                )}
              </div>
              {!view.allow_download && <p className="download-note"><LockKeyhole size={14} /> Downloads are disabled for this link.</p>}
            </>
          )}
          {loading && !view && <div className="public-loading">Opening shared link…</div>}
          {error && !needsPassword && (
            <div className="public-error" role="alert">
              <h1>Link unavailable</h1>
              <p>{error}</p>
              <button className="button button-secondary" onClick={() => void load(folderId)}>Try again</button>
            </div>
          )}
        </section>
      )}
      <footer className="public-footer">Shared with My Drive <span>·</span> Your files stay private</footer>
    </main>
  );
}
