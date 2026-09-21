import { useEffect, useState, type FormEvent } from 'react';
import { Check, Copy, KeyRound, Plus, RefreshCw, Shield, UserRoundPlus, Users, X } from 'lucide-react';
import { api } from '../api';
import { formatDate, formatSize, friendlyError } from '../format';
import type { ManagedAccount } from '../types';

type Props = { onClose: () => void };
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

export default function AccountManagementPanel({ onClose }: Props) {
  const [accounts, setAccounts] = useState<ManagedAccount[]>([]);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [email, setEmail] = useState('');
  const [newQuotaGb, setNewQuotaGb] = useState('10');
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
    api.managedAccounts(0, controller.signal)
      .then((page) => {
        setAccounts(page.accounts);
        setNextOffset(page.nextOffset);
      })
      .catch((cause: unknown) => {
        if (!(cause instanceof DOMException && cause.name === 'AbortError')) setError(friendlyError(cause));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [refreshKey]);

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
      const result = await api.createManagedAccount(trimmedEmail, quotaBytes(gigabytes));
      setRefreshKey((current) => current + 1);
      setIssuedCredential({ email: result.account.email, password: result.temporaryPassword });
      setCopiedCredential(false);
      setEmail('');
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
      const page = await api.managedAccounts(nextOffset);
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

      <div className="account-admin-list-heading">
        <div><Users size={16} /><strong>Accounts</strong><span>{accounts.length}{nextOffset != null ? '+' : ''}</span></div>
        <span>Storage used includes active upload reservations</span>
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
                    <button className="button button-secondary" type="button" disabled={accountBusy || busyKey !== null || issuedCredential !== null} onClick={() => void resetPassword(account)}>
                      <KeyRound size={14} />{busyKey === account.id + ':password' ? 'Resetting…' : 'Reset password'}
                    </button>
                    <button className={account.disabledAt ? 'button button-secondary' : 'button button-quiet-danger'} type="button" disabled={accountBusy || busyKey !== null || issuedCredential !== null} onClick={() => void setDisabled(account)}>
                      {account.disabledAt ? 'Enable account' : 'Disable'}
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
