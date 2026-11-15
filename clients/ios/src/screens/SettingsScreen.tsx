import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import * as Haptics from 'expo-haptics';
import { Ionicons } from '@expo/vector-icons';

import {
  AppButton,
  Card,
  KeyValueRow,
  SectionTitle,
  StatusBadge,
} from '../components/UiPrimitives';
import { useAuth } from '../context/AuthContext';
import type { RootStackParamList } from '../navigation/types';
import { formatBytes, formatShortDate } from '../services/format';
import { colors, radius, spacing } from '../theme/tokens';
import type {
  AccountStorage,
  BackupDevice,
  BrowserSession,
  ServerStorage,
} from '../types/mydrive';

export function SettingsScreen() {
  const { user, serverUrl, capabilities, client, switchServer, logout } = useAuth();
  const rootNav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const [storage, setStorage] = useState<AccountStorage | null>(null);
  const [serverStorage, setServerStorage] = useState<ServerStorage | null>(null);
  const [sessions, setSessions] = useState<BrowserSession[]>([]);
  const [devices, setDevices] = useState<BackupDevice[]>([]);
  const [loadingStorage, setLoadingStorage] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const canManageServer = user?.role === 'owner' || user?.role === 'admin';

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

  const isHttps = serverUrl?.startsWith('https://') ?? false;
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
              void loadStorage();
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

        <SectionTitle title="Connected NAS Server" />
        <Card style={styles.serverCard}>
          <KeyValueRow label="URL" value={serverUrl ?? '—'} />
          <KeyValueRow
            label="Transport"
            value={isHttps ? 'HTTPS Encrypted' : 'HTTP Local / VPN'}
          />
          <KeyValueRow
            label="Server Version"
            value={capabilities?.serverVersion ? `v${capabilities.serverVersion}` : 'Connected'}
          />
          <KeyValueRow
            label="Hash Algorithm"
            value={capabilities?.features.contentHash?.toUpperCase() ?? 'SHA-256'}
            last
          />
          <AppButton
            title="Change NAS URL"
            icon="swap-horizontal-outline"
            variant="secondary"
            compact
            onPress={confirmSwitchServer}
            style={styles.switchServerBtn}
          />
        </Card>

        <SectionTitle title="Security & Backup Devices" />
        <Card style={styles.serverCard}>
          <KeyValueRow
            label="Active Sessions"
            value={`${sessions.length}`}
            last={devices.length === 0 && sessions.length <= 1}
          />
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
    paddingHorizontal: spacing.sm + 2,
    paddingVertical: 5,
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceSubtle,
    borderWidth: 1,
    borderColor: colors.line,
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
});
