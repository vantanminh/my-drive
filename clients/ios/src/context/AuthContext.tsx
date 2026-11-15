import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';
import * as Network from 'expo-network';

import { clearSessionCookies } from '../../modules/mydrive-media-sync/src';
import { MyDriveApiError, MyDriveClient } from '../services/apiClient';
import { ensureBackgroundSyncTaskDefined, syncBackgroundTaskRegistration } from '../services/backgroundSync';
import {
  discoverLanNasServers,
  getLocalWifiSummary,
  isLanUrl,
  probeLanEndpoint,
  selectActiveEndpoint,
} from '../services/lanDiscovery';
import {
  clearAuthCredentials,
  loadPersistedSession,
  loadSyncSettings,
  saveAuthCredentials,
  saveCsrfToken,
  saveLanConfig,
  saveServerConfig,
} from '../services/secureStorage';
import { normalizeServerUrl, probeServer } from '../services/serverUrl';
import type {
  DiscoveredLanServer,
  LanConnectionMode,
  LanConnectionStatus,
  ServerCapabilities,
  User,
} from '../types/mydrive';

interface AuthContextValue {
  bootstrapping: boolean;
  serverUrl: string | null;
  activeBaseUrl: string | null;
  lanStatus: LanConnectionStatus;
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
  confirmServerConnection: (
    normalizedUrl: string,
    allowHttp: boolean,
    capabilities: ServerCapabilities | null,
    explicitLanUrl?: string | null,
  ) => Promise<void>;
  switchServer: () => Promise<void>;
  login: (email: string, password: string) => Promise<User>;
  changePassword: (currentPassword: string, newPassword: string) => Promise<void>;
  refreshUser: () => Promise<User | null>;
  logout: () => Promise<void>;
  scanLanServers: () => Promise<DiscoveredLanServer[]>;
  setPairedLanUrl: (rawUrl: string | null) => Promise<{
    normalizedUrl: string | null;
    matchedServerId: boolean;
  }>;
  setAutoSwitchLan: (enabled: boolean) => Promise<void>;
  refreshLanStatus: (discoverIfUnpaired?: boolean) => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [bootstrapping, setBootstrapping] = useState(true);
  const [serverUrl, setServerUrl] = useState<string | null>(null);
  const [activeBaseUrl, setActiveBaseUrl] = useState<string | null>(null);
  const [lanUrl, setLanUrl] = useState<string | null>(null);
  const [autoSwitchLan, setAutoSwitchLanState] = useState(true);
  const [serverId, setServerId] = useState<string | null>(null);
  const [lanMode, setLanMode] = useState<LanConnectionMode>('remote');
  const [lanLatencyMs, setLanLatencyMs] = useState<number | null>(null);
  const [localIp, setLocalIp] = useState<string | null>(null);
  const [lastLanCheckedAt, setLastLanCheckedAt] = useState<string | null>(null);

  const [lastEmail, setLastEmail] = useState<string | null>(null);
  const [allowHttpForUrl, setAllowHttpForUrl] = useState<string | null>(null);
  const [capabilities, setCapabilities] = useState<ServerCapabilities | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [csrfToken, setCsrfToken] = useState<string | null>(null);
  const [sessionToken, setSessionToken] = useState<string | null>(null);
  const [sessionNotice, setSessionNotice] = useState<string | null>(null);

  const serverUrlRef = useRef<string | null>(null);
  serverUrlRef.current = serverUrl;
  const activeBaseUrlRef = useRef<string | null>(null);
  activeBaseUrlRef.current = activeBaseUrl;
  const lanUrlRef = useRef<string | null>(null);
  lanUrlRef.current = lanUrl;
  const autoSwitchLanRef = useRef(true);
  autoSwitchLanRef.current = autoSwitchLan;
  const serverIdRef = useRef<string | null>(null);
  serverIdRef.current = serverId;
  const evaluatingLanRef = useRef(false);

  const handleUnauthorized = useCallback(() => {
    setUser(null);
    setCsrfToken(null);
    setSessionToken(null);
    setSessionNotice('Your MyDrive session expired. Please sign in again.');
    void clearAuthCredentials();
    if (serverUrlRef.current) {
      void clearSessionCookies(serverUrlRef.current);
    }
    if (lanUrlRef.current) {
      void clearSessionCookies(lanUrlRef.current);
    }
  }, []);

  const handleCsrfUpdate = useCallback((token: string | null) => {
    setCsrfToken(token);
    void saveCsrfToken(token);
  }, []);

