import { useState } from 'react';
import { KeyRound, LogOut, ShieldCheck } from 'lucide-react';
import { api } from '../api';
import { useI18n } from '../i18n';
import type { User } from '../types';
import PasswordChangeForm from './PasswordChangeForm';

type Props = {
  user: User;
  onPasswordChanged: () => void;
  onLoggedOut: () => void;
};

export default function PasswordChangePage({ user, onPasswordChanged, onLoggedOut }: Props) {
  const { t } = useI18n();
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
        <span className="eyebrow">{t('password.eyebrow')}</span>
        <h1 id="password-change-title">{t('password.title')}</h1>
        <p>{t('password.subtitle')}</p>
        <PasswordChangeForm
          currentPasswordLabel={t('password.current_temp')}
          submitLabel={t('password.update')}
          autoFocus
          onChanged={onPasswordChanged}
        />
        <div className="login-secure"><ShieldCheck size={16} /> {t('password.signed_in_as', { email: user.email })}</div>
        <button className="password-logout" type="button" disabled={loggingOut} onClick={() => void logout()}>
          <LogOut size={14} /> {loggingOut ? t('password.signing_out') : t('password.sign_out')}
        </button>
      </section>
    </main>
  );
}
