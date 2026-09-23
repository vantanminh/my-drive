import { useEffect, useMemo, useState } from 'react';
import { ApiError, api } from './api';
import LoginPage from './components/LoginPage';
import PublicSharePage from './components/PublicSharePage';
import DriveApp from './components/DriveApp';
import PasswordChangePage from './components/PasswordChangePage';
import { parsePublicRoute, useBrowserHref } from './route';
import type { User } from './types';

export default function App() {
  const href = useBrowserHref();
  const publicRoute = useMemo(() => {
    const search = href.includes('?') ? href.slice(href.indexOf('?')) : '';
    const pathname = href.includes('?') ? href.slice(0, href.indexOf('?')) : href;
    return parsePublicRoute(pathname, search);
  }, [href]);
  const [user, setUser] = useState<User | null>(null);
  const [checkingSession, setCheckingSession] = useState(!publicRoute);

  useEffect(() => {
    if (publicRoute) return;
    if (user) return;
    const controller = new AbortController();
    setCheckingSession(true);
    api.me(controller.signal)
      .then(setUser)
      .catch((error: unknown) => {
        if (!(error instanceof ApiError) || error.status !== 401) {
          // An unavailable API is handled by the sign-in view on a fresh load.
        }
      })
      .finally(() => setCheckingSession(false));
    return () => controller.abort();
  }, [publicRoute, user]);

  if (publicRoute) return <PublicSharePage token={publicRoute.token} />;
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
