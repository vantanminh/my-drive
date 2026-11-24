import { useEffect, useState } from 'react';
import { Download, HardDrive, Images, Trash2 } from 'lucide-react';
import { api, downloadUrl } from '../api';
import { formatSize, friendlyError } from '../format';
import { useI18n, type MessageKey } from '../i18n';
import { navigateTo } from '../route';
import type { AccountStorage, CategoryUsage, LargestFile, ServerStorage, User } from '../types';

const CATEGORY_COLOR: Record<string, string> = {
  image: '#1f8f68',
  video: '#3d6f9a',
  audio: '#8a6bb5',
  document: '#c47a4a',
  archive: '#6d7c86',
  folder: '#16815f',
  other: '#b7c0c6'
};

function categoryColor(category: string): string {
  return CATEGORY_COLOR[category] || CATEGORY_COLOR.other;
}

const CATEGORY_KEYS: Record<string, MessageKey> = {
  image: 'cat.image',
  video: 'cat.video',
  audio: 'cat.audio',
  document: 'cat.document',
  archive: 'cat.archive',
  folder: 'cat.folder'
};

export function QuotaCard({ teamName }: { teamName?: string | null }) {
  const { t } = useI18n();
  const [storage, setStorage] = useState<AccountStorage | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    api.accountStorage(controller.signal).then(setStorage).catch(() => undefined);
    return () => controller.abort();
  }, [teamName]);
  if (!storage) return null;
  const used = storage.used_bytes + storage.reserved_bytes;
  const percent = storage.percent_used == null ? null : Math.min(100, Math.max(0, storage.percent_used));
  return (
    <div className="quota-card">
      <div className="quota-card-title"><HardDrive size={15} /> <span>{teamName ? t('storage.quota_team', { name: teamName }) : t('section.storage')}</span></div>
      <strong>{formatSize(used)}{storage.quota_bytes != null ? ' ' + t('storage.committed_of', { total: formatSize(storage.quota_bytes) }).trim() : ''}</strong>
      {percent != null && (
        <div className="quota-meter" aria-hidden="true"><i style={{ width: percent + '%' }} /></div>
      )}
      <small>
        {storage.unlimited
          ? t('storage.quota_no_limit')
          : t('storage.quota_remaining', { size: formatSize(storage.available_bytes) })}
        {storage.reserved_bytes > 0 ? ' · ' + t('storage.quota_uploading', { size: formatSize(storage.reserved_bytes) }) : ''}
      </small>
    </div>
  );
}

function Donut({ used, reserved, total, unlimited }: { used: number; reserved: number; total: number | null; unlimited: boolean }) {
  const { t } = useI18n();
  const capacity = total && total > 0 ? total : Math.max(used + reserved, 1);
  const usedEnd = Math.min(100, (used / capacity) * 100);
  const reservedEnd = Math.min(100, ((used + reserved) / capacity) * 100);
  const background = unlimited && !total
    ? `conic-gradient(#1f8f68 0 ${Math.max(usedEnd, 8)}%, #e6eeea ${Math.max(usedEnd, 8)}% 100%)`
    : `conic-gradient(#1f8f68 0 ${usedEnd}%, #e2b15a ${usedEnd}% ${reservedEnd}%, #e7eeea ${reservedEnd}% 100%)`;
  const percent = total && total > 0 ? Math.round(((used + reserved) / total) * 100) : null;
  return (
    <div className="storage-donut" style={{ background }} role="img" aria-label={percent == null ? t('storage.donut_aria', { size: formatSize(used) }) : t('storage.of_storage', { pct: percent })}>
      <div>
        <strong>{percent == null ? formatSize(used) : percent + '%'}</strong>
        <span>{percent == null ? t('storage.donut_stored') : t('storage.donut_used')}</span>
      </div>
    </div>
  );
}

function CategoryChart({ rows }: { rows: CategoryUsage[] }) {
  const { t } = useI18n();
  const total = rows.reduce((sum, row) => sum + row.size_bytes, 0);
  if (rows.length === 0 || total <= 0) return <p className="storage-muted">{t('storage.chart_empty')}</p>;
  return (
    <>
      <div className="storage-stack" aria-hidden="true">
        {rows.map((row) => (
          <i key={row.category} style={{ width: `${(row.size_bytes / total) * 100}%`, background: categoryColor(row.category) }} title={t(CATEGORY_KEYS[row.category] ?? 'cat.other')} />
        ))}
      </div>
      <ul className="storage-legend">
        {rows.map((row) => (
          <li key={row.category}>
            <span className="storage-swatch" style={{ background: categoryColor(row.category) }} />
            <span className="storage-legend-name">{t(CATEGORY_KEYS[row.category] ?? 'cat.other')}</span>
            <strong>{formatSize(row.size_bytes)}</strong>
            <small>{row.file_count === 1 ? t('storage.file_count_one') : t('storage.file_count', { count: row.file_count })} · {Math.round((row.size_bytes / total) * 100)}%</small>
          </li>
        ))}
      </ul>
    </>
  );
}

