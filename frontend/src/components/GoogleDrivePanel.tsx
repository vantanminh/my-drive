import { useEffect, useState } from 'react';
import { Cloud, Folder, Pause, Play, RefreshCw, Unlink, X } from 'lucide-react';
import { api, type GoogleDriveFolderPage, type GoogleDriveRun, type GoogleDriveStatus } from '../api';
import { formatSize, friendlyError } from '../format';
import { clearSearchParam } from '../route';

type Crumb = { id: string; name: string };

function runLabel(run: GoogleDriveRun | null, paused: boolean): string {
  if (paused) return 'Paused';
  if (!run) return 'Waiting to start';
  if (run.state === 'listing') return 'Listing folders';
  if (run.state === 'downloading') return 'Downloading';
  if (run.state === 'completed') return 'Up to date';
  if (run.state === 'failed') return 'Needs attention';
  if (run.state === 'cancelled') return 'Stopped';
  return 'Syncing';
}

function throttleLabel(reason: string | null): string | null {
  if (reason === 'image_index') return 'Waiting so image previews can finish first.';
  if (reason === 'indexer_running') return 'Slowed down while a preview is being built.';
  if (reason === 'rate_limit') return 'Google asked for a short pause.';
  return null;
}

function progressPercent(run: GoogleDriveRun): number {
  const done = run.downloaded_files + run.skipped_files + run.failed_files;
  const total = Math.max(run.discovered_files, done, 1);
  return Math.max(0, Math.min(100, Math.round((done / total) * 100)));
}

