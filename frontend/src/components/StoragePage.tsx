import { useEffect, useState } from 'react';
import { HardDrive } from 'lucide-react';
import { api } from '../api';
import { formatSize, friendlyError } from '../format';
import type { AccountStorage, ServerStorage, User } from '../types';

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

function Meter({ label, used, total, free }: { label: string; used: number; total: number; free: number }) {
  const percent = total > 0 ? Math.min(100, (used / total) * 100) : 0;
  return (
    <article className="volume-card">
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

  return (
    <section className="storage-page">
      <header className="photos-heading">
        <div>
          <span className="eyebrow">CAPACITY</span>
          <h1>Storage</h1>
          <p>{operator ? 'Server disks and how much of the library each account uses.' : 'How much of your quota is in use.'}</p>
        </div>
      </header>
      {error && <div className="notice notice-error" role="alert"><span>{error}</span></div>}
      {account && (
        <article className="volume-card">
          <header><span>Your files</span><strong>{account.percent_used == null ? 'Unlimited' : account.percent_used.toFixed(0) + '%'}</strong></header>
          {account.percent_used != null && <div className="quota-meter"><i style={{ width: Math.min(100, account.percent_used) + '%' }} /></div>}
          <p>
            {formatSize(account.used_bytes)} stored
            {account.quota_bytes != null ? ` of ${formatSize(account.quota_bytes)}` : ''}
            {account.reserved_bytes > 0 ? ` · ${formatSize(account.reserved_bytes)} reserved by uploads` : ''}
          </p>
          {account.by_category.length > 0 && (
            <ul className="category-list">
              {account.by_category.map((row) => (
                <li key={row.category}><span>{row.category}</span><strong>{formatSize(row.size_bytes)}</strong><small>{row.file_count} files</small></li>
              ))}
            </ul>
          )}
        </article>
      )}
      {operator && server && (
        <>
          <div className="volume-grid">
            {server.ssd && <Meter label="SSD · app, database, index, cache" used={server.ssd.used_bytes} total={server.ssd.total_bytes} free={server.ssd.free_bytes} />}
            {server.hdd && <Meter label="HDD · original files" used={server.hdd.used_bytes} total={server.hdd.total_bytes} free={server.hdd.free_bytes} />}
          </div>
          <p className="storage-system">
            System in use: {formatSize(server.system_used_bytes)}. Library data: {formatSize(server.library_bytes)}.
            {server.same_volume ? ' SSD and HDD readings are the same filesystem in this environment.' : ''}
          </p>
          <div className="table-card">
            <div className="table-head storage-grid"><span>Account</span><span>Used</span><span>Share of library</span><span>Share of HDD</span></div>
            {server.users.map((row) => (
              <div className="table-row storage-grid" key={row.id}>
                <span>{row.email}<small>{row.role}</small></span>
                <span>{formatSize(row.used_bytes)}</span>
                <span>{row.percent_of_library.toFixed(1)}%</span>
                <span>{row.percent_of_hdd == null ? '—' : row.percent_of_hdd.toFixed(1) + '%'}</span>
              </div>
            ))}
          </div>
          {server.by_category.length > 0 && (
            <ul className="category-list server-categories">
              {server.by_category.map((row) => (
                <li key={row.category}><span>{row.category}</span><strong>{formatSize(row.size_bytes)}</strong><small>{row.file_count} files</small></li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
