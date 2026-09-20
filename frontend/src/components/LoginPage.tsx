import { useState, type FormEvent } from 'react';
import { ArrowRight, LockKeyhole, ShieldCheck } from 'lucide-react';
import { api } from '../api';
import { friendlyError } from '../format';
import type { User } from '../types';

type Props = {
  onLoggedIn: (user: User) => void;
};

export default function LoginPage({ onLoggedIn }: Props) {
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
          <span className="eyebrow">YOUR PRIVATE CLOUD</span>
          <h1 id="login-title">Welcome back</h1>
          <p>Sign in to pick up where you left off.</p>
        </div>
        <form className="form-stack" onSubmit={submit}>
          <label className="field-label" htmlFor="owner-email">Email address</label>
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
          <label className="field-label" htmlFor="owner-password">Password</label>
          <input
            id="owner-password"
            className="text-input"
            autoComplete="current-password"
            type="password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="Enter your password"
          />
          {error && <div className="inline-alert" role="alert">{error}</div>}
          <button className="button button-primary login-submit" type="submit" disabled={busy}>
            {busy ? 'Signing in…' : 'Sign in'}
            {!busy && <ArrowRight size={17} />}
          </button>
        </form>
        <div className="login-secure"><ShieldCheck size={16} /> Private, encrypted session</div>
      </section>
      <p className="login-footer">A quiet place for your files.</p>
    </main>
  );
}
