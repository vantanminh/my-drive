import { useEffect, useState } from 'react';
import { Download, HardDrive, Images, Trash2 } from 'lucide-react';
import { api, downloadUrl } from '../api';
import { formatSize, friendlyError } from '../format';
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

function categoryLabel(category: string): string {
  if (!category) return 'Other';
  return category.charAt(0).toUpperCase() + category.slice(1);
}

export function QuotaCard() {
  const [storage, setStorage] = useState<AccountStorage | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    api.accountStorage(controller.signal).then(setStorage).catch(() => undefined);
    return () => controller.abort();
  }, []);
  if (!storage) return null;
  const used = storage.used_bytes + storage.reserved_bytes;
  const percent = storage.percent_used == null ? null : Math.min(100, Math.max(0, storage.percent_used));
  return (
    <div className="quota-card">
      <div className="quota-card-title"><HardDrive size={15} /> <span>Storage</span></div>
      <strong>{formatSize(used)}{storage.quota_bytes != null ? ` of ${formatSize(storage.quota_bytes)}` : ''}</strong>
      {percent != null && (
        <div className="quota-meter" aria-hidden="true"><i style={{ width: percent + '%' }} /></div>
      )}
      <small>
        {storage.unlimited
          ? 'No personal quota is set.'
          : `${formatSize(storage.available_bytes)} remaining`}
        {storage.reserved_bytes > 0 ? ` · ${formatSize(storage.reserved_bytes)} uploading` : ''}
      </small>
    </div>
  );
}

function Donut({ used, reserved, total, unlimited }: { used: number; reserved: number; total: number | null; unlimited: boolean }) {
  const capacity = total && total > 0 ? total : Math.max(used + reserved, 1);
  const usedEnd = Math.min(100, (used / capacity) * 100);
  const reservedEnd = Math.min(100, ((used + reserved) / capacity) * 100);
  const background = unlimited && !total
    ? `conic-gradient(#1f8f68 0 ${Math.max(usedEnd, 8)}%, #e6eeea ${Math.max(usedEnd, 8)}% 100%)`
    : `conic-gradient(#1f8f68 0 ${usedEnd}%, #e2b15a ${usedEnd}% ${reservedEnd}%, #e7eeea ${reservedEnd}% 100%)`;
  const percent = total && total > 0 ? Math.round(((used + reserved) / total) * 100) : null;
  return (
    <div className="storage-donut" style={{ background }} role="img" aria-label={percent == null ? `${formatSize(used)} stored` : `${percent}% of storage used`}>
      <div>
        <strong>{percent == null ? formatSize(used) : percent + '%'}</strong>
        <span>{percent == null ? 'stored' : 'used'}</span>
      </div>
    </div>
  );
}

function CategoryChart({ rows }: { rows: CategoryUsage[] }) {
  const total = rows.reduce((sum, row) => sum + row.size_bytes, 0);
  if (rows.length === 0 || total <= 0) return <p className="storage-muted">No files are using storage yet.</p>;
  return (
    <>
      <div className="storage-stack" aria-hidden="true">
        {rows.map((row) => (
          <i key={row.category} style={{ width: `${(row.size_bytes / total) * 100}%`, background: categoryColor(row.category) }} title={categoryLabel(row.category)} />
        ))}
      </div>
      <ul className="storage-legend">
        {rows.map((row) => (
          <li key={row.category}>
            <span className="storage-swatch" style={{ background: categoryColor(row.category) }} />
            <span className="storage-legend-name">{categoryLabel(row.category)}</span>
            <strong>{formatSize(row.size_bytes)}</strong>
            <small>{row.file_count} {row.file_count === 1 ? 'file' : 'files'} · {Math.round((row.size_bytes / total) * 100)}%</small>
          </li>
        ))}
      </ul>
    </>
  );
}

function LargestFiles({ files, empty }: { files: LargestFile[]; empty: string }) {
  if (files.length === 0) return <p className="storage-muted">{empty}</p>;
  return (
    <ol className="largest-files">
      {files.map((file) => (
        <li key={file.id}>
          <button className="largest-file-name" type="button" title={file.name} onClick={() => navigateTo('/drive?file=' + encodeURIComponent(file.id))}>{file.name}</button>
          <span className="largest-file-meta">{categoryLabel(file.category)} · {formatSize(file.size_bytes)}</span>
          <a className="icon-button" href={downloadUrl(file.id)} aria-label={'Download ' + file.name}><Download size={15} /></a>
        </li>
      ))}
    </ol>
  );
}

