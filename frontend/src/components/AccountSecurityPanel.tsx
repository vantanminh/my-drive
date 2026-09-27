import { useEffect, useState } from 'react';
import { Clock3, KeyRound, LogOut, Monitor, RefreshCw, ShieldCheck, Smartphone, X } from 'lucide-react';
import { api } from '../api';
import { friendlyError } from '../format';
import type { BrowserSession, User } from '../types';
import PasswordChangeForm from './PasswordChangeForm';

function formatSessionDate(value: string | null): string {
  if (!value) return 'Not recorded';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

export default function AccountSecurityPanel({ user, onClose }: { user: User; onClose: () => void }) {
  const [sessions, setSessions] = useState<BrowserSession[] | null>(null);
  const [loadingSessions, setLoadingSessions] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);
  const [sessionError, setSessionError] = useState('');
  const [sessionNotice, setSessionNotice] = useState('');
  const [passwordNotice, setPasswordNotice] = useState('');
  const [busySessionId, setBusySessionId] = useState<string | null>(null);

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

  async function revokeSession(session: BrowserSession) {
    setBusySessionId(session.id);
    setSessionError('');
    setSessionNotice('');
    try {
      await api.revokeSession(session.id);
      setSessions((current) => current?.filter((item) => item.id !== session.id) ?? current);
      setSessionNotice('That session has been signed out.');
    } catch (cause: unknown) {
      setSessionError(friendlyError(cause));
    } finally {
      setBusySessionId(null);
    }
  }

  async function revokeOtherSessions() {
    const otherCount = sessions?.filter((session) => !session.is_current).length ?? 0;
    if (!otherCount || !window.confirm(`Sign out of ${otherCount} other session${otherCount === 1 ? '' : 's'}?`)) return;

    setBusySessionId('others');
    setSessionError('');
    setSessionNotice('');
    try {
      await api.revokeOtherSessions();
      setSessions((current) => current?.filter((session) => session.is_current) ?? current);
      setSessionNotice('All other sessions have been signed out.');
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
          <span className="eyebrow">ACCOUNT</span>
          <h2 id="account-security-title">Security</h2>
          <p>Change your password and manage where your account is signed in.</p>
        </div>
        <button className="icon-button" type="button" onClick={onClose} aria-label="Close account security">
          <X size={18} />
        </button>
      </div>

      <div className="account-security-grid">
        <section className="security-card" aria-labelledby="security-password-title">
          <div className="security-card-heading">
            <span className="security-card-icon"><KeyRound size={16} /></span>
            <div>
              <h3 id="security-password-title">Change password</h3>
              <p>Signed in as {user.email}</p>
            </div>
          </div>
          {passwordNotice ? <div className="security-message security-message-success" role="status">{passwordNotice}</div> : null}
          <PasswordChangeForm
            currentPasswordLabel="Current password"
            submitLabel="Change password"
            onChanged={() => {
              setPasswordNotice('Password updated. Other signed-in sessions have been signed out.');
              setReloadKey((current) => current + 1);
            }}
          />
        </section>

        <section className="security-card" aria-labelledby="security-sessions-title">
          <div className="security-card-heading security-sessions-heading">
            <span className="security-card-icon"><ShieldCheck size={16} /></span>
            <div>
              <h3 id="security-sessions-title">Signed-in sessions</h3>
              <p>Review active sessions and sign out any you do not recognize.</p>
            </div>
          </div>

          <div className="security-session-toolbar">
            <span>{sessions ? `${sessions.length} active session${sessions.length === 1 ? '' : 's'}` : 'Active sessions'}</span>
            <div>
              <button
                className="button button-secondary security-refresh"
                type="button"
                disabled={loadingSessions || busySessionId !== null}
                onClick={() => setReloadKey((current) => current + 1)}
              >
                <RefreshCw size={14} /> Refresh
              </button>
              {otherSessionCount > 0 ? (
                <button
                  className="button button-quiet-danger security-revoke-all"
                  type="button"
                  disabled={busySessionId !== null}
                  onClick={() => void revokeOtherSessions()}
                >
                  <LogOut size={14} /> Sign out others
                </button>
              ) : null}
            </div>
          </div>

          {sessionError ? <div className="security-message security-message-error" role="alert">{sessionError}</div> : null}
          {sessionNotice ? <div className="security-message security-message-success" role="status">{sessionNotice}</div> : null}
          {loadingSessions ? (
            <div className="security-session-empty"><span className="spinner" /> Loading sessions…</div>
          ) : sessions === null ? (
            <div className="security-session-empty">Sessions could not be loaded. Try refreshing the list.</div>
          ) : sessions?.length ? (
            <div className="security-session-list">
              {sessions.map((session) => (
                <article className="security-session" key={session.id}>
                  <div className="security-session-main">
                    <div className="security-session-name">
                      <span className="security-session-device">{session.is_current ? <Monitor size={16} /> : <Smartphone size={16} />}</span>
                      <strong>{session.is_current ? 'This device' : 'Browser session'}</strong>
                      {session.is_current ? <span className="security-current-badge">Current</span> : null}
                    </div>
                    <div className="security-session-details">
                      <span><Clock3 size={13} /> Last active {formatSessionDate(session.last_seen_at ?? session.created_at)}</span>
                      <span>Signed in {formatSessionDate(session.created_at)}</span>
                      <span>Expires {formatSessionDate(session.expires_at)}</span>
                    </div>
                  </div>
                  {!session.is_current ? (
                    <button
                      className="button button-quiet-danger security-session-revoke"
                      type="button"
                      disabled={busySessionId !== null}
                      onClick={() => void revokeSession(session)}
                    >
                      <LogOut size={14} /> {busySessionId === session.id ? 'Signing out…' : 'Sign out'}
                    </button>
                  ) : null}
                </article>
              ))}
            </div>
          ) : (
            <div className="security-session-empty">No active sessions were found.</div>
          )}
        </section>
      </div>
    </section>
  );
}
