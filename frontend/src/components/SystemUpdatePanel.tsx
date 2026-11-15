import { useEffect, useState, type FormEvent } from 'react';
import {
  ArrowUpCircle,
  CheckCircle2,
  ExternalLink,
  HardDriveDownload,
  RefreshCw,
  Server,
  ShieldCheck,
  X
} from 'lucide-react';
import { api } from '../api';
import { formatDate, friendlyError } from '../format';
import type { SystemUpdatesStatus } from '../types';

type Props = {
  onClose: () => void;
  onStatusChange?: (status: SystemUpdatesStatus) => void;
};

const INTERVAL_OPTIONS = [
  { value: 15, label: 'Every 15 minutes' },
  { value: 60, label: 'Every hour' },
  { value: 360, label: 'Every 6 hours' },
  { value: 1440, label: 'Every 24 hours' }
];

function shortSha(sha: string | null | undefined): string {
  if (!sha) return '—';
  return sha.slice(0, 7);
}

function updaterPhaseLabel(status: SystemUpdatesStatus['hostUpdater']): string {
  if (!status.connected) return 'Host updater unavailable';
  if (status.status === 'running') {
    switch (status.phase) {
      case 'pulling':
        return 'Downloading & verifying images';
      case 'restarting':
        return 'Restarting services & verifying health';
      case 'verifying':
        return 'Finalizing verification';
      default:
        return 'Update in progress';
    }
  }
  if (status.status === 'succeeded') return 'Last update succeeded';
  if (status.status === 'failed') return 'Last update failed';
  return 'Ready';
}