function LargestFiles({ files, empty }: { files: LargestFile[]; empty: string }) {
  const { t } = useI18n();
  if (files.length === 0) return <p className="storage-muted">{empty}</p>;
  return (
    <ol className="largest-files">
      {files.map((file) => (
        <li key={file.id}>
          <button className="largest-file-name" type="button" title={file.name} onClick={() => navigateTo('/drive?file=' + encodeURIComponent(file.id))}>{file.name}</button>
          <span className="largest-file-meta">{t(CATEGORY_KEYS[file.category] ?? 'cat.other')} · {formatSize(file.size_bytes)}</span>
          <a className="icon-button" href={downloadUrl(file.id)} aria-label={t('storage.download_label', { name: file.name })}><Download size={15} /></a>
        </li>
      ))}
    </ol>
  );
}

function Meter({ label, used, total, free }: { label: string; used: number; total: number; free: number }) {
  const { t } = useI18n();
  const percent = total > 0 ? Math.min(100, (used / total) * 100) : 0;
  return (
    <article className="storage-card">
      <header><span>{label}</span><strong>{percent.toFixed(0)}%</strong></header>
      <div className="quota-meter" aria-hidden="true"><i style={{ width: percent + '%' }} /></div>
      <p>{t('storage.meter_summary', { used: formatSize(used), free: formatSize(free), total: formatSize(total) })}</p>
    </article>
  );
}

const GIB = 1024 ** 3;
const MAX_QUOTA_GB = 8_000_000_000_000_000 / GIB;

