import { useState, type FormEvent } from 'react';
import { ArrowRight, KeyRound, LogOut, ShieldCheck } from 'lucide-react';
import { api } from '../api';
import { friendlyError } from '../format';
import type { User } from '../types';

type Props = {
  user: User;
  onPasswordChanged: () => void;
  onLoggedOut: () => void;
};

export default function PasswordChangePage({ user, onPasswordChanged, onLoggedOut }: Props) {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    if ([...newPassword].length < 12) {
      setError('Choose a password with at least 12 characters.');
      return;
    }
    if (new TextEncoder().encode(newPassword).length > 1024) {
      setError('The new password must be no more than 1,024 bytes.');
      return;
    }
    if (newPassword !== confirmPassword) {
      setError('The new passwords do not match.');
      return;
    }
    if (currentPassword === newPassword) {
      setError('Choose a password different from your temporary password.');
      return;
    }

    setBusy(true);
    try {
      await api.changePassword(currentPassword, newPassword);
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      onPasswordChanged();
    } catch (cause: unknown) {
      setError(friendlyError(cause));
    } finally {
      setBusy(false);
    }
  }

  async function logout() {
    try {
      await api.logout();
    } catch {
      // Returning to sign-in clears the local authenticated view even if the API is unavailable.
    }
    onLoggedOut();
  }

  return (
    <main className="login-page password-change-page">
      <section className="password-card" aria-labelledby="password-change-title">
        <div className="password-mark"><KeyRound size={23} /></div>
        <span className="eyebrow">SECURE YOUR ACCOUNT</span>
        <h1 id="password-change-title">Choose a new password</h1>
        <p>Your administrator gave you a temporary password. Change it to continue to your private drive.</p>
        <form className="form-stack" onSubmit={(event) => void submit(event)}>
          <label className="field-label" htmlFor="temporary-password">Temporary password</label>
          <input
            id="temporary-password"
            className="text-input"
            type="password"
            autoComplete="current-password"
            autoFocus
            required
            maxLength={1024}
            value={currentPassword}
            onChange={(event) => setCurrentPassword(event.target.value)}
          />
          <label className="field-label" htmlFor="new-account-password">New password</label>
          <input
            id="new-account-password"
            className="text-input"
            type="password"
            autoComplete="new-password"
            required
            value={newPassword}
            onChange={(event) => setNewPassword(event.target.value)}
            aria-describedby="new-password-hint"
          />
          <small className="password-field-hint" id="new-password-hint">Use at least 12 characters.</small>
          <label className="field-label" htmlFor="confirm-account-password">Confirm new password</label>
          <input
            id="confirm-account-password"
            className="text-input"
            type="password"
            autoComplete="new-password"
            required
            value={confirmPassword}
            onChange={(event) => setConfirmPassword(event.target.value)}
          />
          {error && <div className="inline-alert" role="alert">{error}</div>}
          <button className="button button-primary" type="submit" disabled={busy}>
            {busy ? 'Updating password…' : 'Update password'}
            {!busy && <ArrowRight size={16} />}
          </button>
        </form>
        <div className="login-secure"><ShieldCheck size={16} /> Signed in as {user.email}</div>
        <button className="password-logout" type="button" onClick={() => void logout()}><LogOut size={14} /> Sign out</button>
      </section>
    </main>
  );
}
