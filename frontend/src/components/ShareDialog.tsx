import { useState, type FormEvent } from 'react';
import { Check, Copy, Link2, LockKeyhole, Share2, X } from 'lucide-react';
import { api } from '../api';
import { friendlyError } from '../format';
import type { CreatedShare, Entry } from '../types';

type Props = {
  entry: Pick<Entry, 'id' | 'kind' | 'name'>;
  onClose: () => void;
  onCreated: () => void;
};

export default function ShareDialog({ entry, onClose, onCreated }: Props) {
  const [expiresIn, setExpiresIn] = useState('7');
  const [password, setPassword] = useState('');
  const [allowDownload, setAllowDownload] = useState(true);
  const [maxDownloads, setMaxDownloads] = useState('');
  const [created, setCreated] = useState<CreatedShare | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const [copyFallback, setCopyFallback] = useState(false);

  const publicLink = created ? window.location.origin + created.share_url : '';

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    if (password && (password.length < 8 || password.length > 128)) {
      setError('Use a password between 8 and 128 characters.');
      return;
    }
    const maximum = maxDownloads.trim() ? Number(maxDownloads) : null;
    if (maximum != null && (!Number.isSafeInteger(maximum) || maximum < 1)) {
      setError('Enter a positive whole number of downloads.');
      return;
    }
    const expiresAt = expiresIn === 'never'
      ? null
      : new Date(Date.now() + Number(expiresIn) * 24 * 60 * 60 * 1000).toISOString();
    setBusy(true);
    try {
      const result = await api.createShare({
        resource_type: entry.kind,
        resource_id: entry.id,
        expires_at: expiresAt,
        password: password || null,
        allow_download: allowDownload,
        max_downloads: maximum
      });
      setCreated(result);
      onCreated();
    } catch (cause) {
      setError(friendlyError(cause));
    } finally {
      setBusy(false);
    }
  }

  async function copyLink() {
    setCopied(false);
    setCopyFallback(false);
    try {
      await navigator.clipboard.writeText(publicLink);
      setCopied(true);
    } catch {
      setCopyFallback(true);
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="modal-card share-dialog" role="dialog" aria-modal="true" aria-labelledby="share-dialog-title">
        <button className="modal-close icon-button" onClick={onClose} aria-label="Close dialog"><X size={18} /></button>
        {created ? (
          <>
            <span className="modal-icon success-modal-icon"><Check size={20} /></span>
            <span className="eyebrow">LINK READY</span>
            <h2 id="share-dialog-title">Your link is ready</h2>
            <p className="modal-description">Anyone with this link can open “{entry.name}”{created.password_protected ? ' with the password you set' : ''}. Save the link now; it will not be shown again.</p>
            <label className="field-label" htmlFor="created-share-link">Share link</label>
            <div className="copy-link-row">
              <input
                id="created-share-link"
                className="text-input"
                value={publicLink}
                readOnly
                onFocus={(event) => event.currentTarget.select()}
                onClick={(event) => event.currentTarget.select()}
              />
              <button className="button button-primary" onClick={() => void copyLink()}><Copy size={16} /> {copied ? 'Copied' : 'Copy'}</button>
            </div>
            {copyFallback && <p className="copy-fallback">Select the link above and copy it.</p>}
            {created.password_protected && <div className="share-password-note"><LockKeyhole size={15} /> Share the password separately with people you trust.</div>}
            <div className="modal-actions single-action"><button className="button button-secondary" onClick={onClose}>Done</button></div>
          </>
        ) : (
          <>
            <span className="modal-icon"><Share2 size={19} /></span>
            <span className="eyebrow">SHARE SECURELY</span>
            <h2 id="share-dialog-title">Create a share link</h2>
            <p className="modal-description">Choose who can open “{entry.name}” and how long the link stays available.</p>
            <form className="form-stack share-form" onSubmit={(event) => void submit(event)}>
              <label className="field-label" htmlFor="share-expiry">Link expires</label>
              <select id="share-expiry" className="text-input select-input" value={expiresIn} onChange={(event) => setExpiresIn(event.target.value)}>
                <option value="never">Never</option>
                <option value="1">After 24 hours</option>
                <option value="7">After 7 days</option>
                <option value="30">After 30 days</option>
              </select>
              <label className="field-label" htmlFor="share-password-create">Password <span className="field-optional">Optional</span></label>
              <input
                id="share-password-create"
                className="text-input"
                type="password"
                autoComplete="new-password"
                maxLength={128}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="Add a password"
              />
              <label className="field-label" htmlFor="share-max-downloads">Download limit <span className="field-optional">Optional</span></label>
              <input
                id="share-max-downloads"
                className="text-input"
                type="number"
                min="1"
                step="1"
                value={maxDownloads}
                onChange={(event) => setMaxDownloads(event.target.value)}
                placeholder="Unlimited downloads"
              />
              <label className="toggle-row">
                <span className="toggle-copy"><strong>Allow downloads</strong><small>People with the link can download shared files.</small></span>
                <input type="checkbox" checked={allowDownload} onChange={(event) => setAllowDownload(event.target.checked)} />
                <i className="toggle-switch" aria-hidden="true" />
              </label>
              {error && <div className="inline-alert" role="alert">{error}</div>}
              <div className="modal-actions">
                <button type="button" className="button button-secondary" onClick={onClose}>Cancel</button>
                <button type="submit" className="button button-primary" disabled={busy}>
                  <Link2 size={16} /> {busy ? 'Creating…' : 'Create link'}
                </button>
              </div>
            </form>
          </>
        )}
      </section>
    </div>
  );
}
