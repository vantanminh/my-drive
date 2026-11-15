import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import * as MediaLibrary from 'expo-media-library';

import {
  inspectAssets,
  isNativeMediaSyncAvailable,
} from '../../modules/mydrive-media-sync/src';
import { createIosPhotoSyncDeps, syncBackgroundTaskRegistration } from '../services/backgroundSync';
import { PhotoSyncEngine, initialSyncSnapshot } from '../services/photoSyncEngine';
import { defaultSyncSettings, loadSyncSettings, saveSyncSettings } from '../services/secureStorage';
import { SqliteSyncLedgerStore, type SyncLedgerStats } from '../services/syncDatabase';
import type { SyncLedgerRecord, SyncProgressSnapshot, SyncSettings } from '../types/mydrive';
import { useAuth } from './AuthContext';

export interface ICloudSampleSummary {
  checked: number;
  inICloudCount: number;
  localCount: number;
  livePhotoCount: number;
  permissionStatus: 'granted' | 'limited' | 'denied' | 'undetermined';
  nativeAvailable: boolean;
  sampleInICloudNames: string[];
  checkedAt: string | null;
}

interface SyncContextValue {
  settings: SyncSettings;
  snapshot: SyncProgressSnapshot;
  ledgerRecords: SyncLedgerRecord[];
  ledgerStats: SyncLedgerStats;
  icloudSummary: ICloudSampleSummary;
  scanningICloud: boolean;
  updateSettings: (patch: Partial<SyncSettings>) => Promise<void>;
  refreshLedger: () => Promise<void>;
  inspectICloudSample: () => Promise<void>;
  requestPhotoPermission: () => Promise<'granted' | 'limited' | 'denied' | 'undetermined'>;
  startSync: (options?: { forceReverify?: boolean }) => Promise<void>;
  cancelSync: () => void;
  clearLedgerHistory: () => Promise<void>;
}

const EMPTY_STATS: SyncLedgerStats = {
  syncedCount: 0,
  dedupedCount: 0,
  waitingWifiCount: 0,
  errorCount: 0,
  icloudOriginalsCount: 0,
};

const EMPTY_ICLOUD_SUMMARY: ICloudSampleSummary = {
  checked: 0,
  inICloudCount: 0,
  localCount: 0,
  livePhotoCount: 0,
  permissionStatus: 'undetermined',
  nativeAvailable: isNativeMediaSyncAvailable(),
  sampleInICloudNames: [],
  checkedAt: null,
};

const SyncContext = createContext<SyncContextValue | null>(null);

