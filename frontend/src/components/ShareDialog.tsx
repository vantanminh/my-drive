import { useState, type FormEvent } from 'react';
import { Check, Copy, Link2, LockKeyhole, Share2, X } from 'lucide-react';
import { api } from '../api';
import { friendlyError } from '../format';
import type { CreatedShare } from '../types';

type ShareSubject = { id: string; kind: 'file' | 'folder' | 'album'; name: string };

type Props = {
  entry?: ShareSubject;
  entries?: ShareSubject[];
  onClose: () => void;
  onCreated: () => void;
};

export default function ShareDialog({ entry, entries, onClose, onCreated }: Props) {
  const subjects = entries && entries.length > 0 ? entries : entry ? [entry] : [];
  const [expiresIn, setExpiresIn] = useState('7');
  const [password, setPassword] = useState('');
  const [allowDownload, setAllowDownload] = useState(true);
  const [maxDownloads, setMaxDownloads] = useState('');
  const [created, setCreated] = useState<CreatedShare[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const [copyFallback, setCopyFallback] = useState(false);

  const subjectLabel = subjects.length === 1 ? `“${subjects[0].name}”` : `${subjects.length} items`;

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
    if (subjects.length === 0) return;
    setBusy(true);
    try {
      const results: CreatedShare[] = [];
      for (const subject of subjects) {
        results.push(await api.createShare({
          resource_type: subject.kind,
          resource_id: subject.id,
          expires_at: expiresAt,
          password: password || null,
          allow_download: allowDownload,
          max_downloads: maximum
        }));
      }
      setCreated(results);
      onCreated();
    } catch (cause) {
      setError(friendlyError(cause));
    } finally {
      setBusy(false);
    }
  }

  async function copyLink(value: string) {
    setCopied(false);
    setCopyFallback(false);
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      setCopyFallback(true);
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="modal-card share-dialog" role="dialog" aria-modal="true" aria-labelledby="share-dialog-title">
        <button className="modal-close icon-button" onClick={onClose} aria-label="Close dialog"><X size={18} /></button>
        {created.length > 0 ? (
          <>
            <span className="modal-icon success-modal-icon"><Check size={20} /></span>
            <span className="eyebrow">LINK READY</span>
            <h2 id="share-dialog-title">{created.length === 1 ? 'Your link is ready' : 'Your links are ready'}</h2>
            <p className="modal-description">Anyone with {created.length === 1 ? 'this link' : 'these links'} can open {subjectLabel}{created.some((item) => item.password_protected) ? ' with the password you set' : ''}. Save them now; they will not be shown again.</p>
            <div className="share-link-list">
              {created.map((item) => {
                const publicLink = window.location.origin + item.share_url;
                const name = subjects.find((subject) => subject.id === item.resource_id)?.name || 'Shared item';
                return (
                  <div key={item.id} className="share-link-block">
                    <label className="field-label" htmlFor={'created-share-link-' + item.id}>{name}</label>
                    <div className="copy-link-row">
                      <input
                        id={'created-share-link-' + item.id}
                        className="text-input"
                        value={publicLink}
                        readOnly
                        onFocus={(event) => event.currentTarget.select()}
                        onClick={(event) => event.currentTarget.select()}
                      />
                      <button className="button button-primary" type="button" onClick={() => void copyLink(publicLink)}><Copy size={16} /> Copy</button>
                    </div>
                  </div>
                );
              })}
            </div>
            {copied && <p className="copy-fallback">Link copied.</p>}
            {copyFallback && <p className="copy-fallback">Select a link above and copy it.</p>}
            {created.some((item) => item.password_protected) && <div className="share-password-note"><LockKeyhole size={15} /> Share the password separately with people you trust.</div>}
            <div className="modal-actions single-action"><button className="button button-secondary" onClick={onClose}>Done</button></div>
          </>
        ) : (
          <>
            <span className="modal-icon"><Share2 size={19} /></span>
            <span className="eyebrow">SHARE SECURELY</span>
            <h2 id="share-dialog-title">Create a share link</h2>
            <p className="modal-description">Choose who can open {subjectLabel} and how long the link stays available.</p>
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
                  <Link2 size={16} /> {busy ? 'Creating…' : subjects.length > 1 ? 'Create links' : 'Create link'}
                </button>
              </div>
            </form>
          </>
        )}
      </section>
    </div>
  );
}
