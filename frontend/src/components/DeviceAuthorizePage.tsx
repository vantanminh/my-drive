import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Laptop, ShieldCheck } from 'lucide-react';
import { api } from '../api';
import { friendlyError } from '../format';
import type { DeviceAuthorizationRequest, User } from '../types';

function userCodeFromLocation(): string {
  const params = new URLSearchParams(window.location.search);
  return (params.get('user_code') || '').trim();
}

export default function DeviceAuthorizePage() {
  const initialCode = useMemo(userCodeFromLocation, []);
  const [user, setUser] = useState<User | null>(null);
  const [checking, setChecking] = useState(true);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [userCode, setUserCode] = useState(initialCode);
  const [request, setRequest] = useState<DeviceAuthorizationRequest | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    api.me(controller.signal)
      .then(setUser)
      .catch(() => setUser(null))
      .finally(() => setChecking(false));
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!user || !userCode.trim()) return;
    const controller = new AbortController();
    setError('');
    api.deviceRequest(userCode.trim(), controller.signal)
      .then(setRequest)
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) {
          setRequest(null);
          setError(friendlyError(cause));
        }
      });
    return () => controller.abort();
  }, [user, userCode]);

  async function signIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      setUser(await api.login(email, password));
    } catch (cause) {
      setError(friendlyError(cause));
    } finally {
      setBusy(false);
    }
  }

  async function decide(approve: boolean) {
    setBusy(true);
    setError('');
    try {
      if (approve) {
        const result = await api.approveDevice(userCode.trim());
        setDone(`${result.device_name} can now back up to this account. You can close this page.`);
      } else {
        await api.denyDevice(userCode.trim());
        setDone('The device was not authorized. You can close this page.');
      }
      setRequest(null);
    } catch (cause) {
      setError(friendlyError(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login-page">
      <section className="login-card device-authorize-card" aria-labelledby="device-auth-title">
        <div className="login-brand">
          <span className="brand-symbol"><Laptop size={19} strokeWidth={2.3} /></span>
          <span>WINDOWS BACKUP</span>
        </div>
        <div className="login-intro">
          <span className="eyebrow">AUTHORIZE THIS DEVICE</span>
          <h1 id="device-auth-title">Connect a backup client</h1>
          <p>The Windows app never receives your password. Approve it here, then return to the app.</p>
        </div>
        {checking ? <div className="security-session-empty"><span className="spinner" /> Checking your session…</div> : null}
        {!checking && !user ? (
          <form className="form-stack" onSubmit={signIn}>
            <label className="field-label" htmlFor="device-email">Email address</label>
            <input id="device-email" className="text-input" autoComplete="username" type="email" required value={email} onChange={(event) => setEmail(event.target.value)} />
            <label className="field-label" htmlFor="device-password">Password</label>
            <input id="device-password" className="text-input" autoComplete="current-password" type="password" required value={password} onChange={(event) => setPassword(event.target.value)} />
            {error ? <div className="inline-alert" role="alert">{error}</div> : null}
            <button className="button button-primary" type="submit" disabled={busy}>{busy ? 'Signing in…' : 'Sign in to continue'}</button>
          </form>
        ) : null}
        {!checking && user && !done ? (
          <div className="form-stack">
            <p className="device-auth-account">Signed in as {user.email}</p>
            <label className="field-label" htmlFor="device-user-code">Device code</label>
            <input id="device-user-code" className="text-input device-code-input" value={userCode} onChange={(event) => setUserCode(event.target.value.toUpperCase())} autoComplete="off" spellCheck={false} />
            {request && request.status === 'pending' ? (
              <article className="device-auth-summary">
                <ShieldCheck size={18} />
                <div>
                  <strong>{request.device_name}</strong>
                  <span>{request.client_name} · {request.operating_system}</span>
                  <span>Client {request.client_version}{request.requested_ip ? ` · ${request.requested_ip}` : ''}</span>
                </div>
              </article>
            ) : null}
            {error ? <div className="inline-alert" role="alert">{error}</div> : null}
            <div className="device-auth-actions">
              <button className="button button-secondary" type="button" disabled={busy || !userCode.trim()} onClick={() => void decide(false)}>Deny</button>
              <button className="button button-primary" type="button" disabled={busy || request?.status !== 'pending'} onClick={() => void decide(true)}>
                {busy ? 'Authorizing…' : 'Authorize Windows Backup Client'}
              </button>
            </div>
          </div>
        ) : null}
        {done ? <div className="security-message security-message-success" role="status">{done}</div> : null}
      </section>
    </main>
  );
}
