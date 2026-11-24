import { useState, type FormEvent } from 'react';
import { ArrowRight, LockKeyhole, ShieldCheck } from 'lucide-react';
import { api } from '../api';
import { friendlyError } from '../format';
import { useI18n } from '../i18n';
import type { User } from '../types';

type Props = {
  onLoggedIn: (user: User) => void;
};

export default function LoginPage({ onLoggedIn }: Props) {
  const { t } = useI18n();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      const user = await api.login(email, password);
      onLoggedIn(user);
    } catch (cause) {
      setError(friendlyError(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login-page">
      <section className="login-card" aria-labelledby="login-title">
        <div className="login-brand">
          <span className="brand-symbol"><LockKeyhole size={19} strokeWidth={2.3} /></span>
          <span>MY DRIVE</span>
        </div>
        <div className="login-intro">
          <span className="eyebrow">{t('login.eyebrow')}</span>
          <h1 id="login-title">{t('login.title')}</h1>
          <p>{t('login.subtitle')}</p>
        </div>
        <form className="form-stack" onSubmit={submit}>
          <label className="field-label" htmlFor="owner-email">{t('login.email')}</label>
          <input
            id="owner-email"
            className="text-input"
            autoComplete="username"
            autoFocus
            type="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="you@example.com"
          />
          <label className="field-label" htmlFor="owner-password">{t('login.password')}</label>
          <input
            id="owner-password"
            className="text-input"
            autoComplete="current-password"
            type="password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder={t('login.password_placeholder')}
          />
          {error && <div className="inline-alert" role="alert">{error}</div>}
          <button className="button button-primary login-submit" type="submit" disabled={busy}>
            {busy ? t('login.submitting') : t('login.submit')}
            {!busy && <ArrowRight size={17} />}
          </button>
        </form>
        <div className="login-secure"><ShieldCheck size={16} /> {t('login.secure')}</div>
      </section>
      <p className="login-footer">{t('login.footer')}</p>
    </main>
  );
}
