import { useEffect, useState } from 'react';
import { HardDrive, ShieldCheck, X } from 'lucide-react';
import { api } from '../api';
import { friendlyError } from '../format';
import type { NetworkDriveStatus } from '../types';

type Props = {
  email: string;
  onClose: () => void;
  onOpenDeveloper: () => void;
};

export default function NetworkDrivePanel({ email, onClose, onOpenDeveloper }: Props) {
  const [data, setData] = useState<NetworkDriveStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    api
      .networkDriveStatus(controller.signal)
      .then(setData)
      .catch((cause: unknown) => {
        if (!(cause instanceof DOMException && cause.name === 'AbortError')) setError(friendlyError(cause));
      });
    return () => controller.abort();
  }, []);

  async function toggle(enabled: boolean) {
    setBusy(true);
    setError('');
    try {
      setData(await api.setNetworkDrive(enabled));
    } catch (cause: unknown) {
      setError(friendlyError(cause));
    } finally {
      setBusy(false);
    }
  }

  const origin = window.location.origin;
  const url = data ? `${origin}${data.path}` : '';
  const host = window.location.host;

  return (
    <section className="account-security-panel" id="network-drive-panel" aria-labelledby="network-drive-title">
      <div className="account-security-header">
        <div>
          <span className="eyebrow">LOCAL NETWORK</span>
          <h2 id="network-drive-title">Network drive (WebDAV)</h2>
          <p>Browse and open your files from Windows, macOS, Linux or iOS as a mapped network drive. Read-only and limited to your private network.</p>
        </div>
        <div className="account-admin-header-actions">
          <button className="icon-button media-index-close" type="button" aria-label="Close network drive" onClick={onClose}>
            <X size={17} />
          </button>
        </div>
      </div>

      {error ? <div className="security-message security-message-error" role="alert">{error}</div> : null}

      {data ? (
        <div className="account-security-grid">
          <div className="security-card">
            <div className="security-card-heading">
              <span className="security-card-icon"><HardDrive size={17} /></span>
              <div>
                <h3>Status: {data.enabled ? 'Enabled' : 'Disabled'}</h3>
                <p>Only clients on private addresses (10.x, 172.16–31.x, 192.168.x, loopback) can connect.</p>
              </div>
            </div>
            {data.canManage ? (
              <label className="system-update-toggle">
                <input
                  type="checkbox"
                  checked={data.enabled}
                  disabled={busy}
                  onChange={(event) => void toggle(event.target.checked)}
                />
                <span>
                  <strong>Enable network drive</strong>
                  <small>Applies immediately to every account. Disable it to close the endpoint (it then returns 404).</small>
                </span>
              </label>
            ) : (
              <p>Only the owner can turn this feature on or off.</p>
            )}
          </div>

          <div className="security-card">
            <div className="security-card-heading">
              <span className="security-card-icon"><ShieldCheck size={17} /></span>
              <div>
                <h3>How to connect</h3>
                <p>Server address: <code>{url}</code></p>
              </div>
            </div>
            <ol>
              <li>
                Create an API key with the <code>drive:read</code> scope in{' '}
                <button className="link-button" type="button" onClick={onOpenDeveloper}>Settings · Developer</button>.
              </li>
              <li>Username: <code>{email}</code> · Password: the API key (<code>mdk_…</code>).</li>
              <li><strong>Windows:</strong> Explorer → This PC → Map network drive → <code>{url}</code> (HTTPS is required unless Basic over HTTP is allowed in the WebClient registry settings).</li>
              <li><strong>macOS:</strong> Finder → Go → Connect to Server → <code>{url}</code>.</li>
              <li><strong>Linux:</strong> <code>davs://{host}/webdav/</code> in the file manager, or <code>mount -t davfs {url} /mnt/drive</code>.</li>
            </ol>
          </div>
        </div>
      ) : !error ? (
        <div className="security-session-empty"><div className="spinner" /> Loading…</div>
      ) : null}
    </section>
  );
}