export default function GoogleDrivePanel({ onClose }: { onClose: () => void }) {
  const [status, setStatus] = useState<GoogleDriveStatus | null>(null);
  const [folders, setFolders] = useState<GoogleDriveFolderPage | null>(null);
  const [crumbs, setCrumbs] = useState<Crumb[]>([{ id: 'root', name: 'My Drive' }]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState('');

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const result = params.get('google');
    if (result === 'connected') setNotice('Google Drive is connected.');
    if (result === 'error') setError('Google Drive could not be connected.');
    if (result) clearSearchParam('google');
  }, []);

  useEffect(() => {
    let closed = false;
    let timer: number | undefined;
    const poll = async () => {
      try {
        const next = await api.googleDriveStatus();
        if (!closed) {
          setStatus(next);
          setError((current) => current && next.connected ? '' : current);
        }
        const active = next.sources.some((source) =>
          source.run?.state === 'listing' || source.run?.state === 'downloading'
        );
        if (!closed) timer = window.setTimeout(() => void poll(), active ? 2000 : 8000);
      } catch (cause: unknown) {
        if (!closed) {
          setError(friendlyError(cause));
          timer = window.setTimeout(() => void poll(), 8000);
        }
      }
    };
    void poll();
    return () => {
      closed = true;
      if (timer != null) window.clearTimeout(timer);
    };
  }, [notice]);

  useEffect(() => {
    if (!status?.connected || status.reauth_required) return;
    const parent = crumbs[crumbs.length - 1]?.id ?? 'root';
    const controller = new AbortController();
    api.googleDriveFolders(parent, controller.signal)
      .then((page) => setFolders(page))
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setError(friendlyError(cause));
      });
    return () => controller.abort();
  }, [status?.connected, status?.reauth_required, crumbs]);

  async function run(action: string, work: () => Promise<void>) {
    setBusy(action);
    setError('');
    try {
      await work();
      setStatus(await api.googleDriveStatus());
    } catch (cause: unknown) {
      setError(friendlyError(cause));
    } finally {
      setBusy('');
    }
  }

  const active = status?.sources.some((source) =>
    source.run?.state === 'listing' || source.run?.state === 'downloading'
  );

  return (
    <section className="google-drive-panel" id="google-drive-panel" aria-labelledby="google-drive-title">
      <div className="media-index-header">
        <div>
          <span className="eyebrow">IMPORT</span>
          <h2 id="google-drive-title">Google Drive</h2>
          <p>Choose folders to copy onto this drive. Images are previewed before videos, and the copy stays slow enough for this server.</p>
        </div>
        <button className="icon-button media-index-close" type="button" onClick={onClose} aria-label="Close Google Drive panel"><X size={18} /></button>
      </div>

      {error ? <div className="media-index-message media-index-error" role="alert">{error}</div> : null}
      {notice ? <div className="media-index-message media-index-notice" role="status">{notice}</div> : null}

      {status && !status.configured ? (
        <p className="google-drive-note">An administrator still needs to add the Google OAuth client settings before accounts can connect.</p>
      ) : null}

      {status?.configured && !status.connected ? (
        <button className="button button-primary" type="button" disabled={busy !== ''} onClick={() => void run('connect', async () => {
          const result = await api.googleDriveConnect();
          window.location.assign(result.authorize_url);
        })}>
          <Cloud size={16} /> Connect Google Drive
        </button>
      ) : null}

      {status?.connected ? (
        <>
          <div className="google-drive-toolbar">
            <span>{status.email}</span>
            <div className="media-index-actions">
              <button className="button button-secondary" type="button" disabled={busy !== ''} onClick={() => void run('pause', async () => {
                await api.googleDrivePause(!status.paused);
                setNotice(status.paused ? 'Sync resumed.' : 'Sync paused.');
              })}>
                {status.paused ? <Play size={15} /> : <Pause size={15} />}
                {status.paused ? 'Resume' : 'Pause'}
              </button>
              <button className="button button-secondary" type="button" disabled={busy !== ''} onClick={() => void run('disconnect', async () => {
                await api.googleDriveDisconnect();
                setFolders(null);
                setNotice('Google Drive disconnected. Files already copied stay on this drive.');
              })}>
                <Unlink size={15} /> Disconnect
              </button>
            </div>
          </div>

          {status.reauth_required ? <p className="google-drive-note">Google needs this account to be connected again.</p> : null}

          <div className="media-index-metrics" aria-label="Imported media indexing">
            <div><span>Images indexed</span><strong>{status.images_indexed}</strong></div>
            <div><span>Images waiting</span><strong>{status.images_waiting}</strong></div>
            <div><span>Videos indexed</span><strong>{status.videos_indexed}</strong></div>
            <div><span>Videos waiting</span><strong>{status.videos_waiting}</strong></div>
          </div>

          <div className="google-drive-browser">
            <div className="google-drive-crumbs">
              {crumbs.map((crumb, index) => (
                <button key={crumb.id} type="button" onClick={() => setCrumbs(crumbs.slice(0, index + 1))}>{crumb.name}</button>
              ))}
            </div>
            {folders?.folders.length ? folders.folders.map((folder) => (
              <div className="google-drive-folder" key={folder.id}>
                <button type="button" onClick={() => setCrumbs([...crumbs, folder])}>
                  <Folder size={16} /> <span>{folder.name}</span>
                </button>
                <button
                  className="button button-secondary"
                  type="button"
                  disabled={busy !== '' || status.reauth_required}
                  onClick={() => void run('select-' + folder.id, async () => {
                    await api.googleDriveSelect(folder.id);
                    setNotice(folder.name + ' will sync in the background.');
                  })}
                >
                  Sync folder
                </button>
              </div>
            )) : <p className="google-drive-note">No folders in this location.</p>}
            {crumbs.length === 1 ? (
              <button
                className="button button-secondary"
                type="button"
                disabled={busy !== '' || status.reauth_required}
                onClick={() => void run('select-root', async () => {
                  await api.googleDriveSelect('root');
                  setNotice('My Drive will sync in the background.');
                })}
              >
                Sync all of My Drive
              </button>
            ) : null}
          </div>

          <div className="google-drive-sources">
            {status.sources.map((source) => {
              const syncRun = source.run;
              const hint = throttleLabel(syncRun?.throttle_reason ?? null);
              return (
                <article key={source.id}>
                  <div className="google-drive-source-head">
                    <strong>{source.google_folder_name}</strong>
                    <span>{runLabel(syncRun, status.paused)}</span>
                  </div>
                  {syncRun ? (
                    <>
                      <div className="google-drive-bar" aria-hidden="true"><span style={{ width: progressPercent(syncRun) + '%' }} /></div>
                      <p>
                        {syncRun.downloaded_files + syncRun.skipped_files} of {syncRun.discovered_files} files
                        {' · '}{formatSize(syncRun.downloaded_bytes)} copied
                        {syncRun.failed_files ? ` · ${syncRun.failed_files} failed` : ''}
                        {syncRun.discovered_folders ? ` · ${syncRun.discovered_folders} folders` : ''}
                      </p>
                      {syncRun.current_name ? (
                        <p>{syncRun.current_name}{syncRun.current_total_bytes ? ` · ${formatSize(syncRun.current_bytes)} / ${formatSize(syncRun.current_total_bytes)}` : ''}</p>
                      ) : null}
                      {hint ? <p>{hint}</p> : null}
                    </>
                  ) : null}
                  <div className="media-index-actions">
                    <button className="button button-secondary" type="button" disabled={busy !== '' || active === true} onClick={() => void run('sync-' + source.id, async () => {
                      const result = await api.googleDriveSync(source.id);
                      setNotice(result.started ? 'Sync started.' : 'A sync is already running.');
                    })}>
                      <RefreshCw size={14} /> Sync now
                    </button>
                    <button className="button button-secondary" type="button" disabled={busy !== ''} onClick={() => void run('remove-' + source.id, async () => {
                      await api.googleDriveRemove(source.id);
                      setNotice('Stopped syncing ' + source.google_folder_name + '.');
                    })}>
                      Stop
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
        </>
      ) : null}
      {busy && busy !== 'connect' ? <p className="google-drive-note">{busy.startsWith('select') ? 'Adding folder…' : 'Working…'}</p> : null}
      {status == null && !error ? <p className="google-drive-note">Loading Google Drive…</p> : null}
    </section>
  );
}
