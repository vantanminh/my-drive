import { useEffect, useState } from 'react';
import { Cloud, Folder, Pause, Play, RefreshCw, Unlink, X } from 'lucide-react';
import { api, type GoogleDriveFolderPage, type GoogleDriveRun, type GoogleDriveStatus, type GoogleDriveSettings } from '../api';
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

export default function GoogleDrivePanel({ onClose, isOwner }: { onClose: () => void; isOwner: boolean }) {
  const [status, setStatus] = useState<GoogleDriveStatus | null>(null);
  const [folders, setFolders] = useState<GoogleDriveFolderPage | null>(null);
  const [crumbs, setCrumbs] = useState<Crumb[]>([{ id: 'root', name: 'My Drive' }]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState('');
  const [settings, setSettings] = useState<GoogleDriveSettings | null>(null);
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [redirectUri, setRedirectUri] = useState(window.location.origin + '/api/google-drive/callback');

  useEffect(() => {
    if (!isOwner) return;
    const controller = new AbortController();
    api.googleDriveSettings(controller.signal).then((next) => {
      if (controller.signal.aborted) return;
      setSettings(next);
      setClientId(next.client_id);
      setRedirectUri(next.redirect_uri || window.location.origin + '/api/google-drive/callback');
    }).catch((cause: unknown) => {
      if (!controller.signal.aborted) setError(friendlyError(cause));
    });
    return () => controller.abort();
  }, [isOwner]);

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

      {isOwner && settings ? (
        <details className="google-drive-settings" open={!status?.configured}>
          <summary>Google OAuth settings</summary>
          {settings.available ? (
            <form onSubmit={(event) => {
              event.preventDefault();
              void run('settings', async () => {
                await api.googleDriveSaveSettings({ client_id: clientId.trim(), client_secret: clientSecret.trim(), redirect_uri: redirectUri.trim() });
                setClientSecret('');
                setSettings(await api.googleDriveSettings());
                setNotice('Google OAuth settings saved. You can connect your account now. If the Client ID changed, reconnect existing accounts.');
              });
            }}>
              <p>Create a Web application OAuth client in Google Cloud with the Drive API enabled. Add the exact Redirect URI below to its authorized redirect URIs.</p>
              <label>Client ID<input required value={clientId} onChange={(event) => setClientId(event.target.value)} maxLength={200} autoComplete="off" spellCheck={false} /></label>
              <label>Client Secret<input type="password" required={!settings.secret_saved || clientId.trim() !== settings.client_id} value={clientSecret} onChange={(event) => setClientSecret(event.target.value)} maxLength={256} autoComplete="new-password" placeholder={settings.secret_saved ? 'Leave blank to keep the saved secret' : 'Enter Client Secret'} /></label>
              <label>Redirect URI<input type="url" required value={redirectUri} onChange={(event) => setRedirectUri(event.target.value)} maxLength={500} autoComplete="off" spellCheck={false} /></label>
              <p>The secret is encrypted on the server. HTTPS is required except for localhost. Saving applies immediately; changing Client ID requires accounts to reconnect.</p>
              <button className="button button-secondary" type="submit" disabled={busy !== ''}>Save OAuth settings</button>
            </form>
          ) : <p>Set GOOGLE_DRIVE_TOKEN_KEY on the server to a 64-character hexadecimal key, then restart once to enable secure setup here.</p>}
        </details>
      ) : null}

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

          {status.reauth_required ? <div className="google-drive-toolbar"><p className="google-drive-note">Google needs this account to be connected again.</p><button className="button button-primary" type="button" disabled={busy !== ''} onClick={() => void run('connect', async () => {
            const result = await api.googleDriveConnect();
            window.location.assign(result.authorize_url);
          })}>Reconnect Google Drive</button></div> : null}

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
