import { useEffect, useState, type FormEvent } from 'react';
import {
  Activity,
  ArrowUpCircle,
  CheckCircle2,
  Cpu,
  ExternalLink,
  HardDriveDownload,
  RefreshCw,
  RotateCw,
  Server,
  ShieldCheck,
  Terminal,
  X
} from 'lucide-react';
import { api } from '../api';
import { formatDate, formatSize, friendlyError } from '../format';
import type { HostOverview, SystemUpdatesStatus } from '../types';

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

function formatUptime(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds)) return '—';
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h ${mins}m`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
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
  const [overview, setOverview] = useState<HostOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [waitingReconnect, setWaitingReconnect] = useState(false);

  const [autoCheckEnabled, setAutoCheckEnabled] = useState(true);
  const [autoUpdateEnabled, setAutoUpdateEnabled] = useState(false);
  const [checkIntervalMinutes, setCheckIntervalMinutes] = useState(60);

  const [logService, setLogService] = useState<string>('app');
  const [logLines, setLogLines] = useState<string[] | null>(null);
  const [loadingLogs, setLoadingLogs] = useState(false);

  function applySnapshot(snapshot: SystemUpdatesStatus) {
    setData(snapshot);
    setAutoCheckEnabled(snapshot.settings.autoCheckEnabled);
    setAutoUpdateEnabled(snapshot.settings.autoUpdateEnabled);
    setCheckIntervalMinutes(snapshot.settings.checkIntervalMinutes);
    onStatusChange?.(snapshot);
  }

  async function loadOverview(signal?: AbortSignal) {
    try {
      const host = await api.hostOverview(signal);
      setOverview(host);
    } catch {
      if (!signal?.aborted) setOverview(null);
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    api
      .updatesStatus(controller.signal)
      .then((snapshot) => {
        applySnapshot(snapshot);
        if (snapshot.hostUpdater.connected) {
          void loadOverview(controller.signal);
        }
      })
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
      if (snapshot.hostUpdater.connected) {
        await loadOverview();
      } else {
        setOverview(null);
      }
    } catch (cause: unknown) {
      setError(friendlyError(cause));
    } finally {
      setBusyAction(null);
    }
  }

  async function restartService(service: string) {
    if (!window.confirm(`Restart host service "${service}"?`)) return;
    setBusyAction('restart:' + service);
    setError('');
    setNotice('');
    try {
      const res = await api.restartHostService(service);
      setNotice(res.message);
      window.setTimeout(() => {
        void loadOverview();
      }, 2000);
    } catch (cause: unknown) {
      setError(friendlyError(cause));
    } finally {
      setBusyAction(null);
    }
  }

  async function fetchLogs(serviceName: string) {
    setLoadingLogs(true);
    setLogService(serviceName);
    setError('');
    try {
      const res = await api.hostServiceLogs(serviceName, 120);
      setLogLines(res.lines);
    } catch (cause: unknown) {
      setError(friendlyError(cause));
    } finally {
      setLoadingLogs(false);
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

          {overview ? (
            <>
              <div className="security-card">
                <div className="security-card-heading">
                  <span className="security-card-icon"><Cpu size={17} /></span>
                  <div>
                    <h3>Host telemetry &amp; MyNAS core</h3>
                    <p>
                      <code>{overview.hostname}</code> · {overview.osName} ({overview.arch}, kernel {overview.kernel})
                    </p>
                  </div>
                </div>
                <dl className="system-update-facts">
                  <div>
                    <dt>Uptime</dt>
                    <dd>{formatUptime(overview.uptimeSeconds)}</dd>
                  </div>
                  <div>
                    <dt>CPU</dt>
                    <dd>
                      {overview.cpuUsagePercent != null ? `${overview.cpuUsagePercent}%` : '—'} · {overview.cpuCores} cores
                      {overview.loadAverage.length > 0 ? ` (load ${overview.loadAverage.join(', ')})` : ''}
                    </dd>
                  </div>
                  <div>
                    <dt>Memory</dt>
                    <dd>
                      {formatSize(overview.memory.usedBytes)} / {formatSize(overview.memory.totalBytes)}
                    </dd>
                  </div>
                  <div>
                    <dt>System services</dt>
                    <dd>
                      <code>my-drive</code>: {overview.core.myDriveService} · <code>my-drive-updater</code>:{' '}
                      {overview.core.updaterService}
                    </dd>
                  </div>
                  <div>
                    <dt>Access &amp; LAN</dt>
                    <dd>
                      TLS: <code>{overview.core.tlsMode || 'unknown'}</code> · LAN:{' '}
                      {overview.core.lanEnabled
                        ? `${overview.core.lanBind || '0.0.0.0'}:${overview.core.lanPort}`
                        : 'Disabled'}
                    </dd>
                  </div>
                </dl>
                {overview.disks.length > 0 ? (
                  <div className="system-update-host-state">
                    {overview.disks.map((disk) => (
                      <small key={disk.path}>
                        <strong>{disk.label}</strong> (<code>{disk.path}</code>): {formatSize(disk.usedBytes)} /{' '}
                        {formatSize(disk.totalBytes)} ({disk.percentUsed}% used · {formatSize(disk.freeBytes)} free)
                      </small>
                    ))}
                  </div>
                ) : null}
              </div>

              <div className="security-card">
                <div className="security-card-heading">
                  <span className="security-card-icon"><Activity size={17} /></span>
                  <div>
                    <h3>Container &amp; host services</h3>
                    <p>Inspect container health, restart individual services, or stream recent logs.</p>
                  </div>
                </div>
                <div className="system-update-host-state">
                  {overview.services.map((svc) => (
                    <div
                      key={svc.name || svc.service}
                      style={{
                        display: 'flex',
                        flexWrap: 'wrap',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: '8px',
                        padding: '8px 0',
                        borderBottom: '1px solid var(--line, #e6ece9)'
                      }}
                    >
                      <div>
                        <strong>{svc.service}</strong>{' '}
                        <span
                          className={
                            svc.state === 'running'
                              ? 'system-update-badge system-update-badge-ok'
                              : 'system-update-badge system-update-badge-warn'
                          }
                        >
                          {svc.health ? `${svc.state} (${svc.health})` : svc.state}
                        </span>
                        <br />
                        <small>{svc.status}</small>
                      </div>
                      <div className="system-update-actions" style={{ marginTop: 0 }}>
                        <button
                          className="button button-secondary"
                          type="button"
                          disabled={loadingLogs}
                          onClick={() => void fetchLogs(svc.service)}
                        >
                          <Terminal size={13} /> Logs
                        </button>
                        <button
                          className="button button-secondary"
                          type="button"
                          disabled={busyAction !== null}
                          onClick={() => void restartService(svc.service)}
                        >
                          <RotateCw size={13} /> {busyAction === 'restart:' + svc.service ? 'Restarting…' : 'Restart'}
                        </button>
                      </div>
                    </div>
                  ))}
                  {overview.services.length === 0 ? <small>No containers reported by Docker Compose.</small> : null}
                </div>

                <div className="system-update-actions" style={{ marginTop: '12px', alignItems: 'center' }}>
                  <select
                    className="text-input"
                    aria-label="Log source service"
                    value={logService}
                    onChange={(event) => void fetchLogs(event.target.value)}
                    style={{ maxWidth: '220px' }}
                  >
                    <option value="all">all containers</option>
                    <option value="updater">my-drive-updater.service</option>
                    {overview.services.map((svc) => (
                      <option key={svc.service} value={svc.service}>
                        {svc.service}
                      </option>
                    ))}
                  </select>
                  <button
                    className="button button-secondary"
                    type="button"
                    disabled={loadingLogs}
                    onClick={() => void fetchLogs(logService)}
                  >
                    <Terminal size={14} /> {loadingLogs ? 'Loading logs…' : 'Load recent logs'}
                  </button>
                  <button
                    className="button button-secondary"
                    type="button"
                    disabled={busyAction !== null}
                    onClick={() => void restartService('all')}
                  >
                    <RotateCw size={14} /> Restart stack
                  </button>
                </div>

                {logLines ? (
                  <details className="system-update-notes" open style={{ marginTop: '10px' }}>
                    <summary>Recent logs: {logService} ({logLines.length} lines)</summary>
                    <pre style={{ maxHeight: '280px', overflow: 'auto', fontSize: '11.5px' }}>
                      {logLines.length > 0 ? logLines.join('\n') : '(no log output)'}
                    </pre>
                  </details>
                ) : null}
              </div>
            </>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
