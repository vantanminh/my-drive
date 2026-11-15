import { useEffect, useState, type FormEvent } from 'react';
import { HardDrive, KeyRound, ShieldCheck, X } from 'lucide-react';
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
  const [smbPassword, setSmbPassword] = useState('');
  const [smbPasswordConfirm, setSmbPasswordConfirm] = useState('');
  const [smbBusy, setSmbBusy] = useState(false);
  const [smbError, setSmbError] = useState('');
  const [smbNotice, setSmbNotice] = useState('');

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

  async function toggleWebdav(enabled: boolean) {
    setBusy(true);
    setError('');
    try {
      setData(await api.setNetworkDrive({ enabled }));
    } catch (cause: unknown) {
      setError(friendlyError(cause));
    } finally {
      setBusy(false);
    }
  }

  async function toggleSmb(smbEnabled: boolean) {
    setBusy(true);
    setError('');
    try {
      setData(await api.setNetworkDrive({ smbEnabled }));
    } catch (cause: unknown) {
      setError(friendlyError(cause));
    } finally {
      setBusy(false);
    }
  }

  async function saveSmbPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSmbError('');
    setSmbNotice('');
    if ([...smbPassword].length < 12) {
      setSmbError('Choose an SMB password with at least 12 characters.');
      return;
    }
    if (new TextEncoder().encode(smbPassword).length > 1024) {
      setSmbError('The SMB password must be no more than 1,024 bytes.');
      return;
    }
    if (smbPassword !== smbPasswordConfirm) {
      setSmbError('The SMB passwords do not match.');
      return;
    }
    setSmbBusy(true);
    try {
      const updated = await api.setSmbPassword(smbPassword);
      setData(updated);
      setSmbPassword('');
      setSmbPasswordConfirm('');
      setSmbNotice(
        updated.smbUsername
          ? `SMB password saved for username "${updated.smbUsername}". Samba syncs changes within ~10 seconds.`
          : 'SMB password saved.'
      );
    } catch (cause: unknown) {
      setSmbError(friendlyError(cause));
    } finally {
      setSmbBusy(false);
    }
  }

  const origin = window.location.origin;
  const url = data ? `${origin}${data.path}` : '';
  const host = window.location.host;
  const smbHost = window.location.hostname || 'your-server';
  const smbUnc = `\\\\${smbHost}\\drive`;

  return (
    <section className="account-security-panel" id="network-drive-panel" aria-labelledby="network-drive-title">
      <div className="account-security-header">
        <div>
          <span className="eyebrow">LOCAL NETWORK</span>
          <h2 id="network-drive-title">Network drive</h2>
          <p>Mount your drive in Windows File Explorer, macOS Finder or Linux as a read-only network drive on your private LAN.</p>
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
                <h3>SMB drive (Windows Z:): {data.smbEnabled ? 'Enabled' : 'Disabled'}</h3>
                <p>Real SMB/CIFS share (port 445), read-only and restricted to private LAN addresses.</p>
              </div>
            </div>

            {!data.smbAvailable ? (
              <div className="security-message security-message-error" role="status">
                SMB view storage is not configured on the app container (<code>SMB_VIEW_DIR</code> is unset). Start the stack with the <code>smb</code> Compose profile to enable SMB sharing.
              </div>
            ) : null}

            {data.canManage ? (
              <label className="system-update-toggle">
                <input
                  type="checkbox"
                  checked={data.smbEnabled}
                  disabled={busy}
                  onChange={(event) => void toggleSmb(event.target.checked)}
                />
                <span>
                  <strong>Enable SMB network drive</strong>
                  <small>Builds a read-only view for the Samba container (refreshed every ~10 seconds). Disable to clear the share tree and SMB user list.</small>
                </span>
              </label>
            ) : (
              <p>Only the owner can turn SMB sharing on or off.</p>
            )}

            <div className="security-card-heading" style={{ marginTop: 16 }}>
              <span className="security-card-icon"><KeyRound size={16} /></span>
              <div>
                <h3>SMB password</h3>
                <p>
                  {data.smbUsername
                    ? <>Your SMB username: <code>{data.smbUsername}</code></>
                    : 'Samba requires an NT hash, so SMB uses its own password separate from your web account password. Setting one assigns your SMB username.'}
                </p>
              </div>
            </div>

            {smbNotice ? <div className="security-message security-message-success" role="status">{smbNotice}</div> : null}
            <form className="form-stack security-password-form" onSubmit={(event) => void saveSmbPassword(event)}>
              <label className="field-label" htmlFor="smb-password-input">
                {data.smbUsername ? 'New SMB password' : 'SMB password'}
              </label>
              <input
                id="smb-password-input"
                className="text-input"
                type="password"
                autoComplete="new-password"
                required
                maxLength={1024}
                value={smbPassword}
                onChange={(event) => setSmbPassword(event.target.value)}
                aria-describedby="smb-password-hint"
              />
              <small className="password-field-hint" id="smb-password-hint">Use at least 12 characters. Separate from your My Drive login password.</small>
              <label className="field-label" htmlFor="smb-password-confirm">Confirm SMB password</label>
              <input
                id="smb-password-confirm"
                className="text-input"
                type="password"
                autoComplete="new-password"
                required
                maxLength={1024}
                value={smbPasswordConfirm}
                onChange={(event) => setSmbPasswordConfirm(event.target.value)}
              />
              {smbError ? <div className="inline-alert" role="alert">{smbError}</div> : null}
              <button className="button button-primary" type="submit" disabled={smbBusy}>
                {smbBusy ? 'Saving SMB password…' : (data.smbUsername ? 'Update SMB password' : 'Set SMB password')}
              </button>
            </form>
          </div>

          <div className="security-card">
            <div className="security-card-heading">
              <span className="security-card-icon"><ShieldCheck size={17} /></span>
              <div>
                <h3>How to connect via SMB</h3>
                <p>Network path: <code>{smbUnc}</code></p>
              </div>
            </div>
            <ol>
              <li>
                Username: {data.smbUsername ? <code>{data.smbUsername}</code> : <em>set an SMB password first</em>} &middot; Password: your dedicated SMB password.
              </li>
              <li>
                <strong>Windows (Map network drive):</strong> Open File Explorer → <strong>This PC</strong> → <strong>Map network drive</strong> → pick a drive letter (e.g. <code>Z:</code>), enter <code>{smbUnc}</code>, check <em>Connect using different credentials</em>, and sign in with your SMB username and password.
              </li>
              <li>
                <strong>macOS:</strong> Finder → Go → Connect to Server → <code>smb://{smbHost}/drive</code>.
              </li>
              <li>
                <strong>Linux:</strong> <code>smb://{smbHost}/drive</code> in your file manager, or <code>mount -t cifs //{smbHost}/drive /mnt/drive -o username={data.smbUsername ?? '<smb-username>'},ro</code>.
              </li>
            </ol>
          </div>

          <div className="security-card">
            <div className="security-card-heading">
              <span className="security-card-icon"><HardDrive size={17} /></span>
              <div>
                <h3>WebDAV drive: {data.enabled ? 'Enabled' : 'Disabled'}</h3>
                <p>Only clients on private addresses (10.x, 172.16–31.x, 192.168.x, loopback) can connect.</p>
              </div>
            </div>
            {data.canManage ? (
              <label className="system-update-toggle">
                <input
                  type="checkbox"
                  checked={data.enabled}
                  disabled={busy}
                  onChange={(event) => void toggleWebdav(event.target.checked)}
                />
                <span>
                  <strong>Enable WebDAV network drive</strong>
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
                <h3>How to connect via WebDAV</h3>
                <p>Server address: <code>{url}</code></p>
              </div>
            </div>
            <ol>
              <li>Username: <code>{email}</code> &middot; Password: your My Drive account password (an API key with the <code>drive:read</code> scope from <button className="link-button" type="button" onClick={onOpenDeveloper}>Settings &middot; Developer</button> also works).</li>
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
