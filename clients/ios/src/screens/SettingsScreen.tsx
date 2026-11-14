import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
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
import { formatBytes } from '../services/format';
import { colors, radius, spacing } from '../theme/tokens';
import type { AccountStorage } from '../types/mydrive';

export function SettingsScreen() {
  const { user, serverUrl, capabilities, client, switchServer, logout } = useAuth();
  const rootNav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const [storage, setStorage] = useState<AccountStorage | null>(null);
  const [loadingStorage, setLoadingStorage] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const loadStorage = useCallback(async () => {
    if (!client) return;
    try {
      const res = await client.getStorage();
      setStorage(res);
    } catch {
      // Non-fatal if storage endpoint is slow.
    } finally {
      setLoadingStorage(false);
      setRefreshing(false);
    }
  }, [client]);

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

  const isHttps = serverUrl?.startsWith('https://') ?? false;
  const usedRatio =
    storage && storage.quota_bytes && storage.quota_bytes > 0
      ? Math.min(1, storage.used_bytes / storage.quota_bytes)
      : 0;

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
});
