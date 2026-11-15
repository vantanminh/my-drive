import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import * as Haptics from 'expo-haptics';
import { Ionicons } from '@expo/vector-icons';

import {
  ShareLinkModal,
  type ShareTargetSubject,
} from '../components/ShareLinkModal';
import {
  AppButton,
  Banner,
  Card,
  SectionTitle,
  StatusBadge,
} from '../components/UiPrimitives';
import { useAuth } from '../context/AuthContext';
import type { RootStackParamList } from '../navigation/types';
import { formatBytes } from '../services/format';
import { colors, radius, spacing } from '../theme/tokens';
import type {
  AccountStorage,
  CategoryUsage,
  LargestFile,
  ManagedAccount,
  ServerStorage,
  VolumeStatus,
} from '../types/mydrive';

const CATEGORY_COLORS: Record<string, string> = {
  image: '#14694f',
  video: '#366899',
  audio: '#7b55a3',
  document: '#b86e2e',
  archive: '#5b6c79',
  other: '#94a3b0',
};

const QUOTA_PRESETS_GB = [10, 50, 100, 500, 1024];

function categoryColor(category: string): string {
  return CATEGORY_COLORS[category] ?? CATEGORY_COLORS.other;
}

function usageTint(percent: number): string {
  if (percent >= 90) return colors.danger;
  if (percent >= 75) return colors.warning;
  return colors.accent;
}

function VolumeCard({
  title,
  subtitle,
  icon,
  volume,
}: {
  title: string;
  subtitle: string;
  icon: keyof typeof Ionicons.glyphMap;
  volume: VolumeStatus;
}) {
  const pct = Math.min(100, Math.max(0, volume.percent_used));
  const fillColor = usageTint(pct);
  return (
    <Card style={styles.volumeCard}>
      <View style={styles.volumeTop}>
        <View style={styles.volumeIcon}>
          <Ionicons name={icon} size={20} color={fillColor} />
        </View>
        <View style={styles.flex}>
          <Text style={styles.volumeTitle}>{title}</Text>
          <Text style={styles.volumeSub}>{subtitle}</Text>
        </View>
        <Text style={[styles.volumePct, { color: fillColor }]}>
          {pct.toFixed(0)}%
        </Text>
      </View>
      <View style={styles.meterTrack}>
        <View
          style={[
            styles.meterFill,
            { width: `${Math.max(3, Math.round(pct))}%`, backgroundColor: fillColor },
          ]}
        />
      </View>
      <View style={styles.volumeFooter}>
        <Text style={styles.volumeStat}>Used: {formatBytes(volume.used_bytes)}</Text>
        <Text style={styles.volumeStat}>Free: {formatBytes(volume.free_bytes)}</Text>
        <Text style={styles.volumeStat}>Total: {formatBytes(volume.total_bytes)}</Text>
      </View>
    </Card>
  );
}

function CategoryBreakdownCard({
  title,
  rows,
}: {
  title: string;
  rows: CategoryUsage[];
}) {
  const totalBytes = rows.reduce((sum, item) => sum + item.size_bytes, 0);
  return (
    <Card style={styles.blockCard}>
      <Text style={styles.cardHeading}>{title}</Text>
      {rows.length === 0 || totalBytes <= 0 ? (
        <Text style={styles.mutedText}>No indexed files using storage yet.</Text>
      ) : (
        <>
          <View style={styles.stackBar}>
            {rows.map((row) => (
              <View
                key={row.category}
                style={{
                  width: `${Math.max(2, (row.size_bytes / totalBytes) * 100)}%`,
                  backgroundColor: categoryColor(row.category),
                }}
              />
            ))}
          </View>
          <View style={styles.legendList}>
            {rows.map((row) => {
              const pct = Math.round((row.size_bytes / totalBytes) * 100);
              return (
                <View key={row.category} style={styles.legendRow}>
                  <View
                    style={[
                      styles.legendDot,
                      { backgroundColor: categoryColor(row.category) },
                    ]}
                  />
                  <Text style={styles.legendName}>{row.category}</Text>
                  <Text style={styles.legendMeta}>
                    {row.file_count} {row.file_count === 1 ? 'file' : 'files'} ({pct}%)
                  </Text>
                  <Text style={styles.legendBytes}>{formatBytes(row.size_bytes)}</Text>
                </View>
              );
            })}
          </View>
        </>
      )}
    </Card>
  );
}