function Meter({ label, used, total, free }: { label: string; used: number; total: number; free: number }) {
  const percent = total > 0 ? Math.min(100, (used / total) * 100) : 0;
  return (
    <article className="storage-card">
      <header><span>{label}</span><strong>{percent.toFixed(0)}%</strong></header>
      <div className="quota-meter" aria-hidden="true"><i style={{ width: percent + '%' }} /></div>
      <p>{formatSize(used)} used · {formatSize(free)} free · {formatSize(total)} total</p>
    </article>
  );
}

export default function StoragePage({ user }: { user: User }) {
  const operator = user.role === 'owner' || user.role === 'admin';
  const [account, setAccount] = useState<AccountStorage | null>(null);
  const [server, setServer] = useState<ServerStorage | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    setError('');
    const accountRequest = api.accountStorage(controller.signal).then(setAccount);
    const serverRequest = operator
      ? api.serverStorage(controller.signal).then(setServer)
      : Promise.resolve();
    Promise.all([accountRequest, serverRequest]).catch((cause: unknown) => {
      if (!controller.signal.aborted) setError(friendlyError(cause));
    });
    return () => controller.abort();
  }, [operator]);

  const largest = account?.largest_files ?? [];
  const committed = account ? account.used_bytes + account.reserved_bytes : 0;

  return (
    <section className="storage-page">
      <header className="photos-heading">
        <div>
          <span className="eyebrow">CAPACITY</span>
          <h1>Storage</h1>
          <p>{operator ? 'Your quota, the largest files, and the disks this server is using.' : 'See what is using your space and where the largest files are.'}</p>
        </div>
      </header>
      {error && <div className="notice notice-error" role="alert"><span>{error}</span></div>}
      {!account && !error && <div className="storage-skeleton" role="status">Loading storage…</div>}
      {account && (
        <>
          <div className="storage-hero">
            <Donut used={account.used_bytes} reserved={account.reserved_bytes} total={account.quota_bytes} unlimited={account.unlimited} />
            <div className="storage-stats">
              <article><span>Used</span><strong>{formatSize(account.used_bytes)}</strong></article>
              <article><span>Available</span><strong>{account.available_bytes == null ? 'No limit' : formatSize(account.available_bytes)}</strong></article>
              <article><span>Total</span><strong>{account.quota_bytes == null ? 'Unlimited' : formatSize(account.quota_bytes)}</strong></article>
              <article><span>Uploading</span><strong>{formatSize(account.reserved_bytes)}</strong></article>
            </div>
          </div>
          <p className="storage-summary">
            {formatSize(committed)} is committed
            {account.quota_bytes != null ? ` of ${formatSize(account.quota_bytes)}` : ''}.
            {account.reserved_bytes > 0 ? ` ${formatSize(account.reserved_bytes)} is reserved by uploads still in progress.` : ''}
          </p>
          <div className="storage-panels">
            <article className="storage-card">
              <h2>By type</h2>
              <CategoryChart rows={account.by_category} />
            </article>
            <article className="storage-card">
              <h2>Largest files</h2>
              <LargestFiles files={largest} empty="No files are stored yet." />
            </article>
          </div>
          <div className="storage-actions">
            <button className="button button-secondary" type="button" onClick={() => navigateTo('/trash')}><Trash2 size={16} /> Review trash</button>
            <button className="button button-secondary" type="button" onClick={() => navigateTo('/photos')}><Images size={16} /> Open photos</button>
            <button className="button button-secondary" type="button" onClick={() => navigateTo('/drive')}><HardDrive size={16} /> Browse files</button>
          </div>
        </>
      )}
      {operator && server && (
        <div className="storage-admin">
          <h2>Server</h2>
          <div className="storage-panels">
            {server.ssd && <Meter label="SSD · app, database, index, cache" used={server.ssd.used_bytes} total={server.ssd.total_bytes} free={server.ssd.free_bytes} />}
            {server.hdd && <Meter label="HDD · original files" used={server.hdd.used_bytes} total={server.hdd.total_bytes} free={server.hdd.free_bytes} />}
          </div>
          <p className="storage-summary">
            System in use: {formatSize(server.system_used_bytes)}. Library data: {formatSize(server.library_bytes)}.
            {server.same_volume ? ' SSD and HDD readings are the same filesystem in this environment.' : ''}
          </p>
          <div className="storage-panels">
            <article className="storage-card">
              <h2>Library by type</h2>
              <CategoryChart rows={server.by_category} />
            </article>
            <article className="storage-card">
              <h2>Largest library files</h2>
              <LargestFiles files={server.largest_files ?? []} empty="The library has no indexed files yet." />
            </article>
          </div>
          <div className="table-card">
            <div className="table-head storage-grid"><span>Account</span><span>Used</span><span>Share of library</span><span>Share of HDD</span></div>
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
