import { useEffect, useState } from 'react';
import { ChevronRight, Folder, X } from 'lucide-react';
import { api } from '../api';
import { friendlyError } from '../format';
import { useI18n } from '../i18n';
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
  const { t } = useI18n();
  const [crumbs, setCrumbs] = useState<Crumb[]>(() => [{ id: null, name: t('nav.my_drive') }]);
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
        const chain: Crumb[] = [{ id: null, name: t('nav.my_drive') }];
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
  }, [startId, t]);

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
        <button className="modal-close icon-button" type="button" onClick={onCancel} aria-label={t('dialog.close')}><X size={18} /></button>
        <span className="modal-icon"><Folder size={19} /></span>
        <span className="eyebrow">{t('dialog.choose_folder')}</span>
        <h2 id="destination-title">{title}</h2>
        <p className="modal-description">{description}</p>
        <nav className="destination-crumbs" aria-label={t('dialog.destination')}>
          {crumbs.map((crumb, index) => (
            <span key={crumb.id ?? 'root'}>
              {index > 0 && <ChevronRight size={14} />}
              <button type="button" onClick={() => setCrumbs(crumbs.slice(0, index + 1))} aria-current={index === crumbs.length - 1 ? 'page' : undefined}>
                {crumb.name}
              </button>
            </span>
          ))}
        </nav>
        <div className="destination-list" role="listbox" aria-label={t('dialog.folders')}>
          {loading && <p className="destination-status">{t('dialog.loading_folders')}</p>}
          {!loading && folders.length === 0 && <p className="destination-status">{t('dialog.no_folders')}</p>}
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
                {folder.system_role === 'photos' && <em>{t('entry.photos_badge')}</em>}
              </button>
            );
          })}
        </div>
        {blocked && <p className="inline-alert" role="alert">{t('dialog.outside_selection')}</p>}
        {error && <div className="inline-alert" role="alert">{error}</div>}
        <div className="modal-actions">
          <button type="button" className="button button-secondary" onClick={onCancel} disabled={busy}>{t('dialog.cancel')}</button>
          <button type="button" className="button button-primary" onClick={() => void confirm()} disabled={busy || blocked || loading}>
            {busy ? t('dialog.working') : confirmLabel}
          </button>
        </div>
      </section>
    </div>
  );
}
