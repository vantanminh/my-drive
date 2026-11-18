import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import * as Haptics from 'expo-haptics';
import { Ionicons } from '@expo/vector-icons';

import { LanStatusBadge } from '../components/LanStatusBadge';
import { TextPromptModal } from '../components/TextPromptModal';
import {
  AppButton,
  Card,
  KeyValueRow,
  SectionTitle,
  StatusBadge,
} from '../components/UiPrimitives';
import { useAuth } from '../context/AuthContext';
import { useSync } from '../context/SyncContext';
import type { RootStackParamList } from '../navigation/types';
import { clearAllCaches, fetchCacheSnapshot } from '../services/cacheRuntime';
import type { CacheSnapshot } from '../services/cacheTypes';
import { formatBytes, formatShortDate } from '../services/format';
import { colors, radius, spacing } from '../theme/tokens';
import type {
  AccountStorage,
  BackupDevice,
  BrowserSession,
  DiscoveredLanServer,
  ServerStorage,
} from '../types/mydrive';

export function SettingsScreen() {
  const {
    user,
    serverUrl,
    lanStatus,
    capabilities,
    client,
    switchServer,
    logout,
    scanLanServers,
    setPairedLanUrl,
    setAutoSwitchLan,
    refreshLanStatus,
  } = useAuth();
  const { snapshot: syncSnap } = useSync();
  const rootNav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const [storage, setStorage] = useState<AccountStorage | null>(null);
  const [serverStorage, setServerStorage] = useState<ServerStorage | null>(null);
  const [cacheSnap, setCacheSnap] = useState<CacheSnapshot | null>(null);
  const [clearingCache, setClearingCache] = useState(false);
  const [sessions, setSessions] = useState<BrowserSession[]>([]);
  const [devices, setDevices] = useState<BackupDevice[]>([]);
  const [loadingStorage, setLoadingStorage] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [scanningLan, setScanningLan] = useState(false);
  const [lanScanResults, setLanScanResults] = useState<DiscoveredLanServer[]>([]);
  const [lanScanAttempted, setLanScanAttempted] = useState(false);
  const [lanPromptOpen, setLanPromptOpen] = useState(false);

  const canManageServer = user?.role === 'owner' || user?.role === 'admin';

  const loadLocalCache = useCallback(async () => {
    try {
      const snap = await fetchCacheSnapshot({ syncRunning: syncSnap.running });
      setCacheSnap(snap);
    } catch {
      // Non-fatal in environments without native cache inspection.
    }
  }, [syncSnap.running]);

  const loadStorage = useCallback(async () => {
    if (!client) return;
    try {
      const [acct, srv, sess, devs] = await Promise.all([
        client.getStorage().catch(() => null),
        canManageServer ? client.getServerStorage().catch(() => null) : Promise.resolve(null),
        client.listSessions().catch(() => [] as BrowserSession[]),
        client.listDevices().catch(() => [] as BackupDevice[]),
      ]);
      if (acct) setStorage(acct);
      setServerStorage(srv);
      setSessions(sess);
      setDevices(devs.filter((d) => !d.revoked_at));
    } finally {
      setLoadingStorage(false);
      setRefreshing(false);
    }
  }, [client, canManageServer]);

  useEffect(() => {
    void loadStorage();
  }, [loadStorage]);

  useFocusEffect(
    useCallback(() => {
      void loadLocalCache();
    }, [loadLocalCache]),
  );

  const confirmQuickClearCache = () => {
    if (!cacheSnap || clearingCache) return;
    Alert.alert(
      'Clear Local App Cache?',
      `Free ${formatBytes(cacheSnap.totalCacheBytes)} (${cacheSnap.totalFileCount} cached files) on this device? Your NAS files, login session, and photo sync ledger will stay intact.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Clear Cache',
          style: 'destructive',
          onPress: () => {
            void (async () => {
              setClearingCache(true);
              try {
                const res = await clearAllCaches({ syncRunning: syncSnap.running });
                setCacheSnap(res.snapshot);
                void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
                const msg =
                  res.freedBytes > 0
                    ? `Freed ${formatBytes(res.freedBytes)} across ${res.freedFiles} cached ${res.freedFiles === 1 ? 'file' : 'files'}.`
                    : 'Local cache is clean.';
                Alert.alert(
                  'Cache Cleared',
                  res.warnings.length > 0 ? `${msg}\n\n${res.warnings.join('\n')}` : msg,
                );
              } catch (err) {
                Alert.alert('Clear Failed', err instanceof Error ? err.message : String(err));
              } finally {
                setClearingCache(false);
              }
            })();
          },
        },
      ],
    );
  };

  const confirmSwitchServer = () => {
    Alert.alert(
      'Change NAS Server?',
      'You will sign out of the current session and return to server setup.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Switch Server',
          style: 'destructive',
          onPress: () => {
            void switchServer();
          },
        },
      ],
    );
  };

  const confirmSignOut = () => {
    Alert.alert('Sign Out?', 'Clear your active MyDrive session from this iPhone?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Sign Out',
        style: 'destructive',
        onPress: () => {
          void logout();
        },
      },
    ]);
  };

  const confirmRevokeSession = (session: BrowserSession) => {
    if (!client || session.is_current) return;
    const title =
      session.device_label?.trim() ||
      (session.client_type === 'mobile' ? 'Mobile App' : 'Web Browser');
    Alert.alert(
      'Revoke Session?',
      `Sign out "${title}"${session.ip_address ? ` (${session.ip_address})` : ''}? It will need to sign in again.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Sign Out',
          style: 'destructive',
          onPress: () => {
            void (async () => {
              try {
                await client.revokeSession(session.id);
                setSessions((prev) => prev.filter((item) => item.id !== session.id));
                void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
              } catch (err) {
                Alert.alert('Failed', err instanceof Error ? err.message : String(err));
              }
            })();
          },
        },
      ],
    );
  };

  const confirmSignOutOtherSessions = () => {
    if (!client) return;
    Alert.alert(
      'Sign Out Other Sessions?',
      'All other browser and mobile sessions will be signed out immediately.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Sign Out Others',
          style: 'destructive',
          onPress: () => {
            void (async () => {
              try {
                await client.revokeOtherSessions();
                void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
                await loadStorage();
              } catch (err) {
                Alert.alert('Failed', err instanceof Error ? err.message : String(err));
              }
            })();
          },
        },
      ],
    );
  };

  const confirmRevokeDevice = (device: BackupDevice) => {
    if (!client) return;
    Alert.alert(
      'Revoke Backup Device?',
      `Disconnect "${device.name}" (${device.operating_system})? Existing backed-up files remain on your NAS.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Revoke',
          style: 'destructive',
          onPress: () => {
            void (async () => {
              try {
                await client.revokeDevice(device.id);
                setDevices((prev) => prev.filter((d) => d.id !== device.id));
                void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
              } catch (err) {
                Alert.alert('Failed', err instanceof Error ? err.message : String(err));
              }
            })();
          },
        },
      ],
    );
  };

  const handleScanLan = async () => {
    setScanningLan(true);
    setLanScanAttempted(true);
    try {
      const results = await scanLanServers();
      setLanScanResults(results);
      if (results.length > 0) {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      }
    } finally {
      setScanningLan(false);
    }
  };

  const handleSelectDiscoveredLan = async (url: string) => {
    try {
      await setPairedLanUrl(url);
      setLanScanResults([]);
      setLanScanAttempted(false);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (err) {
      Alert.alert('LAN Pairing Failed', err instanceof Error ? err.message : String(err));
    }
  };

  const isHttps = (lanStatus.activeUrl ?? serverUrl)?.startsWith('https://') ?? false;
  const usedRatio =
    storage && storage.quota_bytes && storage.quota_bytes > 0
      ? Math.min(1, storage.used_bytes / storage.quota_bytes)
      : 0;
  const primaryVolume = serverStorage?.hdd ?? serverStorage?.ssd ?? null;

  return (
    <SafeAreaView style={styles.safeArea} edges={['top']}>
      <View style={styles.header}>
        <Text style={styles.title}>Settings</Text>
      </View>

      <ScrollView
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => {
              setRefreshing(true);
              void Promise.all([loadStorage(), loadLocalCache()]);
            }}
            tintColor={colors.accent}
          />
        }
      >
        <SectionTitle title="Account" />
        <Card style={styles.accountCard}>
          <View style={styles.accountRow}>
            <View style={styles.avatar}>
              <Ionicons name="person" size={22} color={colors.accent} />
            </View>
            <View style={styles.flex}>
              <Text style={styles.emailText} numberOfLines={1}>
                {user?.email}
              </Text>
              <Text style={styles.roleText}>Role: {user?.role}</Text>
            </View>
            <StatusBadge tone="accent" label={user?.role ?? 'member'} />
          </View>

          <AppButton
            title="Change Password"
            icon="key-outline"
            variant="subtle"
            compact
            onPress={() => rootNav.navigate('ChangePassword')}
          />
        </Card>

        <SectionTitle title="NAS Storage" />
        <Card style={styles.storageCard}>
          {loadingStorage ? (
            <ActivityIndicator size="small" color={colors.accent} />
          ) : storage ? (
            <>
              <View style={styles.storageHeader}>
                <Text style={styles.storageUsed}>{formatBytes(storage.used_bytes)}</Text>
                <Text style={styles.storageQuota}>
                  {storage.unlimited || !storage.quota_bytes
                    ? 'Unlimited Quota'
                    : `of ${formatBytes(storage.quota_bytes)} (${Math.round(usedRatio * 100)}%)`}
                </Text>
              </View>
              {!storage.unlimited && storage.quota_bytes ? (
                <View style={styles.quotaTrack}>
                  <View
                    style={[
                      styles.quotaFill,
                      { width: `${Math.max(2, Math.round(usedRatio * 100))}%` },
                    ]}
                  />
                </View>
              ) : null}
              {storage.by_category.length > 0 ? (
                <View style={styles.categoriesWrap}>
                  {storage.by_category.map((cat) => (
                    <View key={cat.category} style={styles.categoryChip}>
                      <Text style={styles.categoryLabel}>
                        {cat.category}: {formatBytes(cat.size_bytes)}
                      </Text>
                    </View>
                  ))}
                </View>
              ) : null}

              {primaryVolume ? (
                <View style={styles.volumeSummaryBox}>
                  <View style={styles.storageHeader}>
                    <Text style={styles.volumeLabel}>NAS Volume</Text>
                    <Text style={styles.storageQuota}>
                      {formatBytes(primaryVolume.used_bytes)} / {formatBytes(primaryVolume.total_bytes)} ({Math.round(primaryVolume.percent_used)}%)
                    </Text>
                  </View>
                  <View style={styles.quotaTrack}>
                    <View
                      style={[
                        styles.quotaFill,
                        {
                          width: `${Math.max(2, Math.min(100, Math.round(primaryVolume.percent_used)))}%`,
                          backgroundColor:
                            primaryVolume.percent_used >= 90
                              ? colors.danger
                              : primaryVolume.percent_used >= 75
                                ? colors.warning
                                : colors.accent,
                        },
                      ]}
                    />
                  </View>
                </View>
              ) : null}

              <View style={styles.storageActionRow}>
                {canManageServer ? (
                  <AppButton
                    title="NAS Storage Manager"
                    icon="hardware-chip-outline"
                    variant="secondary"
                    compact
                    style={styles.flex}
                    onPress={() => rootNav.navigate('NasStorage')}
                  />
                ) : null}
                <AppButton
                  title={
                    storage.trash_count && storage.trash_count > 0
                      ? `Trash (${storage.trash_count})`
                      : 'Trash'
                  }
                  icon="trash-outline"
                  variant="subtle"
                  compact
                  style={styles.flex}
                  onPress={() => rootNav.navigate('Trash')}
                />
              </View>
            </>
          ) : (
            <Text style={styles.unavailableText}>Storage details unavailable.</Text>
          )}
        </Card>

        <SectionTitle title="Local App Cache" />
        <Card style={styles.storageCard}>
          {cacheSnap ? (
            <>
              <View style={styles.storageHeader}>
                <Text style={styles.storageUsed}>{formatBytes(cacheSnap.totalCacheBytes)}</Text>
                <Text style={styles.storageQuota}>
                  {cacheSnap.totalFileCount} {cacheSnap.totalFileCount === 1 ? 'file' : 'files'}
                  {cacheSnap.deviceFreeBytes > 0
                    ? ` · ${formatBytes(cacheSnap.deviceFreeBytes)} free`
                    : ''}
                </Text>
              </View>
              {cacheSnap.totalCacheBytes > 0 ? (
                <View style={styles.cacheStackBar}>
                  {cacheSnap.categories
                    .filter((cat) => cat.sizeBytes > 0)
                    .map((cat) => (
                      <View
                        key={cat.id}
                        style={{
                          width: `${Math.max(3, cat.percentOfCache)}%`,
                          backgroundColor: cat.color,
                        }}
                      />
                    ))}
                </View>
              ) : null}
              <View style={styles.categoriesWrap}>
                {cacheSnap.categories
                  .filter((cat) => cat.sizeBytes > 0)
                  .map((cat) => (
                    <View key={cat.id} style={styles.categoryChip}>
                      <View style={[styles.cacheChipDot, { backgroundColor: cat.color }]} />
                      <Text style={styles.categoryLabel}>
                        {cat.title.split(' ')[0]}: {formatBytes(cat.sizeBytes)}
                      </Text>
                    </View>
                  ))}
              </View>
              <Text style={styles.deviceMeta}>
                {cacheSnap.history.lastClearedAt
                  ? `Last cleared ${formatShortDate(cacheSnap.history.lastClearedAt)} · Total freed ${formatBytes(cacheSnap.history.totalClearedBytes)}`
                  : `Auto-clean ${cacheSnap.settings.autoCleanExpiredTemp ? `enabled (${cacheSnap.settings.tempRetentionDays}d)` : 'disabled'}`}
              </Text>
              <View style={styles.storageActionRow}>
                <AppButton
                  title="Manage Cache"
                  icon="analytics-outline"
                  variant="secondary"
                  compact
                  style={styles.flex}
                  onPress={() => rootNav.navigate('CacheManagement')}
                />
                <AppButton
                  title="Clear Cache"
                  icon="trash-outline"
                  variant="subtle"
                  compact
                  loading={clearingCache}
                  disabled={
                    clearingCache ||
                    (cacheSnap.totalCacheBytes === 0 && cacheSnap.totalFileCount === 0)
                  }
                  style={styles.flex}
                  onPress={confirmQuickClearCache}
                />
              </View>
            </>
          ) : (
            <View style={styles.storageActionRow}>
              <ActivityIndicator size="small" color={colors.accent} />
              <AppButton
                title="Manage Cache"
                icon="analytics-outline"
                variant="secondary"
                compact
                style={styles.flex}
                onPress={() => rootNav.navigate('CacheManagement')}
              />
            </View>
          )}
        </Card>

        <SectionTitle title="NAS Connection & LAN" />
        <Card style={styles.serverCard}>
          <View style={styles.lanHeaderRow}>
            <LanStatusBadge />
            <Pressable
              onPress={() => void refreshLanStatus(true)}
              style={({ pressed }) => [styles.lanRefreshBtn, pressed && { opacity: 0.7 }]}
            >
              <Ionicons name="refresh" size={15} color={colors.accent} />
              <Text style={styles.lanRefreshText}>Check Now</Text>
            </Pressable>
          </View>
          <KeyValueRow label="Active Endpoint" value={lanStatus.activeUrl ?? serverUrl ?? '—'} />
          {lanStatus.pairedLanUrl && lanStatus.pairedLanUrl !== serverUrl ? (
            <KeyValueRow label="Primary URL" value={serverUrl ?? '—'} />
          ) : null}
          <KeyValueRow
            label="Paired LAN Address"
            value={lanStatus.pairedLanUrl ?? (lanStatus.isOnLan ? (lanStatus.activeUrl ?? 'Active') : 'Not paired')}
          />
          <KeyValueRow
            label="Mode & Speed"
            value={
              lanStatus.isOnLan
                ? lanStatus.latencyMs != null
                  ? `Direct LAN (${lanStatus.latencyMs} ms)`
                  : 'Direct LAN'
                : lanStatus.mode === 'offline'
                  ? 'Offline'
                  : isHttps
                    ? 'Remote (HTTPS)'
                    : 'Remote / Tunnel'
            }
          />
          {lanStatus.localIp ? (
            <KeyValueRow label="Device Wi-Fi IP" value={lanStatus.localIp} />
          ) : null}
          <KeyValueRow
            label="Server Version"
            value={capabilities?.serverVersion ? `v${capabilities.serverVersion}` : 'Connected'}
          />
          <KeyValueRow
            label="Hash Algorithm"
            value={capabilities?.features.contentHash?.toUpperCase() ?? 'SHA-256'}
            last
          />

          <View style={styles.lanSwitchRow}>
            <View style={styles.flex}>
              <Text style={styles.lanSwitchLabel}>Auto-Switch on Same LAN</Text>
              <Text style={styles.lanSwitchSub}>
                Automatically connect via local Wi-Fi IP for faster uploads and browsing
              </Text>
            </View>
            <Switch
              value={lanStatus.autoSwitchLan}
              onValueChange={(value) => {
                void setAutoSwitchLan(value);
              }}
              trackColor={{ false: colors.lineStrong, true: colors.accent }}
            />
          </View>

          <View style={styles.lanActionRow}>
            <AppButton
              title={scanningLan ? 'Scanning…' : 'Scan LAN'}
              icon="wifi-outline"
              variant="secondary"
              compact
              loading={scanningLan}
              onPress={() => void handleScanLan()}
              style={styles.flex}
            />
            <AppButton
              title="Set LAN IP"
              icon="create-outline"
              variant="subtle"
              compact
              onPress={() => setLanPromptOpen(true)}
              style={styles.flex}
            />
          </View>

          {lanStatus.pairedLanUrl ? (
            <AppButton
              title="Clear Paired LAN URL"
              icon="close-circle-outline"
              variant="subtle"
              compact
              onPress={() => {
                void setPairedLanUrl(null);
              }}
            />
          ) : null}

          {lanScanAttempted ? (
            lanScanResults.length > 0 ? (
              <View style={styles.lanScanBox}>
                <Text style={styles.deviceHeader}>
                  Discovered NAS ({lanScanResults.length})
                </Text>
                {lanScanResults.map((srv) => (
                  <Pressable
                    key={srv.url}
                    onPress={() => void handleSelectDiscoveredLan(srv.url)}
                    style={({ pressed }) => [
                      styles.lanResultRow,
                      pressed && { opacity: 0.72 },
                    ]}
                  >
                    <View style={styles.flex}>
                      <Text style={styles.deviceName} numberOfLines={1}>
                        {srv.url}
                      </Text>
                      <Text style={styles.deviceMeta}>
                        {srv.matchedServerId ? 'Verified Same NAS · ' : ''}
                        {srv.serverVersion ? `v${srv.serverVersion} · ` : ''}
                        {srv.latencyMs} ms
                      </Text>
                    </View>
                    <Text style={styles.lanUseText}>Use LAN</Text>
                  </Pressable>
                ))}
              </View>
            ) : !scanningLan ? (
              <Text style={styles.deviceMeta}>
                No MyDrive NAS detected on the current Wi-Fi subnet.
              </Text>
            ) : null
          ) : null}

          <AppButton
            title="Change NAS URL"
            icon="swap-horizontal-outline"
            variant="secondary"
            compact
            onPress={confirmSwitchServer}
            style={styles.switchServerBtn}
          />
        </Card>

        <SectionTitle title="Security & Active Sessions" />
        <Card style={styles.serverCard}>
          <View style={styles.sessionHeaderRow}>
            <Text style={styles.deviceHeader}>Active Sessions ({sessions.length})</Text>
            <Pressable
              onPress={() => void loadStorage()}
              hitSlop={8}
              style={styles.lanRefreshBtn}
            >
              <Ionicons name="refresh-outline" size={14} color={colors.accent} />
              <Text style={styles.lanRefreshText}>Refresh</Text>
            </Pressable>
          </View>
          {sessions.length > 0 ? (
            <View style={styles.sessionList}>
              {sessions.map((sess) => {
                const isMobile = sess.client_type === 'mobile';
                const label =
                  sess.device_label?.trim() ||
                  (isMobile ? 'MyDrive Mobile App' : 'Web Browser');
                return (
                  <View key={sess.id} style={styles.sessionRow}>
                    <View style={styles.sessionIconWrap}>
                      <Ionicons
                        name={isMobile ? 'phone-portrait-outline' : 'desktop-outline'}
                        size={17}
                        color={colors.accent}
                      />
                    </View>
                    <View style={styles.flex}>
                      <View style={styles.sessionTitleRow}>
                        <Text style={styles.deviceName} numberOfLines={1}>
                          {label}
                        </Text>
                        {sess.is_current ? (
                          <StatusBadge tone="accent" label="Current" />
                        ) : null}
                        <StatusBadge
                          tone="neutral"
                          label={isMobile ? 'Mobile' : 'Web'}
                        />
                      </View>
                      <Text style={styles.deviceMeta}>
                        {sess.ip_address ? `IP ${sess.ip_address} · ` : ''}
                        Last active {formatShortDate(sess.last_seen_at ?? sess.created_at)}
                      </Text>
                      <Text style={styles.deviceMeta}>
                        Signed in {formatShortDate(sess.created_at)} · Expires{' '}
                        {formatShortDate(sess.expires_at)}
                      </Text>
                    </View>
                    {!sess.is_current ? (
                      <Pressable
                        onPress={() => confirmRevokeSession(sess)}
                        hitSlop={8}
                        style={styles.revokeBtn}
                      >
                        <Text style={styles.revokeBtnText}>Sign Out</Text>
                      </Pressable>
                    ) : null}
                  </View>
                );
              })}
            </View>
          ) : (
            <Text style={styles.deviceMeta}>No active sessions found.</Text>
          )}
          {sessions.length > 1 ? (
            <AppButton
              title="Sign Out Other Sessions"
              icon="shield-checkmark-outline"
              variant="subtle"
              compact
              onPress={confirmSignOutOtherSessions}
              style={styles.switchServerBtn}
            />
          ) : null}
          {devices.length > 0 ? (
            <View style={styles.deviceList}>
              <Text style={styles.deviceHeader}>Connected Backup Clients ({devices.length})</Text>
              {devices.map((dev) => (
                <View key={dev.id} style={styles.deviceRow}>
                  <View style={styles.flex}>
                    <Text style={styles.deviceName} numberOfLines={1}>
                      {dev.name}
                    </Text>
                    <Text style={styles.deviceMeta} numberOfLines={1}>
                      {dev.operating_system} · {dev.client_name}
                      {dev.last_active_at ? ` · ${formatShortDate(dev.last_active_at)}` : ''}
                    </Text>
                  </View>
                  <Pressable
                    onPress={() => confirmRevokeDevice(dev)}
                    hitSlop={8}
                    style={styles.revokeBtn}
                  >
                    <Text style={styles.revokeBtnText}>Revoke</Text>
                  </Pressable>
                </View>
              ))}
            </View>
          ) : null}
        </Card>

        <AppButton
          title="Sign Out"
          icon="log-out-outline"
          variant="danger"
          onPress={confirmSignOut}
        />
      </ScrollView>

      <TextPromptModal
        visible={lanPromptOpen}
        title="Pair LAN NAS URL"
        message="Enter the local Wi-Fi IP or hostname of this MyDrive NAS (e.g. http://192.168.1.50:3000)."
        initialValue={lanStatus.pairedLanUrl ?? 'http://192.168.1.'}
        placeholder="http://192.168.1.50:3000"
        confirmLabel="Verify & Save"
        onCancel={() => setLanPromptOpen(false)}
        onSubmit={async (value) => {
          await setPairedLanUrl(value);
          setLanPromptOpen(false);
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        }}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  flex: {
    flex: 1,
  },
  header: {
    backgroundColor: colors.surface,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
  },
  title: {
    fontSize: 26,
    fontWeight: '800',
    color: colors.ink,
    letterSpacing: -0.5,
  },
  scrollContent: {
    padding: spacing.lg,
    gap: spacing.lg,
    paddingBottom: spacing.xxxl,
  },
  accountCard: {
    gap: spacing.md,
  },
  accountRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  avatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: colors.accentTint,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emailText: {
    fontSize: 15.5,
    fontWeight: '700',
    color: colors.ink,
  },
  roleText: {
    fontSize: 12.5,
    color: colors.muted,
    marginTop: 2,
  },
  storageCard: {
    gap: spacing.md,
  },
  storageHeader: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  storageUsed: {
    fontSize: 20,
    fontWeight: '800',
    color: colors.ink,
  },
  storageQuota: {
    fontSize: 13,
    color: colors.muted,
    fontWeight: '600',
  },
  quotaTrack: {
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.surfaceSubtle,
    overflow: 'hidden',
  },
  quotaFill: {
    height: '100%',
    borderRadius: 4,
    backgroundColor: colors.accent,
  },
  categoriesWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs + 2,
  },
  categoryChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: spacing.sm + 2,
    paddingVertical: 5,
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceSubtle,
    borderWidth: 1,
    borderColor: colors.line,
  },
  cacheStackBar: {
    flexDirection: 'row',
    height: 8,
    borderRadius: 4,
    overflow: 'hidden',
    backgroundColor: colors.surfaceSubtle,
    gap: 1,
  },
  cacheChipDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
  },
  categoryLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.inkSoft,
  },
  unavailableText: {
    fontSize: 13.5,
    color: colors.muted,
  },
  serverCard: {
    gap: spacing.xs,
  },
  lanHeaderRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    marginBottom: spacing.xs,
  },
  lanRefreshBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
  },
  lanRefreshText: {
    fontSize: 12.5,
    fontWeight: '700',
    color: colors.accent,
  },
  lanSwitchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingTop: spacing.sm,
    marginTop: spacing.xs,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.line,
  },
  lanSwitchLabel: {
    fontSize: 14,
    fontWeight: '700',
    color: colors.ink,
  },
  lanSwitchSub: {
    fontSize: 12,
    color: colors.muted,
    marginTop: 2,
    lineHeight: 16,
  },
  lanActionRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  lanScanBox: {
    marginTop: spacing.sm,
    paddingTop: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.line,
    gap: spacing.xs + 2,
  },
  lanResultRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.xs + 2,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceSubtle,
    borderWidth: 1,
    borderColor: colors.line,
  },
  lanUseText: {
    fontSize: 12.5,
    fontWeight: '700',
    color: colors.accent,
  },
  switchServerBtn: {
    marginTop: spacing.sm,
  },
  volumeSummaryBox: {
    gap: spacing.xs,
    paddingTop: spacing.xs,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.line,
  },
  volumeLabel: {
    fontSize: 13.5,
    fontWeight: '700',
    color: colors.ink,
  },
  storageActionRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginTop: spacing.xs,
  },
  deviceList: {
    marginTop: spacing.sm,
    paddingTop: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.line,
    gap: spacing.sm,
  },
  deviceHeader: {
    fontSize: 12.5,
    fontWeight: '700',
    color: colors.muted,
    textTransform: 'uppercase',
  },
  deviceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  deviceName: {
    fontSize: 14,
    fontWeight: '700',
    color: colors.ink,
  },
  deviceMeta: {
    fontSize: 12,
    color: colors.muted,
    marginTop: 1,
  },
  revokeBtn: {
    paddingHorizontal: spacing.sm + 2,
    paddingVertical: 5,
    borderRadius: radius.pill,
    backgroundColor: colors.dangerTint,
    borderWidth: 1,
    borderColor: colors.dangerBorder,
  },
  revokeBtnText: {
    fontSize: 12,
    fontWeight: '700',
    color: colors.danger,
  },
  sessionHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  sessionList: {
    gap: spacing.sm,
    marginTop: spacing.xs,
  },
  sessionRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    paddingTop: spacing.xs + 2,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.line,
  },
  sessionIconWrap: {
    width: 30,
    height: 30,
    borderRadius: 8,
    backgroundColor: colors.surfaceSubtle,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 2,
  },
  sessionTitleRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 6,
    marginBottom: 2,
  },
});
