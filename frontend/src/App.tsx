import { useEffect, useState } from 'react';
import { ApiError, api } from './api';
import LoginPage from './components/LoginPage';
import PublicSharePage from './components/PublicSharePage';
import DriveApp from './components/DriveApp';
import PasswordChangePage from './components/PasswordChangePage';
import type { User } from './types';

function publicTokenFromPath(): string | null {
  const match = window.location.pathname.match(/^\/s\/([^/]+)\/?$/);
  return match ? decodeURIComponent(match[1]) : null;
}

export default function App() {
  const publicToken = publicTokenFromPath();
  const [user, setUser] = useState<User | null>(null);
  const [checkingSession, setCheckingSession] = useState(!publicToken);

  useEffect(() => {
    if (publicToken) return;
    const controller = new AbortController();
    api.me(controller.signal)
      .then(setUser)
      .catch((error: unknown) => {
        if (!(error instanceof ApiError) || error.status !== 401) {
          // An unavailable API is handled by the sign-in view on a fresh load.
        }
      })
      .finally(() => setCheckingSession(false));
    return () => controller.abort();
  }, [publicToken]);

  if (publicToken) return <PublicSharePage token={publicToken} />;
  if (checkingSession) {
    return <main className="app-loading"><span className="spinner" />Opening your drive…</main>;
  }
  if (!user) return <LoginPage onLoggedIn={setUser} />;
  if (user.must_change_password) {
    return (
      <PasswordChangePage
        user={user}
        onPasswordChanged={() => setUser((current) => current ? { ...current, must_change_password: false } : null)}
        onLoggedOut={() => setUser(null)}
      />
    );
  }
  return <DriveApp user={user} onLoggedOut={() => setUser(null)} />;
}
