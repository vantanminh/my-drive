import { useState } from 'react';
import { KeyRound, LogOut, ShieldCheck } from 'lucide-react';
import { api } from '../api';
import type { User } from '../types';
import PasswordChangeForm from './PasswordChangeForm';

type Props = {
  user: User;
  onPasswordChanged: () => void;
  onLoggedOut: () => void;
};

export default function PasswordChangePage({ user, onPasswordChanged, onLoggedOut }: Props) {
  const [loggingOut, setLoggingOut] = useState(false);

  async function logout() {
    setLoggingOut(true);
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
        <PasswordChangeForm
          currentPasswordLabel="Temporary password"
          submitLabel="Update password"
          autoFocus
          onChanged={onPasswordChanged}
        />
        <div className="login-secure"><ShieldCheck size={16} /> Signed in as {user.email}</div>
        <button className="password-logout" type="button" disabled={loggingOut} onClick={() => void logout()}>
          <LogOut size={14} /> {loggingOut ? 'Signing out…' : 'Sign out'}
        </button>
      </section>
    </main>
  );
}