export default function SystemUpdatePanel({ onClose, onStatusChange }: Props) {
  const [data, setData] = useState<SystemUpdatesStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [waitingReconnect, setWaitingReconnect] = useState(false);

  const [autoCheckEnabled, setAutoCheckEnabled] = useState(true);
  const [autoUpdateEnabled, setAutoUpdateEnabled] = useState(false);
  const [checkIntervalMinutes, setCheckIntervalMinutes] = useState(60);

  function applySnapshot(snapshot: SystemUpdatesStatus) {
    setData(snapshot);
    setAutoCheckEnabled(snapshot.settings.autoCheckEnabled);
    setAutoUpdateEnabled(snapshot.settings.autoUpdateEnabled);
    setCheckIntervalMinutes(snapshot.settings.checkIntervalMinutes);
    onStatusChange?.(snapshot);
  }

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    api
      .updatesStatus(controller.signal)
      .then((snapshot) => applySnapshot(snapshot))
      .catch((cause: unknown) => {
        if (!(cause instanceof DOMException && cause.name === 'AbortError')) {
          setError(friendlyError(cause));
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, []);

  const isRunning = data?.hostUpdater.status === 'running' || waitingReconnect;

  useEffect(() => {
    if (!isRunning) return;
    let cancelled = false;
    const timer = window.setInterval(async () => {
      try {
        const snapshot = await api.updatesStatus();
        if (cancelled) return;
        setWaitingReconnect(false);
        setError('');
        applySnapshot(snapshot);
        if (snapshot.hostUpdater.status === 'succeeded') {
          setNotice(snapshot.hostUpdater.message || 'My Drive has been updated and verified.');
        } else if (snapshot.hostUpdater.status === 'failed') {
          setError(snapshot.hostUpdater.message || 'Host update failed. Inspect host logs for details.');
        }
      } catch {
        if (cancelled) return;
        // Brief connection interruption is expected while `docker compose up` recreates `app`.
        setWaitingReconnect(true);
      }
    }, 2500);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [isRunning]);

  async function refreshStatus() {
    setBusyAction('refresh');
    setError('');
    try {
      const snapshot = await api.updatesStatus();
      setWaitingReconnect(false);
      applySnapshot(snapshot);
    } catch (cause: unknown) {
      setError(friendlyError(cause));
    } finally {
      setBusyAction(null);
    }
  }

  async function checkUpdates() {
    setBusyAction('check');
    setError('');
    setNotice('');
    try {
      const snapshot = await api.checkForUpdates();
      applySnapshot(snapshot);
      if (snapshot.latest.updateAvailable && snapshot.latest.tag) {
        setNotice(`New release available: ${snapshot.latest.tag}`);
      } else if (snapshot.latest.tag) {
        setNotice(`You are running the latest release (${snapshot.latest.tag}).`);
      } else {
        setNotice('Checked GitHub: no releases or tags published yet.');
      }
    } catch (cause: unknown) {
      setError(friendlyError(cause));
    } finally {
      setBusyAction(null);
    }
  }

  async function saveAutomationSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusyAction('settings');
    setError('');
    setNotice('');
    try {
      const snapshot = await api.updateUpdateSettings({
        autoCheckEnabled,
        autoUpdateEnabled,
        checkIntervalMinutes
      });
      applySnapshot(snapshot);
      setNotice('Update automation settings saved.');
    } catch (cause: unknown) {
      setError(friendlyError(cause));
    } finally {
      setBusyAction(null);
    }
  }

  async function triggerUpdate() {
    setBusyAction('apply');
    setError('');
    setNotice('');
    try {
      const snapshot = await api.applySystemUpdate(data?.latest.tag ?? null);
      applySnapshot(snapshot);
      setNotice(
        snapshot.hostUpdater.message ||
          'Update started. Container rollout is running on the host.'
      );
    } catch (cause: unknown) {
      setError(friendlyError(cause));
    } finally {
      setBusyAction(null);
    }
  }

  const updateAvailable = Boolean(data?.latest.updateAvailable);
  const canApplyUpdate =
    Boolean(data?.hostUpdater.connected) &&
    !isRunning &&
    busyAction === null;

  return (
    <section className="account-security-panel" id="system-update-panel" aria-labelledby="system-update-title">
      <div className="account-security-header">
        <div>
          <span className="eyebrow">OWNER CONTROLS</span>
          <h2 id="system-update-title">System updates</h2>
          <p>
            Track GitHub releases, check manually or on a schedule, and roll out verified container updates.
          </p>
        </div>
        <div className="account-admin-header-actions">
          <button
            className="icon-button account-refresh"
            type="button"
            aria-label="Refresh update status"
            title="Refresh update status"
            disabled={loading || busyAction !== null}
            onClick={() => void refreshStatus()}
          >
            <RefreshCw size={16} />
          </button>
          <button className="icon-button media-index-close" type="button" aria-label="Close system updates" onClick={onClose}>
            <X size={17} />
          </button>
        </div>
      </div>

      {error ? <div className="security-message security-message-error" role="alert">{error}</div> : null}
      {notice ? <div className="security-message security-message-success" role="status">{notice}</div> : null}

      {isRunning ? (
        <div className="system-update-progress" role="status" aria-live="polite">
          <div className="spinner" />
          <div>
            <strong>
              {waitingReconnect
                ? 'Restarting My Drive… waiting for the updated server to come back online'
                : updaterPhaseLabel(data!.hostUpdater)}
            </strong>
            <small>
              {data?.hostUpdater.message || 'Pulling verified images and restarting services.'}
            </small>
          </div>
        </div>
      ) : null}

      {loading && !data ? (
        <div className="security-session-empty">
          <div className="spinner" /> Loading update status…
        </div>
      ) : data ? (
        <div className="account-security-grid">
          <div className="security-card">
            <div className="security-card-heading">
              <span className="security-card-icon"><ArrowUpCircle size={17} /></span>
              <div>
                <h3>Version &amp; release status</h3>
                <p>Repository: <code>{data.githubRepo}</code></p>
              </div>
            </div>

            <dl className="system-update-facts">
              <div>
                <dt>Running version</dt>
                <dd>
                  <code>{data.current.version}</code>
                  {data.current.commitSha ? <small> ({shortSha(data.current.commitSha)})</small> : null}
                </dd>
              </div>
              {data.current.buildTime ? (
                <div>
                  <dt>Built at</dt>
                  <dd>{formatDate(data.current.buildTime)}</dd>
                </div>
              ) : null}
              <div>
                <dt>Latest on GitHub</dt>
                <dd>
                  {data.latest.tag ? (
                    <span className="system-update-tag-row">
                      <code>{data.latest.tag}</code>
                      {data.latest.commitSha ? <small>({shortSha(data.latest.commitSha)})</small> : null}
                      {data.latest.url ? (
                        <a href={data.latest.url} target="_blank" rel="noreferrer noopener" title="Open GitHub release">
                          <ExternalLink size={12} />
                        </a>
                      ) : null}
                    </span>
                  ) : (
                    <span>Not checked or no release yet</span>
                  )}
                </dd>
              </div>
              <div>
                <dt>Status</dt>
                <dd>
                  {updateAvailable ? (
                    <span className="system-update-badge system-update-badge-warn">Update available</span>
                  ) : data.latest.tag ? (
                    <span className="system-update-badge system-update-badge-ok">
                      <CheckCircle2 size={12} /> Up to date
                    </span>
                  ) : (
                    <span>Unknown</span>
                  )}
                </dd>
              </div>
              {data.check.lastCheckedAt ? (
                <div>
                  <dt>Last checked</dt>
                  <dd>
                    {formatDate(data.check.lastCheckedAt)}
                    {data.check.status === 'error' && data.check.error ? ` — ${data.check.error}` : ''}
                  </dd>
                </div>
              ) : null}
            </dl>

            {data.latest.notes ? (
              <details className="system-update-notes">
                <summary>Release notes ({data.latest.tag})</summary>
                <pre>{data.latest.notes}</pre>
              </details>
            ) : null}

            <div className="system-update-actions">
              <button
                className="button button-secondary"
                type="button"
                disabled={busyAction !== null}
                onClick={() => void checkUpdates()}
              >
                <RefreshCw size={15} /> {busyAction === 'check' ? 'Checking…' : 'Check for updates'}
              </button>
              <button
                className="button button-primary"
                type="button"
                disabled={!canApplyUpdate || (!updateAvailable && Boolean(data.latest.tag))}
                onClick={() => void triggerUpdate()}
              >
                <HardDriveDownload size={15} />{' '}
                {busyAction === 'apply'
                  ? 'Starting update…'
                  : updateAvailable && data.latest.tag
                    ? `Update to ${data.latest.tag}`
                    : 'Install update'}
              </button>
            </div>
          </div>

          <div className="system-update-stack">
            <div className="security-card">
              <div className="security-card-heading">
                <span className="security-card-icon"><ShieldCheck size={17} /></span>
                <div>
                  <h3>Check &amp; auto-update policy</h3>
                  <p>Control periodic GitHub checks and whether verified releases install automatically.</p>
                </div>
              </div>

              <form className="system-update-form" onSubmit={(event) => void saveAutomationSettings(event)}>
                <label className="system-update-toggle">
                  <input
                    type="checkbox"
                    checked={autoCheckEnabled}
                    onChange={(event) => setAutoCheckEnabled(event.target.checked)}
                  />
                  <span>
                    <strong>Automatically check GitHub for new tags</strong>
                    <small>Polls GitHub releases in the background without restarting My Drive.</small>
                  </span>
                </label>

                <label className="account-form-field">
                  <span>Check interval</span>
                  <select
                    className="text-input"
                    value={checkIntervalMinutes}
                    disabled={!autoCheckEnabled}
                    onChange={(event) => setCheckIntervalMinutes(Number(event.target.value))}
                  >
                    {INTERVAL_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="system-update-toggle">
                  <input
                    type="checkbox"
                    checked={autoUpdateEnabled}
                    onChange={(event) => setAutoUpdateEnabled(event.target.checked)}
                  />
                  <span>
                    <strong>Auto-update when a new release is detected</strong>
                    <small>
                      Requires an active host updater. Briefly restarts the service (~15–30s) when applying an
                      update.
                    </small>
                  </span>
                </label>

                <button className="button button-secondary" type="submit" disabled={busyAction !== null}>
                  {busyAction === 'settings' ? 'Saving…' : 'Save schedule settings'}
                </button>
              </form>
            </div>

            <div className="security-card">
              <div className="security-card-heading">
                <span className="security-card-icon"><Server size={17} /></span>
                <div>
                  <h3>Host updater</h3>
                  <p>
                    {data.hostUpdater.connected
                      ? `Host bridge connected (${updaterPhaseLabel(data.hostUpdater)}).`
                      : 'Host bridge is offline. Run `sudo my-drive update` once on your VPS to enable one-click dashboard updates.'}
                  </p>
                </div>
              </div>

              {data.hostUpdater.connected ? (
                <div className="system-update-host-state">
                  {data.hostUpdater.imageTrack ? (
                    <span>
                      Image track: <code>{data.hostUpdater.imageTrack}</code>
                    </span>
                  ) : null}
                  {data.hostUpdater.finishedAt ? (
                    <small>
                      Last host job ({data.hostUpdater.status}): {formatDate(data.hostUpdater.finishedAt)}
                      {data.hostUpdater.message ? ` — ${data.hostUpdater.message}` : ''}
                    </small>
                  ) : null}
                </div>
              ) : (
                <div className="system-update-cli-hint">
                  <small>
                    On your VPS, running <code>sudo my-drive update</code> once upgrades the Compose configuration and
                    enables <code>my-drive-updater.service</code> for dashboard updates.
                  </small>
                </div>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
