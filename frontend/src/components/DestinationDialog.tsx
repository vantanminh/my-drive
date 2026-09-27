import { useEffect, useState } from 'react';
import { ChevronRight, Folder, X } from 'lucide-react';
import { api } from '../api';
import { friendlyError } from '../format';
import type { Entry } from '../types';

type Crumb = { id: string | null; name: string };

export default function DestinationDialog({
  title,
  description,
  confirmLabel,
  startId,
  excludeIds,
  onCancel,
  onConfirm
}: {
  title: string;
  description: string;
  confirmLabel: string;
  startId: string | null;
  excludeIds: string[];
  onCancel: () => void;
  onConfirm: (parentId: string | null) => Promise<void>;
}) {
  const [crumbs, setCrumbs] = useState<Crumb[]>([{ id: null, name: 'My Drive' }]);
  const [folders, setFolders] = useState<Entry[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const current = crumbs[crumbs.length - 1]?.id ?? null;
  const blocked = current != null && excludeIds.includes(current);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    api.listDrive(current)
      .then((page) => {
        if (cancelled) return;
        setFolders(page.entries.filter((entry) => entry.kind === 'folder' && !entry.deleted_at));
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(friendlyError(cause));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [current]);

  useEffect(() => {
    if (!startId) return;
    let cancelled = false;
    api.getEntry(startId)
      .then(async (entry) => {
        if (cancelled || entry.kind !== 'folder' || entry.deleted_at) return;
        const chain: Crumb[] = [{ id: null, name: 'My Drive' }];
        const stack: Entry[] = [entry];
        let parentId = entry.parent_id;
        const seen = new Set<string>([entry.id]);
        while (parentId && !seen.has(parentId)) {
          seen.add(parentId);
          const parent = await api.getEntry(parentId);
          if (cancelled || parent.kind !== 'folder') break;
          stack.unshift(parent);
          parentId = parent.parent_id;
        }
        if (cancelled) return;
        setCrumbs([...chain, ...stack.map((item) => ({ id: item.id, name: item.name }))]);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [startId]);

  async function confirm() {
    if (blocked || busy) return;
    setBusy(true);
    setError('');
    try {
      await onConfirm(current);
    } catch (cause) {
      setError(friendlyError(cause));
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onCancel(); }}>
      <section className="modal-card destination-dialog" role="dialog" aria-modal="true" aria-labelledby="destination-title">
        <button className="modal-close icon-button" type="button" onClick={onCancel} aria-label="Close dialog"><X size={18} /></button>
        <span className="modal-icon"><Folder size={19} /></span>
        <span className="eyebrow">CHOOSE A FOLDER</span>
        <h2 id="destination-title">{title}</h2>
        <p className="modal-description">{description}</p>
        <nav className="destination-crumbs" aria-label="Destination">
          {crumbs.map((crumb, index) => (
            <span key={crumb.id ?? 'root'}>
              {index > 0 && <ChevronRight size={14} />}
              <button type="button" onClick={() => setCrumbs(crumbs.slice(0, index + 1))} aria-current={index === crumbs.length - 1 ? 'page' : undefined}>
                {crumb.name}
              </button>
            </span>
          ))}
        </nav>
        <div className="destination-list" role="listbox" aria-label="Folders">
          {loading && <p className="destination-status">Loading folders…</p>}
          {!loading && folders.length === 0 && <p className="destination-status">No folders here. You can still place the selection in this folder.</p>}
          {folders.map((folder) => {
            const excluded = excludeIds.includes(folder.id);
            return (
              <button
                key={folder.id}
                type="button"
                className="destination-folder"
                disabled={excluded}
                onClick={() => setCrumbs([...crumbs, { id: folder.id, name: folder.name }])}
              >
                <Folder size={16} />
                <span>{folder.name}</span>
                {folder.system_role === 'photos' && <em>Photos</em>}
              </button>
            );
          })}
        </div>
        {blocked && <p className="inline-alert" role="alert">Choose a folder outside the selection.</p>}
        {error && <div className="inline-alert" role="alert">{error}</div>}
        <div className="modal-actions">
          <button type="button" className="button button-secondary" onClick={onCancel} disabled={busy}>Cancel</button>
          <button type="button" className="button button-primary" onClick={() => void confirm()} disabled={busy || blocked || loading}>
            {busy ? 'Working…' : confirmLabel}
          </button>
        </div>
      </section>
    </div>
  );
}
