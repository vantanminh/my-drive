import { useEffect, useState, type FormEvent } from 'react';
import { Check, Copy, KeyRound, Plus, RefreshCw, Search, Shield, Trash2, UserRoundPlus, Users, X } from 'lucide-react';
import { api } from '../api';
import { formatDate, formatSize, friendlyError } from '../format';
import type { AccountStorage, ManagedAccount, User } from '../types';

type Props = { user: User; onClose: () => void };
type IssuedCredential = { email: string; password: string };

const GIB = 1024 ** 3;
const MAX_QUOTA_GB = 8_000_000_000_000_000 / GIB;

function quotaInGb(bytes: number): string {
  return (bytes / GIB).toFixed(2).replace(/\.00$/, '');
}

function quotaBytes(gigabytes: number): number {
  return Math.round(gigabytes * GIB);
}

function usagePercent(account: ManagedAccount): number {
  if (account.quotaBytes <= 0) return account.usedBytes + account.reservedBytes > 0 ? 100 : 0;
  return Math.min(100, ((account.usedBytes + account.reservedBytes) / account.quotaBytes) * 100);
}

export default function AccountManagementPanel({ user, onClose }: Props) {
  const [accounts, setAccounts] = useState<ManagedAccount[]>([]);
  const [ownerStorage, setOwnerStorage] = useState<AccountStorage | null>(null);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [email, setEmail] = useState('');
  const [newRole, setNewRole] = useState<'member' | 'admin'>('member');
  const [newQuotaGb, setNewQuotaGb] = useState('10');
  const [filterQuery, setFilterQuery] = useState('');
  const [filterRole, setFilterRole] = useState<'all' | 'admin' | 'member'>('all');
  const [filterStatus, setFilterStatus] = useState<'all' | 'active' | 'disabled'>('all');
  const [quotaDrafts, setQuotaDrafts] = useState<Record<string, string>>({});
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [issuedCredential, setIssuedCredential] = useState<IssuedCredential | null>(null);
  const [copiedCredential, setCopiedCredential] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    Promise.all([
      api.managedAccounts(0, controller.signal, {
        q: filterQuery.trim() || undefined,
        role: filterRole,
        status: filterStatus,
      }),
      api.accountStorage(controller.signal).catch(() => null),
    ])
      .then(([page, storage]) => {
        setAccounts(page.accounts);
        setNextOffset(page.nextOffset);
        setOwnerStorage(storage);
      })
      .catch((cause: unknown) => {
        if (!(cause instanceof DOMException && cause.name === 'AbortError')) setError(friendlyError(cause));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [refreshKey, filterQuery, filterRole, filterStatus]);

  async function createAccount(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedEmail = email.trim();
    const gigabytes = Number(newQuotaGb);
    if (!trimmedEmail || !Number.isFinite(gigabytes) || gigabytes < 0 || gigabytes > MAX_QUOTA_GB) {
      setError('Enter a valid email address and a quota between 0 GB and 7,450,580 GB.');
      return;
    }
    setBusyKey('create');
    setError('');
    setNotice('');
    try {
      const result = await api.createManagedAccount(trimmedEmail, quotaBytes(gigabytes), newRole);
      setRefreshKey((current) => current + 1);
      setIssuedCredential({ email: result.account.email, password: result.temporaryPassword });
      setCopiedCredential(false);
      setEmail('');
      setNewRole('member');
      setNewQuotaGb('10');
      setNotice('Account created. Share its temporary password securely.');
    } catch (cause: unknown) {
      setError(friendlyError(cause));
    } finally {
      setBusyKey(null);
    }
  }

  async function updateQuota(account: ManagedAccount) {
    const value = Number(quotaDrafts[account.id] ?? quotaInGb(account.quotaBytes));
    if (!Number.isFinite(value) || value < 0 || value > MAX_QUOTA_GB) {
      setError('Enter a quota between 0 GB and 7,450,580 GB.');
      return;
    }
    setBusyKey(account.id + ':quota');
    setError('');
    setNotice('');
    try {
      const bytes = quotaBytes(value);
      await api.updateManagedAccount(account.id, { quotaBytes: bytes });
      setAccounts((current) => current.map((item) => item.id === account.id ? { ...item, quotaBytes: bytes } : item));
      setQuotaDrafts((current) => ({ ...current, [account.id]: quotaInGb(bytes) }));
      setNotice('Storage quota updated for ' + account.email + '.');
    } catch (cause: unknown) {
      setError(friendlyError(cause));
    } finally {
      setBusyKey(null);
    }
  }

  async function updateOwnerQuota() {
    const defaultQuotaBytes = ownerStorage?.quota_bytes ?? 0;
    const value = Number(quotaDrafts[user.id] ?? quotaInGb(defaultQuotaBytes));
    if (!Number.isFinite(value) || value < 0 || value > MAX_QUOTA_GB) {
      setError('Enter a quota between 0 GB and 7,450,580 GB.');
      return;
    }
    setBusyKey(user.id + ':quota');
    setError('');
    setNotice('');
    try {
      const bytes = quotaBytes(value);
      await api.updateManagedAccount(user.id, { quotaBytes: bytes });
      const fresh = await api.accountStorage();
      setOwnerStorage(fresh);
      setQuotaDrafts((current) => ({ ...current, [user.id]: quotaInGb(fresh.quota_bytes ?? bytes) }));
      setNotice('Root account quota updated for ' + user.email + '.');
    } catch (cause: unknown) {
      setError(friendlyError(cause));
    } finally {
      setBusyKey(null);
    }
  }

  async function setDisabled(account: ManagedAccount) {
    const willDisable = !account.disabledAt;
    if (willDisable && !window.confirm('Disable ' + account.email + '? Their current sessions will be revoked.')) return;
    setBusyKey(account.id + ':status');
    setError('');
    setNotice('');
    try {
      await api.updateManagedAccount(account.id, { disabled: willDisable });
      setAccounts((current) => current.map((item) => item.id === account.id
        ? { ...item, disabledAt: willDisable ? new Date().toISOString() : null }
        : item));
      setNotice(willDisable ? 'Account disabled and sessions revoked.' : 'Account enabled.');
    } catch (cause: unknown) {
      setError(friendlyError(cause));
    } finally {
      setBusyKey(null);
    }
  }

  async function updateRole(account: ManagedAccount, role: 'admin' | 'member') {
    if (account.role === role) return;
    setBusyKey(account.id + ':role');
    setError('');
    setNotice('');
    try {
      await api.updateManagedAccount(account.id, { role });
      setAccounts((current) => current.map((item) => (item.id === account.id ? { ...item, role } : item)));
      setNotice('Updated role for ' + account.email + ' to ' + role + '.');
    } catch (cause: unknown) {
      setError(friendlyError(cause));
    } finally {
      setBusyKey(null);
    }
  }

  async function deleteAccount(account: ManagedAccount) {
    if (
      !window.confirm(
        'Permanently delete ' +
          account.email +
          '? Empty folders, sessions, and team memberships will be removed. Accounts that still own files cannot be deleted.'
      )
    ) {
      return;
    }
    setBusyKey(account.id + ':delete');
    setError('');
    setNotice('');
    try {
      await api.deleteManagedAccount(account.id);
      setAccounts((current) => current.filter((item) => item.id !== account.id));
      setNotice('Deleted account ' + account.email + '.');
    } catch (cause: unknown) {
      setError(friendlyError(cause));
    } finally {
      setBusyKey(null);
    }
  }

  async function resetPassword(account: ManagedAccount) {
    if (!window.confirm('Reset ' + account.email + '’s password? Their current sessions will be revoked.')) return;
    setBusyKey(account.id + ':password');
    setError('');
    setNotice('');
    try {
      const result = await api.resetManagedAccountPassword(account.id);
      setIssuedCredential({ email: account.email, password: result.temporaryPassword });
      setCopiedCredential(false);
      setNotice('Temporary password created. Share it securely; it will not be shown again after dismissal.');
    } catch (cause: unknown) {
      setError(friendlyError(cause));
    } finally {
      setBusyKey(null);
    }
  }

  async function loadMore() {
    if (nextOffset == null || loadingMore) return;
    setLoadingMore(true);
    setError('');
    try {
      const page = await api.managedAccounts(nextOffset, undefined, {
        q: filterQuery.trim() || undefined,
        role: filterRole,
        status: filterStatus,
      });
      setAccounts((current) => {
        const existing = new Set(current.map((account) => account.id));
        return [...current, ...page.accounts.filter((account) => !existing.has(account.id))];
      });
      setNextOffset(page.nextOffset);
    } catch (cause: unknown) {
      setError(friendlyError(cause));
    } finally {
      setLoadingMore(false);
    }
  }

  async function copyTemporaryPassword() {
    if (!issuedCredential) return;
    try {
      await navigator.clipboard.writeText(issuedCredential.password);
      setCopiedCredential(true);
      setError('');
    } catch {
      setError('Clipboard access is unavailable. Select and copy the temporary password manually.');
    }
  }

  return (
    <section className="account-admin-panel" id="account-admin-panel" aria-labelledby="account-admin-title">
      <div className="account-admin-header">
        <div>
          <span className="eyebrow">OWNER CONTROLS</span>
          <h2 id="account-admin-title">Managed accounts</h2>
          <p>Create private accounts, set storage limits, and control access.</p>
        </div>
        <div className="account-admin-header-actions">
          <button
            className="icon-button account-refresh"
            type="button"
            aria-label="Refresh account list"
            title="Refresh account list"
            disabled={loading || busyKey !== null}
            onClick={() => setRefreshKey((current) => current + 1)}
          ><RefreshCw size={16} /></button>
          <button className="icon-button media-index-close" type="button" aria-label="Close account management" onClick={onClose}><X size={17} /></button>
        </div>
      </div>

      <form className="account-create-form" onSubmit={(event) => void createAccount(event)}>
        <div className="account-create-intro">
          <span className="account-create-icon"><UserRoundPlus size={17} /></span>
          <span><strong>Add an account</strong><small>There is no public sign-up page.</small></span>
        </div>
        <label className="account-form-field account-email-field">
          <span>Email address</span>
          <input className="text-input" type="email" autoComplete="off" maxLength={254} required value={email} onChange={(event) => setEmail(event.target.value)} placeholder="person@example.com" />
        </label>
        <label className="account-form-field account-role-field">
          <span>Role</span>
          <select
            className="text-input"
            value={newRole}
            onChange={(event) => setNewRole(event.target.value === 'admin' ? 'admin' : 'member')}
            aria-label="New account role"
          >
            <option value="member">Member</option>
            <option value="admin">Admin</option>
          </select>
        </label>
        <label className="account-form-field account-quota-field">
          <span>Storage quota <small>GB</small></span>
          <input className="text-input" type="number" min="0" max={MAX_QUOTA_GB} step="0.01" required value={newQuotaGb} onChange={(event) => setNewQuotaGb(event.target.value)} />
        </label>
        <button className="button button-primary account-create-button" type="submit" disabled={busyKey !== null || issuedCredential !== null}>
          <Plus size={16} />{busyKey === 'create' ? 'Creating…' : 'Create account'}
        </button>
      </form>

      {issuedCredential && (
        <div className="account-secret" role="status" aria-live="polite">
          <div className="account-secret-mark"><KeyRound size={17} /></div>
          <div className="account-secret-copy">
            <strong>Temporary password for {issuedCredential.email}</strong>
            <small>Use this password to sign in. The user must choose a new password before the drive opens.</small>
            <code>{issuedCredential.password}</code>
          </div>
          <div className="account-secret-actions">
            <button className="button button-secondary" type="button" onClick={() => void copyTemporaryPassword()}>
              {copiedCredential ? <Check size={15} /> : <Copy size={15} />}{copiedCredential ? 'Copied' : 'Copy'}
            </button>
            <button className="icon-button" type="button" aria-label="Dismiss temporary password" onClick={() => { setIssuedCredential(null); setCopiedCredential(false); }}><X size={16} /></button>
          </div>
        </div>
      )}

      {error && <div className="account-admin-message account-admin-error" role="alert">{error}</div>}
      {notice && !error && <div className="account-admin-message account-admin-notice" role="status">{notice}</div>}

      {ownerStorage && (
        <article className="account-card account-owner-card">
          <div className="account-card-identity">
            <div className="account-card-avatar"><Shield size={17} /></div>
            <div className="account-card-name">
              <strong title={user.email}>{user.email}</strong>
              <span>Root / owner account</span>
            </div>
            <span className="account-status"><i />Owner</span>
          </div>
          <div className="account-card-storage">
            <div className="account-storage-label">
              <span>Storage</span>
              <strong>
                {formatSize(ownerStorage.used_bytes + ownerStorage.reserved_bytes)}{' '}
                <small>of {ownerStorage.quota_bytes == null ? 'Unlimited' : formatSize(ownerStorage.quota_bytes)}</small>
              </strong>
            </div>
            <div
              className="account-storage-track"
              role="progressbar"
              aria-label={'Storage used by ' + user.email}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(ownerStorage.percent_used ?? 0)}
            >
              <i style={{ width: Math.min(100, ownerStorage.percent_used ?? 0) + '%' }} />
            </div>
            <small>{formatSize(ownerStorage.used_bytes)} stored · {formatSize(ownerStorage.reserved_bytes)} uploading</small>
          </div>
          <div className="account-card-actions">
            {(() => {
              const currentOwnerQuota = ownerStorage.quota_bytes ?? 0;
              const ownerDraft = quotaDrafts[user.id] ?? quotaInGb(currentOwnerQuota);
              const parsedOwnerQuota = Number(ownerDraft);
              const ownerQuotaChanged = ownerStorage.quota_bytes == null
                ? Number.isFinite(parsedOwnerQuota)
                : Number.isFinite(parsedOwnerQuota) && quotaBytes(parsedOwnerQuota) !== currentOwnerQuota;
              return (
                <form className="account-quota-edit" onSubmit={(event) => { event.preventDefault(); void updateOwnerQuota(); }}>
                  <label htmlFor={'quota-' + user.id}>Quota <span>GB</span></label>
                  <input
                    id={'quota-' + user.id}
                    className="text-input"
                    type="number"
                    min="0"
                    max={MAX_QUOTA_GB}
                    step="0.01"
                    value={ownerDraft}
                    onChange={(event) => setQuotaDrafts((current) => ({ ...current, [user.id]: event.target.value }))}
                    aria-label={'Storage quota for ' + user.email + ' in gigabytes'}
                  />
                  <button className="button button-secondary" type="submit" disabled={!ownerQuotaChanged || busyKey !== null || issuedCredential !== null}>
                    {busyKey === user.id + ':quota' ? 'Saving…' : 'Save'}
                  </button>
                </form>
              );
            })()}
          </div>
        </article>
      )}

      <div className="account-admin-list-heading">
        <div><Users size={16} /><strong>Accounts</strong><span>{accounts.length}{nextOffset != null ? '+' : ''}</span></div>
        <span>Storage used includes active upload reservations</span>
      </div>

      <div className="account-filter-bar">
        <label className="account-filter-search" aria-label="Search accounts">
          <Search size={14} />
          <input
            type="search"
            value={filterQuery}
            onChange={(event) => setFilterQuery(event.target.value)}
            placeholder="Search by email..."
          />
        </label>
        <select
          className="account-role-select"
          aria-label="Filter by role"
          value={filterRole}
          onChange={(event) => setFilterRole(event.target.value as 'all' | 'member' | 'admin')}
        >
          <option value="all">All roles</option>
          <option value="member">Member</option>
          <option value="admin">Admin</option>
        </select>
        <select
          className="account-role-select"
          aria-label="Filter by status"
          value={filterStatus}
          onChange={(event) => setFilterStatus(event.target.value as 'all' | 'active' | 'disabled')}
        >
          <option value="all">All statuses</option>
          <option value="active">Active</option>
          <option value="disabled">Disabled</option>
        </select>
      </div>

      {loading ? (
        <div className="account-admin-loading"><span className="spinner" />Loading accounts…</div>
      ) : accounts.length === 0 ? (
        <div className="account-admin-empty"><Shield size={19} /><span>No child accounts yet. Create one above to give someone private access.</span></div>
      ) : (
        <div className="account-list">
          {accounts.map((account) => {
            const quotaValue = quotaDrafts[account.id] ?? quotaInGb(account.quotaBytes);
            const parsedQuota = Number(quotaValue);
            const quotaChanged = Number.isFinite(parsedQuota) && quotaBytes(parsedQuota) !== account.quotaBytes;
            const totalUsed = account.usedBytes + account.reservedBytes;
            const accountBusy = busyKey?.startsWith(account.id + ':') ?? false;
            return (
              <article className="account-card" key={account.id}>
                <div className="account-card-identity">
                  <div className="account-card-avatar"><Users size={17} /></div>
                  <div className="account-card-name">
                    <strong title={account.email}>{account.email}</strong>
                    <span>Created {formatDate(account.createdAt)}</span>
                  </div>
                  <span className={'account-role-pill' + (account.role === 'admin' ? ' is-admin' : '')}>
                    {account.role === 'admin' ? 'Admin' : 'Member'}
                  </span>
                  <span className={'account-status' + (account.disabledAt ? ' is-disabled' : '')}>
                    <i />{account.disabledAt ? 'Disabled' : 'Active'}
                  </span>
                </div>

                <div className="account-card-storage">
                  <div className="account-storage-label"><span>Storage</span><strong>{formatSize(totalUsed)} <small>of {formatSize(account.quotaBytes)}</small></strong></div>
                  <div className="account-storage-track" role="progressbar" aria-label={'Storage used by ' + account.email} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(usagePercent(account))}>
                    <i style={{ width: usagePercent(account) + '%' }} />
                  </div>
                  <small>{formatSize(account.usedBytes)} stored · {formatSize(account.reservedBytes)} uploading</small>
                </div>

                <div className="account-card-actions">
                  <form className="account-quota-edit" onSubmit={(event) => { event.preventDefault(); void updateQuota(account); }}>
                    <label htmlFor={'quota-' + account.id}>Quota <span>GB</span></label>
                    <input
                      id={'quota-' + account.id}
                      className="text-input"
                      type="number"
                      min="0"
                      max={MAX_QUOTA_GB}
                      step="0.01"
                      value={quotaValue}
                      onChange={(event) => setQuotaDrafts((current) => ({ ...current, [account.id]: event.target.value }))}
                      aria-label={'Storage quota for ' + account.email + ' in gigabytes'}
                    />
                    <button className="button button-secondary" type="submit" disabled={!quotaChanged || accountBusy || busyKey !== null || issuedCredential !== null}>
                      {busyKey === account.id + ':quota' ? 'Saving…' : 'Save'}
                    </button>
                  </form>
                  <div className="account-access-actions">
                    <select
                      className="account-role-select"
                      aria-label={'Role for ' + account.email}
                      value={account.role}
                      disabled={accountBusy || busyKey !== null || issuedCredential !== null}
                      onChange={(event) => void updateRole(account, event.target.value as 'member' | 'admin')}
                    >
                      <option value="member">Member</option>
                      <option value="admin">Admin</option>
                    </select>
                    <button className="button button-secondary" type="button" disabled={accountBusy || busyKey !== null || issuedCredential !== null} onClick={() => void resetPassword(account)}>
                      <KeyRound size={14} />{busyKey === account.id + ':password' ? 'Resetting…' : 'Reset password'}
                    </button>
                    <button className={account.disabledAt ? 'button button-secondary' : 'button button-quiet-danger'} type="button" disabled={accountBusy || busyKey !== null || issuedCredential !== null} onClick={() => void setDisabled(account)}>
                      {account.disabledAt ? 'Enable account' : 'Disable'}
                    </button>
                    <button
                      className="button button-quiet-danger"
                      type="button"
                      disabled={accountBusy || busyKey !== null || issuedCredential !== null}
                      onClick={() => void deleteAccount(account)}
                      title="Delete empty account"
                    >
                      <Trash2 size={14} />{busyKey === account.id + ':delete' ? 'Deleting…' : 'Delete'}
                    </button>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}

      {nextOffset != null && !loading && (
        <button className="button button-secondary account-load-more" type="button" disabled={loadingMore} onClick={() => void loadMore()}>
          {loadingMore ? 'Loading…' : 'Load more accounts'}
        </button>
      )}
    </section>
  );
}