export function SyncProvider({ children }: { children: React.ReactNode }) {
  const { client, serverUrl, user } = useAuth();
  const [settings, setSettings] = useState<SyncSettings>(defaultSyncSettings);
  const [snapshot, setSnapshot] = useState<SyncProgressSnapshot>(initialSyncSnapshot);
  const [ledgerRecords, setLedgerRecords] = useState<SyncLedgerRecord[]>([]);
  const [ledgerStats, setLedgerStats] = useState<SyncLedgerStats>(EMPTY_STATS);
  const [icloudSummary, setIcloudSummary] = useState<ICloudSampleSummary>(EMPTY_ICLOUD_SUMMARY);
  const [scanningICloud, setScanningICloud] = useState(false);

  const ledgerRef = useRef(new SqliteSyncLedgerStore());
  const abortRef = useRef<AbortController | null>(null);
  const runningRef = useRef(false);

  const refreshLedger = useCallback(async () => {
    if (!serverUrl) {
      setLedgerRecords([]);
      setLedgerStats(EMPTY_STATS);
      return;
    }
    const [records, stats] = await Promise.all([
      ledgerRef.current.listRecent(serverUrl, 60),
      ledgerRef.current.getStats(serverUrl),
    ]);
    setLedgerRecords(records);
    setLedgerStats(stats);
  }, [serverUrl]);

  const inspectICloudSample = useCallback(async () => {
    setScanningICloud(true);
    try {
      const perms = await MediaLibrary.getPermissionsAsync();
      const permissionStatus: ICloudSampleSummary['permissionStatus'] = perms.granted
        ? perms.accessPrivileges === 'limited'
          ? 'limited'
          : 'granted'
        : perms.canAskAgain
          ? 'undetermined'
          : 'denied';

      const nativeAvailable = isNativeMediaSyncAvailable();
      if (!perms.granted || !nativeAvailable) {
        setIcloudSummary({
          checked: 0,
          inICloudCount: 0,
          localCount: 0,
          livePhotoCount: 0,
          permissionStatus,
          nativeAvailable,
          sampleInICloudNames: [],
          checkedAt: new Date().toISOString(),
        });
        return;
      }

      const recentAssets = await new MediaLibrary.Query()
        .orderBy({ key: MediaLibrary.AssetField.CREATION_TIME, ascending: false })
        .limit(40)
        .exeForMetadata();

      const inspections = recentAssets.length
        ? await inspectAssets(recentAssets.map((a) => a.id))
        : [];

      const inCloud = inspections.filter((item) => item.inICloud);
      const livePhotos = inspections.filter((item) => item.hasLivePhotoVideo);
      setIcloudSummary({
        checked: inspections.length,
        inICloudCount: inCloud.length,
        localCount: inspections.length - inCloud.length,
        livePhotoCount: livePhotos.length,
        permissionStatus,
        nativeAvailable,
        sampleInICloudNames: inCloud.slice(0, 4).map((item) => item.originalFilename),
        checkedAt: new Date().toISOString(),
      });
    } catch {
      // Leave previous summary intact on transient error.
    } finally {
      setScanningICloud(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    void loadSyncSettings().then((loaded) => {
      if (active) setSettings(loaded);
    });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (user && serverUrl) {
      void refreshLedger();
      void inspectICloudSample();
    } else {
      setLedgerRecords([]);
      setLedgerStats(EMPTY_STATS);
    }
  }, [user, serverUrl, refreshLedger, inspectICloudSample]);

  const updateSettings = useCallback(async (patch: Partial<SyncSettings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      void saveSyncSettings(next);
      if (typeof patch.autoBackgroundSync === 'boolean') {
        void syncBackgroundTaskRegistration(next.autoBackgroundSync);
      }
      return next;
    });
  }, []);

  const requestPhotoPermission = useCallback(async () => {
    const res = await MediaLibrary.requestPermissionsAsync();
    const mapped: ICloudSampleSummary['permissionStatus'] = res.granted
      ? res.accessPrivileges === 'limited'
        ? 'limited'
        : 'granted'
      : res.canAskAgain
        ? 'undetermined'
        : 'denied';
    await inspectICloudSample();
    return mapped;
  }, [inspectICloudSample]);

  const startSync = useCallback(
    async (options?: { forceReverify?: boolean }) => {
      if (!client || runningRef.current) return;
      runningRef.current = true;
      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const perm = await MediaLibrary.getPermissionsAsync();
        if (!perm.granted) {
          const requested = await MediaLibrary.requestPermissionsAsync();
          if (!requested.granted) {
            setSnapshot((prev) => ({
              ...prev,
              running: false,
              phase: 'idle',
              lastError: 'Photo Library permission is required to sync original photos and videos.',
            }));
            return;
          }
        }

        const engine = new PhotoSyncEngine(
          client,
          ledgerRef.current,
          createIosPhotoSyncDeps(client),
        );
        const result = await engine.run({
          settings,
          ledgerServerUrl: serverUrl ?? undefined,
          forceReverify: options?.forceReverify,
          signal: controller.signal,
          onProgress: (nextSnap) => setSnapshot(nextSnap),
        });
        setSnapshot(result);
        await Promise.all([refreshLedger(), inspectICloudSample()]);
      } catch (err) {
        setSnapshot((prev) => ({
          ...prev,
          running: false,
          phase: 'idle',
          lastError: err instanceof Error ? err.message : String(err),
        }));
      } finally {
        runningRef.current = false;
        abortRef.current = null;
      }
    },
    [client, serverUrl, settings, refreshLedger, inspectICloudSample],
  );

  const cancelSync = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const clearLedgerHistory = useCallback(async () => {
    if (!serverUrl) return;
    await ledgerRef.current.clearServer(serverUrl);
    await refreshLedger();
  }, [serverUrl, refreshLedger]);

  const value = useMemo<SyncContextValue>(
    () => ({
      settings,
      snapshot,
      ledgerRecords,
      ledgerStats,
      icloudSummary,
      scanningICloud,
      updateSettings,
      refreshLedger,
      inspectICloudSample,
      requestPhotoPermission,
      startSync,
      cancelSync,
      clearLedgerHistory,
    }),
    [
      settings,
      snapshot,
      ledgerRecords,
      ledgerStats,
      icloudSummary,
      scanningICloud,
      updateSettings,
      refreshLedger,
      inspectICloudSample,
      requestPhotoPermission,
      startSync,
      cancelSync,
      clearLedgerHistory,
    ],
  );

  return <SyncContext.Provider value={value}>{children}</SyncContext.Provider>;
}

export function useSync(): SyncContextValue {
  const ctx = useContext(SyncContext);
  if (!ctx) {
    throw new Error('useSync must be used inside SyncProvider');
  }
  return ctx;
}
