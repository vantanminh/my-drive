import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

import { clearSessionCookies } from '../../modules/mydrive-media-sync/src';
import { MyDriveApiError, MyDriveClient } from '../services/apiClient';
import { ensureBackgroundSyncTaskDefined, syncBackgroundTaskRegistration } from '../services/backgroundSync';
import {
  clearAuthCredentials,
  loadPersistedSession,
  loadSyncSettings,
  saveAuthCredentials,
  saveCsrfToken,
  saveServerConfig,
} from '../services/secureStorage';
import { probeServer } from '../services/serverUrl';
import type { ServerCapabilities, User } from '../types/mydrive';

interface AuthContextValue {
  bootstrapping: boolean;
  serverUrl: string | null;
  lastEmail: string | null;
  allowHttpForUrl: string | null;
  capabilities: ServerCapabilities | null;
  user: User | null;
  client: MyDriveClient | null;
  sessionNotice: string | null;
  clearSessionNotice: () => void;
  connectServer: (rawUrl: string) => Promise<{
    normalizedUrl: string;
    isInsecureHttp: boolean;
    capabilities: ServerCapabilities | null;
  }>;
  confirmServerConnection: (normalizedUrl: string, allowHttp: boolean, capabilities: ServerCapabilities | null) => Promise<void>;
  switchServer: () => Promise<void>;
  login: (email: string, password: string) => Promise<User>;
  changePassword: (currentPassword: string, newPassword: string) => Promise<void>;
  refreshUser: () => Promise<User | null>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [bootstrapping, setBootstrapping] = useState(true);
  const [serverUrl, setServerUrl] = useState<string | null>(null);
  const [lastEmail, setLastEmail] = useState<string | null>(null);
  const [allowHttpForUrl, setAllowHttpForUrl] = useState<string | null>(null);
  const [capabilities, setCapabilities] = useState<ServerCapabilities | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [csrfToken, setCsrfToken] = useState<string | null>(null);
  const [sessionNotice, setSessionNotice] = useState<string | null>(null);
  const serverUrlRef = useRef<string | null>(null);
  serverUrlRef.current = serverUrl;

  const handleUnauthorized = useCallback(() => {
    setUser(null);
    setCsrfToken(null);
    setSessionNotice('Your MyDrive session expired. Please sign in again.');
    void clearAuthCredentials();
    if (serverUrlRef.current) {
      void clearSessionCookies(serverUrlRef.current);
    }
  }, []);

  const handleCsrfUpdate = useCallback((token: string | null) => {
    setCsrfToken(token);
    void saveCsrfToken(token);
  }, []);

  const client = useMemo(() => {
    if (!serverUrl) return null;
    return new MyDriveClient({
      baseUrl: serverUrl,
      csrfToken,
      onCsrfUpdate: handleCsrfUpdate,
      onUnauthorized: handleUnauthorized,
    });
  }, [serverUrl, csrfToken, handleCsrfUpdate, handleUnauthorized]);

  useEffect(() => {
    ensureBackgroundSyncTaskDefined();
    let cancelled = false;

    async function bootstrap() {
      try {
        const persisted = await loadPersistedSession();
        if (cancelled) return;

        setLastEmail(persisted.userEmail);
        setAllowHttpForUrl(persisted.allowHttpForUrl);

        if (!persisted.serverUrl) {
          return;
        }

        const isAllowedHttp =
          !persisted.serverUrl.startsWith('http://') ||
          persisted.allowHttpForUrl === persisted.serverUrl;
        if (!isAllowedHttp) {
          return;
        }

        setServerUrl(persisted.serverUrl);
        setCsrfToken(persisted.csrfToken);

        const tempClient = new MyDriveClient({
          baseUrl: persisted.serverUrl,
          csrfToken: persisted.csrfToken,
          onCsrfUpdate: handleCsrfUpdate,
        });

        try {
          const [caps, currentUser] = await Promise.all([
            tempClient.getCapabilities().catch(() => null),
            tempClient.me(),
          ]);
          if (cancelled) return;
          setCapabilities(caps);
          setUser(currentUser);
          const syncSettings = await loadSyncSettings();
          await syncBackgroundTaskRegistration(syncSettings.autoBackgroundSync);
        } catch (error) {
          if (cancelled) return;
          if (error instanceof MyDriveApiError && error.status === 401) {
            await clearAuthCredentials();
            setCsrfToken(null);
          } else {
            // Keep server configured even if NAS is momentarily unreachable.
            void tempClient.getCapabilities().then((caps) => {
              if (!cancelled && caps) setCapabilities(caps);
            }).catch(() => {});
          }
        }
      } finally {
        if (!cancelled) {
          setBootstrapping(false);
        }
      }
    }

    void bootstrap();
    return () => {
      cancelled = true;
    };
  }, [handleCsrfUpdate]);