  const refreshLanStatus = useCallback(async (discoverIfUnpaired = false) => {
    const primary = serverUrlRef.current;
    if (!primary || evaluatingLanRef.current) return;
    evaluatingLanRef.current = true;
    setLanMode('checking');

    try {
      const [netState, wifiSummary] = await Promise.all([
        Network.getNetworkStateAsync().catch(() => ({
          isConnected: true,
          type: Network.NetworkStateType.WIFI,
        })),
        getLocalWifiSummary(),
      ]);
      setLocalIp(wifiSummary?.localIp ?? null);

      const isConnected = netState.isConnected ?? true;
      const isWifiOrEthernet =
        netState.type === Network.NetworkStateType.WIFI ||
        netState.type === Network.NetworkStateType.ETHERNET;

      const selected = await selectActiveEndpoint({
        primaryUrl: primary,
        pairedLanUrl: lanUrlRef.current,
        autoSwitchLan: autoSwitchLanRef.current,
        expectedServerId: serverIdRef.current,
        isConnected,
        isWifiOrEthernet,
      });

      if (selected.serverId && selected.serverId !== serverIdRef.current) {
        setServerId(selected.serverId);
        void saveLanConfig({ serverId: selected.serverId });
      }

      if (selected.mode === 'lan') {
        setActiveBaseUrl(selected.activeUrl);
        setLanMode('lan');
        setLanLatencyMs(selected.latencyMs);
        setLastLanCheckedAt(new Date().toISOString());
        return;
      }

      if (
        discoverIfUnpaired &&
        selected.mode === 'remote' &&
        autoSwitchLanRef.current &&
        isWifiOrEthernet &&
        !lanUrlRef.current &&
        serverIdRef.current
      ) {
        const discovered = await discoverLanNasServers({
          expectedServerId: serverIdRef.current,
          primaryServerUrl: primary,
        });
        const matched = discovered.find((item) => item.matchedServerId);
        if (matched) {
          setLanUrl(matched.url);
          await saveLanConfig({ lanUrl: matched.url });
          setActiveBaseUrl(matched.url);
          setLanMode('lan');
          setLanLatencyMs(matched.latencyMs);
          setLastLanCheckedAt(new Date().toISOString());
          return;
        }
      }

      setActiveBaseUrl(selected.activeUrl);
      setLanMode(selected.mode);
      setLanLatencyMs(selected.latencyMs);
      setLastLanCheckedAt(new Date().toISOString());
    } finally {
      evaluatingLanRef.current = false;
    }
  }, []);

  const handleTransportError = useCallback(
    (failedBaseUrl: string) => {
      const primary = serverUrlRef.current;
      if (primary && failedBaseUrl !== primary && activeBaseUrlRef.current === failedBaseUrl) {
        setActiveBaseUrl(primary);
        setLanMode('remote');
        setLanLatencyMs(null);
        void refreshLanStatus(false);
      }
    },
    [refreshLanStatus],
  );

  const client = useMemo(() => {
    const resolvedBase = activeBaseUrl ?? serverUrl;
    if (!resolvedBase) return null;
    return new MyDriveClient({
      baseUrl: resolvedBase,
      csrfToken,
      sessionToken,
      onCsrfUpdate: handleCsrfUpdate,
      onUnauthorized: handleUnauthorized,
      onTransportError: handleTransportError,
    });
  }, [
    activeBaseUrl,
    serverUrl,
    csrfToken,
    sessionToken,
    handleCsrfUpdate,
    handleUnauthorized,
    handleTransportError,
  ]);