export default function StoragePage({ user }: { user: User }) {
  const { t } = useI18n();
  const operator = user.role === 'owner' || user.role === 'admin';
  const [account, setAccount] = useState<AccountStorage | null>(null);
  const [server, setServer] = useState<ServerStorage | null>(null);
  const [error, setError] = useState('');
  const [ownerQuotaGb, setOwnerQuotaGb] = useState('');
  const [savingOwnerQuota, setSavingOwnerQuota] = useState(false);
  const [ownerQuotaNotice, setOwnerQuotaNotice] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    setError('');
    const accountRequest = api.accountStorage(controller.signal).then((data) => {
      setAccount(data);
      if (data.quota_bytes != null) {
        setOwnerQuotaGb((data.quota_bytes / GIB).toFixed(2).replace(/\.00$/, ''));
      }
    });
    const serverRequest = operator
      ? api.serverStorage(controller.signal).then(setServer)
      : Promise.resolve();
    Promise.all([accountRequest, serverRequest]).catch((cause: unknown) => {
      if (!controller.signal.aborted) setError(friendlyError(cause));
    });
    return () => controller.abort();
  }, [operator]);

  async function saveOwnerQuota(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const gb = Number(ownerQuotaGb);
    if (!Number.isFinite(gb) || gb < 0 || gb > MAX_QUOTA_GB) {
      setError(t('storage.quota_invalid'));
      return;
    }
    setSavingOwnerQuota(true);
    setError('');
    setOwnerQuotaNotice('');
    try {
      const bytes = Math.round(gb * GIB);
      await api.updateManagedAccount(user.id, { quotaBytes: bytes });
      const [freshAccount, freshServer] = await Promise.all([
        api.accountStorage(),
        operator ? api.serverStorage() : Promise.resolve(null),
      ]);
      setAccount(freshAccount);
      if (freshServer) setServer(freshServer);
      if (freshAccount.quota_bytes != null) {
        setOwnerQuotaGb((freshAccount.quota_bytes / GIB).toFixed(2).replace(/\.00$/, ''));
      }
      setOwnerQuotaNotice(t('storage.quota_saved'));
    } catch (cause: unknown) {
      setError(friendlyError(cause));
    } finally {
      setSavingOwnerQuota(false);
    }
  }

  const largest = account?.largest_files ?? [];
  const committed = account ? account.used_bytes + account.reserved_bytes : 0;

  return (
    <section className="storage-page">
      <header className="photos-heading">
        <div>
          <span className="eyebrow">{t('storage.eyebrow')}</span>
          <h1>{t('storage.title')}</h1>
          <p>{operator ? t('storage.subtitle_owner') : t('storage.subtitle_user')}</p>
        </div>
      </header>
      {error && <div className="notice notice-error" role="alert"><span>{error}</span></div>}
      {ownerQuotaNotice && !error && <div className="notice notice-success" role="status"><span>{ownerQuotaNotice}</span></div>}
      {!account && !error && <div className="storage-skeleton" role="status">{t('storage.loading')}</div>}
      {account && (
        <>
          <div className="storage-hero">
            <Donut used={account.used_bytes} reserved={account.reserved_bytes} total={account.quota_bytes} unlimited={account.unlimited} />
            <div className="storage-stats">
              <article><span>{t('storage.used')}</span><strong>{formatSize(account.used_bytes)}</strong></article>
              <article><span>{t('storage.available')}</span><strong>{account.available_bytes == null ? t('storage.no_limit') : formatSize(account.available_bytes)}</strong></article>
              <article><span>{t('storage.total')}</span><strong>{account.quota_bytes == null ? t('storage.unlimited') : formatSize(account.quota_bytes)}</strong></article>
              <article><span>{t('storage.uploading')}</span><strong>{formatSize(account.reserved_bytes)}</strong></article>
            </div>
          </div>
          {user.role === 'owner' && (
            <form className="account-quota-edit" onSubmit={(event) => void saveOwnerQuota(event)}>
              <label htmlFor="storage-owner-quota">{t('storage.root_quota')} <span>GB</span></label>
              <input
                id="storage-owner-quota"
                className="text-input"
                type="number"
                min="0"
                max={MAX_QUOTA_GB}
                step="0.01"
                value={ownerQuotaGb}
                onChange={(event) => setOwnerQuotaGb(event.target.value)}
                aria-label={t('storage.root_quota_label')}
              />
              <button className="button button-secondary" type="submit" disabled={savingOwnerQuota}>
                {savingOwnerQuota ? t('storage.saving') : t('storage.save_quota')}
              </button>
            </form>
          )}
          <p className="storage-summary">
            {t('storage.committed', { size: formatSize(committed) })}
            {account.quota_bytes != null ? t('storage.committed_of', { total: formatSize(account.quota_bytes) }) : ''}.
            {account.reserved_bytes > 0 ? t('storage.reserved', { size: formatSize(account.reserved_bytes) }) : ''}
          </p>
          <div className="storage-panels">
            <article className="storage-card">
              <h2>{t('storage.by_type')}</h2>
              <CategoryChart rows={account.by_category} />
            </article>
            <article className="storage-card">
              <h2>{t('storage.largest')}</h2>
              <LargestFiles files={largest} empty={t('storage.empty')} />
            </article>
          </div>
          <div className="storage-actions">
            <button className="button button-secondary" type="button" onClick={() => navigateTo('/trash')}><Trash2 size={16} /> {t('storage.review_trash')}</button>
            <button className="button button-secondary" type="button" onClick={() => navigateTo('/photos')}><Images size={16} /> {t('storage.open_photos')}</button>
            <button className="button button-secondary" type="button" onClick={() => navigateTo('/drive')}><HardDrive size={16} /> {t('storage.browse')}</button>
          </div>
        </>
      )}
      {operator && server && (
        <div className="storage-admin">
          <h2>{t('storage.server')}</h2>
          <div className="storage-panels">
            {server.ssd && <Meter label={t('storage.ssd_label')} used={server.ssd.used_bytes} total={server.ssd.total_bytes} free={server.ssd.free_bytes} />}
            {server.hdd && <Meter label={t('storage.hdd_label')} used={server.hdd.used_bytes} total={server.hdd.total_bytes} free={server.hdd.free_bytes} />}
          </div>
          <p className="storage-summary">
            {t('storage.system_used', { size: formatSize(server.system_used_bytes), size2: formatSize(server.library_bytes) })}
            {server.same_volume ? t('storage.same_volume') : ''}
          </p>
          <div className="storage-panels">
            <article className="storage-card">
              <h2>{t('storage.library_type')}</h2>
              <CategoryChart rows={server.by_category} />
            </article>
            <article className="storage-card">
              <h2>{t('storage.library_largest')}</h2>
              <LargestFiles files={server.largest_files ?? []} empty={t('storage.library_empty')} />
            </article>
          </div>
          <div className="table-card">
            <div className="table-head storage-grid"><span>{t('storage.account')}</span><span>{t('storage.used')}</span><span>{t('storage.share_library')}</span><span>{t('storage.share_hdd')}</span></div>
            {server.users.map((row) => (
              <div className="table-row storage-grid" key={row.id}>
                <span className="storage-account">{row.email}<small>{row.role}</small></span>
                <span>{formatSize(row.used_bytes)}</span>
                <span>{row.percent_of_library.toFixed(1)}%</span>
                <span>{row.percent_of_hdd == null ? '—' : row.percent_of_hdd.toFixed(1) + '%'}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