  const connectServer = useCallback(async (rawUrl: string) => {
    const result = await probeServer(rawUrl);
    return {
      normalizedUrl: result.normalizedUrl,
      isInsecureHttp: result.isInsecureHttp,
      capabilities: result.capabilities,
    };
  }, []);

  const confirmServerConnection = useCallback(
    async (
      normalizedUrl: string,
      allowHttp: boolean,
      caps: ServerCapabilities | null,
    ) => {
      const httpFlag = allowHttp && normalizedUrl.startsWith('http://') ? normalizedUrl : null;
      await saveServerConfig(normalizedUrl, httpFlag);
      await clearAuthCredentials();
      setAllowHttpForUrl(httpFlag);
      setCapabilities(caps);
      setUser(null);
      setCsrfToken(null);
      setSessionNotice(null);
      setServerUrl(normalizedUrl);
    },
    [],
  );

  const switchServer = useCallback(async () => {
    const activeUrl = serverUrlRef.current;
    if (activeUrl) {
      const tempClient = new MyDriveClient({ baseUrl: activeUrl, csrfToken });
      await tempClient.logout().catch(() => {});
      await clearSessionCookies(activeUrl);
    }
    await clearAuthCredentials();
    await syncBackgroundTaskRegistration(false);
    setUser(null);
    setCsrfToken(null);
    setCapabilities(null);
    setSessionNotice(null);
    setServerUrl(null);
  }, [csrfToken]);

  const login = useCallback(
    async (email: string, password: string) => {
      if (!client) {
        throw new Error('Connect to a MyDrive NAS server first.');
      }
      const res = await client.login(email, password);
      await saveAuthCredentials(res.user.email, res.csrf_token);
      setLastEmail(res.user.email);
      setCsrfToken(res.csrf_token);
      setUser(res.user);
      setSessionNotice(null);
      const syncSettings = await loadSyncSettings();
      await syncBackgroundTaskRegistration(syncSettings.autoBackgroundSync);
      return res.user;
    },
    [client],
  );

  const changePassword = useCallback(
    async (currentPassword: string, newPassword: string) => {
      if (!client) throw new Error('Not connected to server.');
      await client.changePassword(currentPassword, newPassword);
      const refreshed = await client.me();
      setUser(refreshed);
    },
    [client],
  );

  const refreshUser = useCallback(async () => {
    if (!client) return null;
    const me = await client.me();
    setUser(me);
    return me;
  }, [client]);

  const logout = useCallback(async () => {
    const activeUrl = serverUrlRef.current;
    if (client) {
      await client.logout().catch(() => {});
    }
    if (activeUrl) {
      await clearSessionCookies(activeUrl);
    }
    await clearAuthCredentials();
    await syncBackgroundTaskRegistration(false);
    setUser(null);
    setCsrfToken(null);
  }, [client]);

  const clearSessionNotice = useCallback(() => setSessionNotice(null), []);

  const value = useMemo<AuthContextValue>(
    () => ({
      bootstrapping,
      serverUrl,
      lastEmail,
      allowHttpForUrl,
      capabilities,
      user,
      client,
      sessionNotice,
      clearSessionNotice,
      connectServer,
      confirmServerConnection,
      switchServer,
      login,
      changePassword,
      refreshUser,
      logout,
    }),
    [
      bootstrapping,
      serverUrl,
      lastEmail,
      allowHttpForUrl,
      capabilities,
      user,
      client,
      sessionNotice,
      clearSessionNotice,
      connectServer,
      confirmServerConnection,
      switchServer,
      login,
      changePassword,
      refreshUser,
      logout,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used inside AuthProvider');
  }
  return ctx;
}