  useEffect(() => {
    ensureBackgroundSyncTaskDefined();
    let cancelled = false;

    async function bootstrap() {
      try {
        const persisted = await loadPersistedSession();
        if (cancelled) return;

        setLastEmail(persisted.userEmail);
        setAllowHttpForUrl(persisted.allowHttpForUrl);
        setLanUrl(persisted.lanUrl);
        setAutoSwitchLanState(persisted.autoSwitchLan);
        setServerId(persisted.serverId);
        setSessionToken(persisted.sessionToken);

        if (!persisted.serverUrl) {
          return;
        }

        const isAllowedHttp =
          !persisted.serverUrl.startsWith('http://') ||
          persisted.allowHttpForUrl === persisted.serverUrl;
        if (!isAllowedHttp) {
          return;
        }

        const [netState, wifiSummary] = await Promise.all([
          Network.getNetworkStateAsync().catch(() => ({
            isConnected: true,
            type: Network.NetworkStateType.WIFI,
          })),
          getLocalWifiSummary(),
        ]);
        if (cancelled) return;
        setLocalIp(wifiSummary?.localIp ?? null);

        const isConnected = netState.isConnected ?? true;
        const isWifiOrEthernet =
          netState.type === Network.NetworkStateType.WIFI ||
          netState.type === Network.NetworkStateType.ETHERNET;

        const endpoint = await selectActiveEndpoint({
          primaryUrl: persisted.serverUrl,
          pairedLanUrl: persisted.lanUrl,
          autoSwitchLan: persisted.autoSwitchLan,
          expectedServerId: persisted.serverId,
          isConnected,
          isWifiOrEthernet,
        });
        if (cancelled) return;

        setServerUrl(persisted.serverUrl);
        setActiveBaseUrl(endpoint.activeUrl);
        setLanMode(endpoint.mode);
        setLanLatencyMs(endpoint.latencyMs);
        setLastLanCheckedAt(new Date().toISOString());
        setCsrfToken(persisted.csrfToken);

        const resolvedId = endpoint.serverId ?? persisted.serverId;
        if (resolvedId) {
          setServerId(resolvedId);
        }

        const tempClient = new MyDriveClient({
          baseUrl: endpoint.activeUrl,
          csrfToken: persisted.csrfToken,
          sessionToken: persisted.sessionToken,
          onCsrfUpdate: handleCsrfUpdate,
        });

        try {
          const [caps, currentUser] = await Promise.all([
            tempClient.getCapabilities().catch(() => null),
            tempClient.me(),
          ]);
          if (cancelled) return;
          setCapabilities(caps);
          if (caps?.serverId) {
            setServerId(caps.serverId);
            void saveLanConfig({ serverId: caps.serverId });
          }
          setUser(currentUser);
          const syncSettings = await loadSyncSettings();
          await syncBackgroundTaskRegistration(syncSettings.autoBackgroundSync);

          if (
            !persisted.lanUrl &&
            persisted.autoSwitchLan &&
            isWifiOrEthernet &&
            !isLanUrl(persisted.serverUrl) &&
            caps?.serverId
          ) {
            void refreshLanStatus(true);
          }
        } catch (error) {
          if (cancelled) return;
          if (error instanceof MyDriveApiError && error.status === 401) {
            await clearAuthCredentials();
            setCsrfToken(null);
            setSessionToken(null);
          } else {
            // Keep server configured even if NAS is momentarily unreachable.
            void tempClient
              .getCapabilities()
              .then((caps) => {
                if (!cancelled && caps) {
                  setCapabilities(caps);
                  if (caps.serverId) {
                    setServerId(caps.serverId);
                    void saveLanConfig({ serverId: caps.serverId });
                  }
                }
              })
              .catch(() => {});
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
  }, [handleCsrfUpdate, refreshLanStatus]);

  useEffect(() => {
    if (!serverUrl) return;
    const appStateSub = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'active') {
        void refreshLanStatus(false);
      }
    });
    const networkSub = Network.addNetworkStateListener(() => {
      void refreshLanStatus(true);
    });
    return () => {
      appStateSub.remove();
      networkSub.remove();
    };
  }, [serverUrl, refreshLanStatus]);

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
      explicitLanUrl?: string | null,
    ) => {
      const httpFlag = allowHttp && normalizedUrl.startsWith('http://') ? normalizedUrl : null;
      const nextServerId = caps?.serverId ?? null;
      const pairedLan = explicitLanUrl ?? (isLanUrl(normalizedUrl) ? null : null);

      await Promise.all([
        saveServerConfig(normalizedUrl, httpFlag),
        saveLanConfig({
          lanUrl: pairedLan,
          serverId: nextServerId,
        }),
        clearAuthCredentials(),
      ]);

      setAllowHttpForUrl(httpFlag);
      setCapabilities(caps);
      setServerId(nextServerId);
      setLanUrl(pairedLan);
      setUser(null);
      setCsrfToken(null);
      setSessionToken(null);
      setSessionNotice(null);
      setServerUrl(normalizedUrl);
      setActiveBaseUrl(pairedLan ?? normalizedUrl);
      setLanMode(pairedLan || isLanUrl(normalizedUrl) ? 'lan' : 'remote');
      setLanLatencyMs(null);
      setLastLanCheckedAt(new Date().toISOString());

      if (!isLanUrl(normalizedUrl) && !pairedLan && nextServerId) {
        setTimeout(() => {
          void refreshLanStatus(true);
        }, 50);
      }
    },
    [refreshLanStatus],
  );

  const switchServer = useCallback(async () => {
    const targetUrl = activeBaseUrlRef.current ?? serverUrlRef.current;
    if (targetUrl) {
      const tempClient = new MyDriveClient({
        baseUrl: targetUrl,
        csrfToken,
        sessionToken,
      });
      await tempClient.logout().catch(() => {});
      await clearSessionCookies(targetUrl);
    }
    if (serverUrlRef.current && serverUrlRef.current !== targetUrl) {
      await clearSessionCookies(serverUrlRef.current);
    }
    await Promise.all([
      clearAuthCredentials(),
      saveLanConfig({ lanUrl: null, serverId: null }),
    ]);
    await syncBackgroundTaskRegistration(false);
    setUser(null);
    setCsrfToken(null);
    setSessionToken(null);
    setCapabilities(null);
    setSessionNotice(null);
    setServerId(null);
    setLanUrl(null);
    setActiveBaseUrl(null);
    setLanMode('remote');
    setLanLatencyMs(null);
    setServerUrl(null);
  }, [csrfToken, sessionToken]);

  const login = useCallback(
    async (email: string, password: string) => {
      if (!client) {
        throw new Error('Connect to a MyDrive NAS server first.');
      }
      const res = await client.login(email, password);
      await saveAuthCredentials(
        res.user.email,
        res.csrf_token,
        res.session_token ?? null,
      );
      setLastEmail(res.user.email);
      setCsrfToken(res.csrf_token);
      setSessionToken(res.session_token ?? null);
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
    const activeUrl = activeBaseUrlRef.current ?? serverUrlRef.current;
    if (client) {
      await client.logout().catch(() => {});
    }
    if (activeUrl) {
      await clearSessionCookies(activeUrl);
    }
    if (serverUrlRef.current && serverUrlRef.current !== activeUrl) {
      await clearSessionCookies(serverUrlRef.current);
    }
    await clearAuthCredentials();
    await syncBackgroundTaskRegistration(false);
    setUser(null);
    setCsrfToken(null);
    setSessionToken(null);
  }, [client]);

  const scanLanServers = useCallback(async () => {
    const found = await discoverLanNasServers({
      expectedServerId: serverIdRef.current,
      knownLanUrl: lanUrlRef.current,
      primaryServerUrl: serverUrlRef.current,
    });
    const wifi = await getLocalWifiSummary();
    setLocalIp(wifi?.localIp ?? null);
    return found;
  }, []);

  const setPairedLanUrl = useCallback(
    async (rawUrl: string | null) => {
      if (!rawUrl || !rawUrl.trim()) {
        await saveLanConfig({ lanUrl: null });
        setLanUrl(null);
        await refreshLanStatus(false);
        return { normalizedUrl: null, matchedServerId: false };
      }

      const normalized = normalizeServerUrl(rawUrl);
      const match = await probeLanEndpoint(normalized.url, {
        expectedServerId: serverIdRef.current,
        timeoutMs: 2500,
      });
      if (!match) {
        throw new Error(
          serverIdRef.current
            ? 'Could not verify this LAN address as the same MyDrive NAS. Check the IP/port and make sure you are on the same Wi-Fi.'
            : 'Could not reach a MyDrive NAS at that LAN address.',
        );
      }

      const resolvedServerId = match.capabilities.serverId ?? serverIdRef.current;
      await saveLanConfig({
        lanUrl: match.url,
        serverId: resolvedServerId ?? undefined,
      });
      if (resolvedServerId) {
        setServerId(resolvedServerId);
      }
      setLanUrl(match.url);
      if (autoSwitchLanRef.current) {
        setActiveBaseUrl(match.url);
        setLanMode('lan');
        setLanLatencyMs(match.latencyMs);
        setLastLanCheckedAt(new Date().toISOString());
      }
      return { normalizedUrl: match.url, matchedServerId: match.matchedServerId };
    },
    [refreshLanStatus],
  );

  const setAutoSwitchLan = useCallback(
    async (enabled: boolean) => {
      setAutoSwitchLanState(enabled);
      await saveLanConfig({ autoSwitchLan: enabled });
      await refreshLanStatus(false);
    },
    [refreshLanStatus],
  );

  const clearSessionNotice = useCallback(() => setSessionNotice(null), []);

  const lanStatus = useMemo<LanConnectionStatus>(
    () => ({
      mode: lanMode,
      isOnLan: lanMode === 'lan',
      activeUrl: activeBaseUrl ?? serverUrl,
      primaryUrl: serverUrl,
      pairedLanUrl: lanUrl,
      autoSwitchLan,
      latencyMs: lanLatencyMs,
      localIp,
      serverId,
      lastCheckedAt: lastLanCheckedAt,
    }),
    [
      lanMode,
      activeBaseUrl,
      serverUrl,
      lanUrl,
      autoSwitchLan,
      lanLatencyMs,
      localIp,
      serverId,
      lastLanCheckedAt,
    ],
  );

  const value = useMemo<AuthContextValue>(
    () => ({
      bootstrapping,
      serverUrl,
      activeBaseUrl: activeBaseUrl ?? serverUrl,
      lanStatus,
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
      scanLanServers,
      setPairedLanUrl,
      setAutoSwitchLan,
      refreshLanStatus,
    }),
    [
      bootstrapping,
      serverUrl,
      activeBaseUrl,
      lanStatus,
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
      scanLanServers,
      setPairedLanUrl,
      setAutoSwitchLan,
      refreshLanStatus,
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