export function NasStorageScreen() {
  const { user, client } = useAuth();
  const rootNav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const isOperator = user?.role === 'owner' || user?.role === 'admin';
  const isOwner = user?.role === 'owner';

  const [account, setAccount] = useState<AccountStorage | null>(null);
  const [server, setServer] = useState<ServerStorage | null>(null);
  const [managedAccounts, setManagedAccounts] = useState<ManagedAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const [shareSubject, setShareSubject] = useState<ShareTargetSubject | null>(null);
  const [quotaTarget, setQuotaTarget] = useState<{
    id: string;
    email: string;
    usedBytes: number;
    currentQuotaBytes: number | null;
  } | null>(null);
  const [quotaGbInput, setQuotaGbInput] = useState('');
  const [savingQuota, setSavingQuota] = useState(false);

  const loadAll = useCallback(async () => {
    if (!client) return;
    setErrorMsg(null);
    try {
      const [accRes, srvRes, membersRes] = await Promise.all([
        client.getStorage(),
        isOperator ? client.getServerStorage().catch(() => null) : Promise.resolve(null),
        isOwner ? client.listManagedAccounts(0, 50).catch(() => null) : Promise.resolve(null),
      ]);
      setAccount(accRes);
      setServer(srvRes);
      setManagedAccounts(membersRes?.accounts ?? []);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [client, isOperator, isOwner]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const handleTrashLargestFile = (file: LargestFile) => {
    if (!client) return;
    Alert.alert(
      'Move Large File to Trash?',
      `Move "${file.name}" (${formatBytes(file.size_bytes)}) to Trash? You can purge Trash afterwards to free physical disk space.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Move to Trash',
          style: 'destructive',
          onPress: () => {
            void (async () => {
              try {
                await client.trashEntry(file.id);
                void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
                await loadAll();
              } catch (err) {
                Alert.alert('Action Failed', err instanceof Error ? err.message : String(err));
              }
            })();
          },
        },
      ],
    );
  };

  const openQuotaModal = (entry: {
    id: string;
    email: string;
    usedBytes: number;
    currentQuotaBytes: number | null;
  }) => {
    setQuotaTarget(entry);
    const currentGb =
      entry.currentQuotaBytes && entry.currentQuotaBytes > 0
        ? String(Math.max(1, Math.round(entry.currentQuotaBytes / (1024 * 1024 * 1024))))
        : '100';
    setQuotaGbInput(currentGb);
  };

  const handleSaveQuota = async () => {
    if (!client || !quotaTarget || savingQuota) return;
    const gb = Number(quotaGbInput.trim());
    if (!Number.isFinite(gb) || gb <= 0) {
      Alert.alert('Invalid Quota', 'Enter a positive quota in GB.');
      return;
    }
    const quotaBytes = Math.round(gb * 1024 * 1024 * 1024);
    if (quotaBytes < quotaTarget.usedBytes) {
      Alert.alert(
        'Quota Too Low',
        `This account currently uses ${formatBytes(quotaTarget.usedBytes)}. Choose a larger limit.`,
      );
      return;
    }
    setSavingQuota(true);
    try {
      await client.updateManagedAccount(quotaTarget.id, { quotaBytes });
      setQuotaTarget(null);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      await loadAll();
    } catch (err) {
      Alert.alert('Update Failed', err instanceof Error ? err.message : String(err));
    } finally {
      setSavingQuota(false);
    }
  };

  const largestFiles = server?.largest_files ?? account?.largest_files ?? [];
  const trashCount = server?.trash_count ?? account?.trash_count ?? 0;
  const trashBytes = server?.trash_bytes ?? account?.trash_bytes ?? 0;

  if (loading && !account) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={colors.accent} />
      </View>
    );
  }

  return (
    <View style={styles.root}>
      <ScrollView
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => {
              setRefreshing(true);
              void loadAll();
            }}
            tintColor={colors.accent}
          />
        }
      >
        {errorMsg ? (
          <Banner tone="danger" icon="alert-circle-outline" message={errorMsg} />
        ) : null}

        {isOperator && server ? (
          <>
            <SectionTitle title="NAS Physical Disks" />
            {server.hdd ? (
              <VolumeCard
                title="HDD • Original Files Storage"
                subtitle={`Library files: ${formatBytes(server.library_bytes)}`}
                icon="hardware-chip-outline"
                volume={server.hdd}
              />
            ) : null}
            {server.ssd && !server.same_volume ? (
              <VolumeCard
                title="SSD • App, DB & Preview Cache"
                subtitle="Thumbnails, media previews & database index"
                icon="flash-outline"
                volume={server.ssd}
              />
            ) : null}
            {server.same_volume ? (
              <Text style={styles.noteText}>
                SSD preview cache and HDD storage currently share the same physical filesystem ({formatBytes(server.system_used_bytes)} total in use).
              </Text>
            ) : null}
          </>
        ) : null}

        {account ? (
          <>
            <SectionTitle title="Your Account Quota" />
            <Card style={styles.blockCard}>
              <View style={styles.quotaTop}>
                <View style={styles.flex}>
                  <Text style={styles.quotaUsed}>{formatBytes(account.used_bytes)}</Text>
                  <Text style={styles.quotaSub}>
                    {account.unlimited || !account.quota_bytes
                      ? 'Unlimited account quota'
                      : `of ${formatBytes(account.quota_bytes)} • ${formatBytes(account.available_bytes)} free`}
                  </Text>
                </View>
                {account.percent_used != null ? (
                  <StatusBadge
                    tone={account.percent_used >= 90 ? 'danger' : 'accent'}
                    label={`${Math.round(account.percent_used)}%`}
                  />
                ) : (
                  <StatusBadge tone="accent" label="Unlimited" />
                )}
              </View>
              {!account.unlimited && account.quota_bytes ? (
                <View style={styles.meterTrack}>
                  <View
                    style={[
                      styles.meterFill,
                      {
                        width: `${Math.max(3, Math.min(100, Math.round(account.percent_used ?? 0)))}%`,
                        backgroundColor: usageTint(account.percent_used ?? 0),
                      },
                    ]}
                  />
                </View>
              ) : null}
              {account.reserved_bytes > 0 ? (
                <Text style={styles.noteText}>
                  {formatBytes(account.reserved_bytes)} reserved by active uploads.
                </Text>
              ) : null}
            </Card>
          </>
        ) : null}

        <Card style={styles.trashBannerCard}>
          <View style={styles.trashRow}>
            <View style={styles.trashIcon}>
              <Ionicons name="trash-outline" size={20} color={colors.warning} />
            </View>
            <View style={styles.flex}>
              <Text style={styles.cardHeading}>Reclaimable Space in Trash</Text>
              <Text style={styles.mutedText}>
                {trashCount > 0
                  ? `${trashCount} trashed ${trashCount === 1 ? 'file' : 'files'} holding ${formatBytes(trashBytes)}`
                  : 'Trash is empty — no deleted files holding disk space.'}
              </Text>
            </View>
          </View>
          <AppButton
            title={trashCount > 0 ? `Review & Empty Trash (${formatBytes(trashBytes)})` : 'Open Trash'}
            icon="trash-bin-outline"
            variant={trashCount > 0 ? 'secondary' : 'subtle'}
            compact
            onPress={() => rootNav.navigate('Trash')}
          />
        </Card>

        <CategoryBreakdownCard
          title={isOperator && server ? 'NAS Library by Type' : 'Your Files by Type'}
          rows={server?.by_category ?? account?.by_category ?? []}
        />

        {isOperator && server && server.users.length > 0 ? (
          <>
            <SectionTitle title="Accounts Storage Usage" />
            <Card style={styles.blockCard}>
              {server.users.map((row, idx) => {
                const isLast = idx === server.users.length - 1;
                const managed = managedAccounts.find((m) => m.id === row.id);
                const editableMember = isOwner && row.role === 'member';
                return (
                  <View
                    key={row.id}
                    style={[styles.userRow, !isLast && styles.rowDivider]}
                  >
                    <View style={styles.flex}>
                      <View style={styles.userTitleRow}>
                        <Text style={styles.userEmail} numberOfLines={1}>
                          {row.email}
                        </Text>
                        <StatusBadge
                          tone={managed?.disabledAt ? 'danger' : 'neutral'}
                          label={managed?.disabledAt ? 'Disabled' : row.role}
                        />
                      </View>
                      <Text style={styles.mutedText}>
                        {formatBytes(row.used_bytes)}
                        {row.quota_bytes ? ` / ${formatBytes(row.quota_bytes)}` : ''} •{' '}
                        {row.percent_of_library.toFixed(1)}% of library
                        {row.percent_of_hdd != null
                          ? ` • ${row.percent_of_hdd.toFixed(1)}% of HDD`
                          : ''}
                      </Text>
                    </View>
                    {editableMember ? (
                      <Pressable
                        onPress={() =>
                          openQuotaModal({
                            id: row.id,
                            email: row.email,
                            usedBytes: row.used_bytes,
                            currentQuotaBytes: row.quota_bytes,
                          })
                        }
                        style={styles.quotaEditBtn}
                      >
                        <Text style={styles.quotaEditText}>Quota</Text>
                      </Pressable>
                    ) : null}
                  </View>
                );
              })}
            </Card>
          </>
        ) : null}

        <SectionTitle title={isOperator ? 'Largest Files on NAS' : 'Your Largest Files'} />
        <Card style={styles.blockCard}>
          {largestFiles.length === 0 ? (
            <Text style={styles.mutedText}>No indexed files found yet.</Text>
          ) : (
            largestFiles.map((file, idx) => {
              const isLast = idx === largestFiles.length - 1;
              return (
                <View
                  key={file.id}
                  style={[styles.fileRow, !isLast && styles.rowDivider]}
                >
                  <View style={styles.flex}>
                    <Text style={styles.fileName} numberOfLines={1}>
                      {file.name}
                    </Text>
                    <Text style={styles.mutedText}>
                      {file.category} • {formatBytes(file.size_bytes)}
                    </Text>
                  </View>
                  <Pressable
                    onPress={() =>
                      setShareSubject({
                        resourceType: 'file',
                        resourceId: file.id,
                        name: file.name,
                      })
                    }
                    hitSlop={8}
                    style={styles.fileIconBtn}
                  >
                    <Ionicons name="link-outline" size={18} color={colors.accent} />
                  </Pressable>
                  <Pressable
                    onPress={() => handleTrashLargestFile(file)}
                    hitSlop={8}
                    style={styles.fileIconBtn}
                  >
                    <Ionicons name="trash-outline" size={18} color={colors.danger} />
                  </Pressable>
                </View>
              );
            })
          )}
        </Card>
      </ScrollView>

      <ShareLinkModal
        visible={Boolean(shareSubject)}
        subject={shareSubject}
        onClose={() => setShareSubject(null)}
      />

      <Modal
        visible={Boolean(quotaTarget)}
        transparent
        animationType="fade"
        onRequestClose={() => setQuotaTarget(null)}
      >
        <View style={styles.modalBackdrop}>
          <Pressable
            style={StyleSheet.absoluteFill}
            onPress={() => setQuotaTarget(null)}
          />
          {quotaTarget ? (
            <View style={styles.modalCard}>
              <Text style={styles.modalTitle}>Adjust Account Quota</Text>
              <Text style={styles.mutedText}>
                {quotaTarget.email} • Using {formatBytes(quotaTarget.usedBytes)}
              </Text>
              <View style={styles.presetRow}>
                {QUOTA_PRESETS_GB.map((gb) => (
                  <Pressable
                    key={gb}
                    onPress={() => setQuotaGbInput(String(gb))}
                    style={[
                      styles.presetPill,
                      quotaGbInput === String(gb) && styles.presetPillActive,
                    ]}
                  >
                    <Text
                      style={[
                        styles.presetText,
                        quotaGbInput === String(gb) && styles.presetTextActive,
                      ]}
                    >
                      {gb >= 1024 ? `${gb / 1024} TB` : `${gb} GB`}
                    </Text>
                  </Pressable>
                ))}
              </View>
              <View style={styles.inputRow}>
                <TextInput
                  value={quotaGbInput}
                  onChangeText={setQuotaGbInput}
                  keyboardType="numeric"
                  placeholder="Quota in GB"
                  placeholderTextColor={colors.muted}
                  style={styles.gbInput}
                />
                <Text style={styles.gbUnit}>GB</Text>
              </View>
              <View style={styles.modalActions}>
                <AppButton
                  title="Cancel"
                  variant="subtle"
                  compact
                  onPress={() => setQuotaTarget(null)}
                  style={styles.flex}
                />
                <AppButton
                  title="Save Quota"
                  variant="primary"
                  compact
                  loading={savingQuota}
                  onPress={() => void handleSaveQuota()}
                  style={styles.flex}
                />
              </View>
            </View>
          ) : null}
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  flex: {
    flex: 1,
  },
  center: {
    flex: 1,
    backgroundColor: colors.bg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  scrollContent: {
    padding: spacing.lg,
    gap: spacing.md,
    paddingBottom: spacing.xxxl,
  },
  volumeCard: {
    gap: spacing.sm + 2,
  },
  volumeTop: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  volumeIcon: {
    width: 38,
    height: 38,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceSubtle,
    alignItems: 'center',
    justifyContent: 'center',
  },
  volumeTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: colors.ink,
  },
  volumeSub: {
    fontSize: 12.5,
    color: colors.muted,
    marginTop: 2,
  },
  volumePct: {
    fontSize: 17,
    fontWeight: '800',
  },
  meterTrack: {
    height: 9,
    borderRadius: 5,
    backgroundColor: colors.surfaceSubtle,
    overflow: 'hidden',
  },
  meterFill: {
    height: '100%',
    borderRadius: 5,
  },
  volumeFooter: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  volumeStat: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.inkSoft,
  },
  noteText: {
    fontSize: 12.5,
    color: colors.muted,
    lineHeight: 18,
  },
  blockCard: {
    gap: spacing.md,
  },
  cardHeading: {
    fontSize: 15.5,
    fontWeight: '700',
    color: colors.ink,
  },
  mutedText: {
    fontSize: 12.5,
    color: colors.muted,
    marginTop: 2,
  },
  quotaTop: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
  },
  quotaUsed: {
    fontSize: 22,
    fontWeight: '800',
    color: colors.ink,
  },
  quotaSub: {
    fontSize: 13,
    color: colors.muted,
    marginTop: 2,
  },
  trashBannerCard: {
    gap: spacing.md,
  },
  trashRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  trashIcon: {
    width: 40,
    height: 40,
    borderRadius: radius.md,
    backgroundColor: colors.warningTint,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stackBar: {
    flexDirection: 'row',
    height: 12,
    borderRadius: 6,
    overflow: 'hidden',
    backgroundColor: colors.surfaceSubtle,
    gap: 1,
  },
  legendList: {
    gap: spacing.xs + 2,
  },
  legendRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  legendDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  legendName: {
    fontSize: 13.5,
    fontWeight: '600',
    color: colors.ink,
    textTransform: 'capitalize',
    width: 84,
  },
  legendMeta: {
    flex: 1,
    fontSize: 12.5,
    color: colors.muted,
  },
  legendBytes: {
    fontSize: 13,
    fontWeight: '700',
    color: colors.ink,
  },
  userRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.sm,
  },
  rowDivider: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line,
  },
  userTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  userEmail: {
    fontSize: 14,
    fontWeight: '700',
    color: colors.ink,
    flexShrink: 1,
  },
  quotaEditBtn: {
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    borderRadius: radius.pill,
    backgroundColor: colors.accentTint,
  },
  quotaEditText: {
    fontSize: 12.5,
    fontWeight: '700',
    color: colors.accentDark,
  },
  fileRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.sm,
  },
  fileName: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.ink,
  },
  fileIconBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: colors.surfaceSubtle,
    alignItems: 'center',
    justifyContent: 'center',
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(15, 25, 34, 0.45)',
    justifyContent: 'center',
    paddingHorizontal: spacing.xl,
  },
  modalCard: {
    backgroundColor: colors.surface,
    borderRadius: radius.xl,
    padding: spacing.xl,
    gap: spacing.md,
  },
  modalTitle: {
    fontSize: 17,
    fontWeight: '800',
    color: colors.ink,
  },
  presetRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs + 2,
  },
  presetPill: {
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceSubtle,
    borderWidth: 1,
    borderColor: colors.line,
  },
  presetPillActive: {
    backgroundColor: colors.accentTint,
    borderColor: colors.accent,
  },
  presetText: {
    fontSize: 12.5,
    fontWeight: '600',
    color: colors.inkSoft,
  },
  presetTextActive: {
    color: colors.accentDark,
    fontWeight: '700',
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.lineStrong,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    height: 46,
    gap: spacing.sm,
  },
  gbInput: {
    flex: 1,
    fontSize: 16,
    fontWeight: '700',
    color: colors.ink,
  },
  gbUnit: {
    fontSize: 14,
    fontWeight: '700',
    color: colors.muted,
  },
  modalActions: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
});
