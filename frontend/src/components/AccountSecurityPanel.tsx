import { useEffect, useState } from 'react';
import { Clock3, KeyRound, Laptop, LogOut, Monitor, RefreshCw, ShieldCheck, Smartphone, X } from 'lucide-react';
import { api } from '../api';
import { friendlyError } from '../format';
import { useI18n } from '../i18n';
import type { BackupDevice, BrowserSession, User } from '../types';
import PasswordChangeForm from './PasswordChangeForm';

function formatSessionDate(value: string | null, fallback: string): string {
  if (!value) return fallback;
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

export default function AccountSecurityPanel({ user, onClose }: { user: User; onClose: () => void }) {
  const { t } = useI18n();
  const [sessions, setSessions] = useState<BrowserSession[] | null>(null);
  const [loadingSessions, setLoadingSessions] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);
  const [sessionError, setSessionError] = useState('');
  const [sessionNotice, setSessionNotice] = useState('');
  const [passwordNotice, setPasswordNotice] = useState('');
  const [busySessionId, setBusySessionId] = useState<string | null>(null);
  const [devices, setDevices] = useState<BackupDevice[] | null>(null);
  const [deviceError, setDeviceError] = useState('');
  const [busyDeviceId, setBusyDeviceId] = useState<string | null>(null);

  const notRecorded = t('security.not_recorded');

  useEffect(() => {
    const controller = new AbortController();
    setLoadingSessions(true);
    setSessionError('');
    api.listSessions(controller.signal)
      .then((result) => setSessions(result))
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setSessionError(friendlyError(cause));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoadingSessions(false);
      });
    return () => controller.abort();
  }, [reloadKey]);

  useEffect(() => {
    const controller = new AbortController();
    setDeviceError('');
    api.listDevices(controller.signal)
      .then((result) => setDevices(result.devices))
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setDeviceError(friendlyError(cause));
      });
    return () => controller.abort();
  }, [reloadKey]);

  async function revokeDevice(device: BackupDevice) {
    const label = device.name || t('security.this_device');
    if (!window.confirm(t('security.revoke_device_confirm', { name: label }))) return;
    setBusyDeviceId(device.id);
    setDeviceError('');
    try {
      await api.revokeDevice(device.id);
      setDevices((current) => current?.filter((item) => item.id !== device.id) ?? current);
      setSessionNotice(t('security.device_revoked'));
    } catch (cause: unknown) {
      setDeviceError(friendlyError(cause));
    } finally {
      setBusyDeviceId(null);
    }
  }

  async function revokeSession(session: BrowserSession) {
    setBusySessionId(session.id);
    setSessionError('');
    setSessionNotice('');
    try {
      await api.revokeSession(session.id);
      setSessions((current) => current?.filter((item) => item.id !== session.id) ?? current);
      setSessionNotice(t('security.session_revoked'));
    } catch (cause: unknown) {
      setSessionError(friendlyError(cause));
    } finally {
      setBusySessionId(null);
    }
  }

  async function revokeOtherSessions() {
    const otherCount = sessions?.filter((session) => !session.is_current).length ?? 0;
    if (!otherCount || !window.confirm(t('security.sign_out_others_confirm', { count: otherCount }))) return;

    setBusySessionId('others');
    setSessionError('');
    setSessionNotice('');
    try {
      await api.revokeOtherSessions();
      setSessions((current) => current?.filter((session) => session.is_current) ?? current);
      setSessionNotice(t('security.others_revoked'));
    } catch (cause: unknown) {
      setSessionError(friendlyError(cause));
    } finally {
      setBusySessionId(null);
    }
  }

  const otherSessionCount = sessions?.filter((session) => !session.is_current).length ?? 0;

  return (
    <section className="account-security-panel" id="account-security-panel" aria-labelledby="account-security-title">
      <div className="account-security-header">
        <div>
          <span className="eyebrow">{t('security.eyebrow')}</span>
          <h2 id="account-security-title">{t('security.title')}</h2>
          <p>{t('security.subtitle')}</p>
        </div>
        <button className="icon-button" type="button" onClick={onClose} aria-label={t('security.close')}>
          <X size={18} />
        </button>
      </div>

      <div className="account-security-grid">
        <section className="security-card" aria-labelledby="security-password-title">
          <div className="security-card-heading">
            <span className="security-card-icon"><KeyRound size={16} /></span>
            <div>
              <h3 id="security-password-title">{t('password.change')}</h3>
              <p>{t('password.signed_in_as', { email: user.email })}</p>
            </div>
          </div>
          {passwordNotice ? <div className="security-message security-message-success" role="status">{passwordNotice}</div> : null}
          <PasswordChangeForm
            currentPasswordLabel={t('password.current')}
            submitLabel={t('password.change')}
            onChanged={() => {
              setPasswordNotice(t('password.updated'));
              setReloadKey((current) => current + 1);
            }}
          />
        </section>

        <section className="security-card" aria-labelledby="security-sessions-title">
          <div className="security-card-heading security-sessions-heading">
            <span className="security-card-icon"><ShieldCheck size={16} /></span>
            <div>
              <h3 id="security-sessions-title">{t('security.sessions_title')}</h3>
              <p>{t('security.sessions_subtitle')}</p>
            </div>
          </div>

          <div className="security-session-toolbar">
            <span>{sessions ? t('security.sessions_count', { count: sessions.length }) : t('security.sessions_loading')}</span>
            <div>
              <button
                className="button button-secondary security-refresh"
                type="button"
                disabled={loadingSessions || busySessionId !== null}
                onClick={() => setReloadKey((current) => current + 1)}
              >
                <RefreshCw size={14} /> {t('security.refresh')}
              </button>
              {otherSessionCount > 0 ? (
                <button
                  className="button button-quiet-danger security-revoke-all"
                  type="button"
                  disabled={busySessionId !== null}
                  onClick={() => void revokeOtherSessions()}
                >
                  <LogOut size={14} /> {t('security.sign_out_others')}
                </button>
              ) : null}
            </div>
          </div>

          {sessionError ? <div className="security-message security-message-error" role="alert">{sessionError}</div> : null}
          {sessionNotice ? <div className="security-message security-message-success" role="status">{sessionNotice}</div> : null}
          {loadingSessions ? (
            <div className="security-session-empty"><span className="spinner" /> {t('security.loading_sessions')}</div>
          ) : sessions === null ? (
            <div className="security-session-empty">{t('security.sessions_error')}</div>
          ) : sessions?.length ? (
            <div className="security-session-list">
              {sessions.map((session) => {
                const isMobile = session.client_type === 'mobile';
                const label = session.device_label?.trim()
                  || (isMobile
                    ? t('security.mobile_app')
                    : session.is_current
                      ? t('security.this_browser')
                      : t('security.web_browser'));
                return (
                  <article className="security-session" key={session.id}>
                    <div className="security-session-main">
                      <div className="security-session-name">
                        <span className="security-session-device">
                          {isMobile ? <Smartphone size={16} /> : <Monitor size={16} />}
                        </span>
                        <strong title={session.user_agent ?? label}>{label}</strong>
                        {session.is_current ? <span className="security-current-badge">{t('security.current_badge')}</span> : null}
                        <span className="security-client-badge">{isMobile ? t('security.mobile_badge') : t('security.web_badge')}</span>
                      </div>
                      <div className="security-session-details">
                        <span><Clock3 size={13} /> {t('security.last_active', { time: formatSessionDate(session.last_seen_at ?? session.created_at, notRecorded) })}</span>
                        {session.ip_address ? <span>IP {session.ip_address}</span> : null}
                        <span>{t('security.signed_in', { time: formatSessionDate(session.created_at, notRecorded) })}</span>
                        <span>{t('security.expires', { time: formatSessionDate(session.expires_at, notRecorded) })}</span>
                      </div>
                    </div>
                    {!session.is_current ? (
                      <button
                        className="button button-quiet-danger security-session-revoke"
                        type="button"
                        disabled={busySessionId !== null}
                        onClick={() => void revokeSession(session)}
                      >
                        <LogOut size={14} /> {busySessionId === session.id ? t('password.signing_out') : t('security.sign_out_session')}
                      </button>
                    ) : null}
                  </article>
                );
              })}
            </div>
          ) : (
            <div className="security-session-empty">{t('security.no_sessions')}</div>
          )}
        </section>
      </div>

      <section className="security-card backup-devices-card" aria-labelledby="backup-devices-title">
        <div className="security-card-heading">
          <span className="security-card-icon"><Laptop size={16} /></span>
          <div>
            <h3 id="backup-devices-title">{t('security.devices_title')}</h3>
            <p>{t('security.devices_subtitle')}</p>
          </div>
        </div>
        {deviceError ? <div className="security-message security-message-error" role="alert">{deviceError}</div> : null}
        {devices === null ? (
          <div className="security-session-empty"><span className="spinner" /> {t('security.loading_devices')}</div>
        ) : devices.length === 0 ? (
          <div className="security-session-empty">{t('security.no_devices')}</div>
        ) : (
          <div className="security-session-list">
            {devices.map((device) => (
              <article className="security-session" key={device.id}>
                <div className="security-session-main">
                  <div className="security-session-name">
                    <span className="security-session-device"><Laptop size={16} /></span>
                    <strong>{device.name}</strong>
                  </div>
                  <div className="security-session-details">
                    <span>{device.operating_system} · {device.client_name} {device.client_version}</span>
                    <span><Clock3 size={13} /> {t('security.last_active', { time: formatSessionDate(device.last_active_at, notRecorded) })}</span>
                    <span>{t('security.added', { time: formatSessionDate(device.created_at, notRecorded) })}</span>
                    {device.last_ip ? <span>IP {device.last_ip}</span> : null}
                    <span>{t('security.permissions', { list: device.permissions.join(', ') || t('security.permissions_default') })}</span>
                  </div>
                </div>
                <button
                  className="button button-quiet-danger security-session-revoke"
                  type="button"
                  disabled={busyDeviceId !== null}
                  onClick={() => void revokeDevice(device)}
                >
                  {busyDeviceId === device.id ? t('security.revoking') : t('security.revoke')}
                </button>
              </article>
            ))}
          </div>
        )}
      </section>
    </section>
  );
}
